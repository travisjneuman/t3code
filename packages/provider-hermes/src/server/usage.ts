/**
 * Hermes Agent usage for the Usage page. Hermes keeps cumulative token and cost
 * counters per session and lists sessions most recently active first, so a
 * refresh pages only until it reaches sessions the cache already holds.
 */
import { resolveProviderInstanceEnabled } from "@t3tools/contracts";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { HermesSettings } from "../settings.ts";
import { apiRequest, connectionOf, type HermesConnection } from "./api.ts";

const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const REFRESH_TTL_MS = 60_000;
// Offset paging can miss a session that moved to the top mid-read; the next refresh re-reads this margin.
const RESYNC_MARGIN_MS = 10 * 60_000;
const UNREACHABLE = "Hermes did not return its sessions.";

interface SourceCache {
  readonly records: Map<string, UsageRecord>;
  /** Newest session activity seen; Infinity depth means no read has succeeded yet. */
  newestMs: number;
  depthMs: number;
  checkedAtMs: number;
  error: string | null;
}

const caches = new Map<string, SourceCache>();
const refreshes = new Map<string, Deferred.Deferred<void>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
/** Hermes stores times as epoch seconds; older rows may hold milliseconds. */
const timeMs = (value: unknown) => {
  const number = positive(value);
  if (number !== undefined) return number < 1e12 ? number * 1000 : number;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const activityMs = (row: Record<string, unknown>) =>
  timeMs(row.last_active) ?? timeMs(row.started_at);

const sourceOf = (apiUrl: string) => {
  try {
    const url = new URL(apiUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return {
      key: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
      // A loopback Hermes is a different one on each environment, so it keeps the local host id.
      hostId: loopback ? undefined : url.hostname,
    };
  } catch {
    return { key: apiUrl, hostId: undefined };
  }
};

const recordOf = (row: Record<string, unknown>, source: string): UsageRecord | null => {
  const id = typeof row.id === "string" ? row.id : "";
  const timestampMs = activityMs(row);
  if (!id || timestampMs === undefined) return null;
  const outputTokens = tokenCount(row.output_tokens);
  const totals = {
    uncachedInputTokens: tokenCount(row.input_tokens),
    cachedInputTokens: tokenCount(row.cache_read_tokens),
    cacheCreationTokens: tokenCount(row.cache_write_tokens),
    outputTokens,
    reasoningTokens: Math.min(tokenCount(row.reasoning_tokens), outputTokens),
  };
  // Zero means Hermes had no price, as with a subscription; let shared pricing estimate.
  const reportedCostUsd =
    positive(row.actual_cost_usd) ?? positive(row.estimated_cost_usd) ?? null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return null;
  return {
    provider: "hermes",
    timestampMs,
    model: (typeof row.model === "string" && row.model.trim()) || "unknown",
    sessionId: id,
    totals,
    reportedCostUsd,
    speed: "standard",
    dedupeKey: `hermes:${source}:${id}`,
  };
};

const readSessions = Effect.fn("hermesUsageReader.readSessions")(function* (
  source: string,
  connection: HermesConnection,
  cache: SourceCache,
  retentionCutoffMs: number,
) {
  const stopMs =
    cache.depthMs > retentionCutoffMs
      ? retentionCutoffMs
      : Math.max(retentionCutoffMs, cache.newestMs - RESYNC_MARGIN_MS);
  let newestMs = cache.newestMs;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const reply = yield* apiRequest(
      connection,
      "GET",
      `/api/sessions?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&include_children=true`,
    );
    const rows = isRecord(reply) && Array.isArray(reply.data) ? reply.data.filter(isRecord) : [];
    let reachedNew = false;
    for (const row of rows) {
      const activeMs = activityMs(row) ?? 0;
      newestMs = Math.max(newestMs, activeMs);
      // Pinned sessions are appended to every page whatever their age.
      if (row.pinned !== true && activeMs >= stopMs) reachedNew = true;
      const record = recordOf(row, source);
      if (record !== null && record.timestampMs >= retentionCutoffMs)
        cache.records.set(record.sessionId, record);
    }
    if (!reachedNew || !isRecord(reply) || reply.has_more !== true) break;
  }
  for (const [id, record] of cache.records)
    if (record.timestampMs < retentionCutoffMs) cache.records.delete(id);
  cache.newestMs = newestMs;
  cache.depthMs = Math.min(cache.depthMs, retentionCutoffMs);
  cache.error = null;
});

const startRefresh = (key: string, refresh: Effect.Effect<void>) =>
  // Enroll and fork atomically so interruption cannot strand a registered refresh.
  Effect.uninterruptible(
    Effect.gen(function* () {
      const current = refreshes.get(key);
      if (current !== undefined) return current;
      const done = Deferred.makeUnsafe<void>();
      refreshes.set(key, done);
      // Detached: a departing client must not cancel a read later scans reuse.
      yield* refresh.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            refreshes.delete(key);
            return Deferred.succeed(done, undefined);
          }),
        ),
        Effect.forkDetach,
      );
      return done;
    }),
  );

const scanSource = Effect.fn("hermesUsageReader.scanSource")(function* (
  connection: HermesConnection,
  windowStartMs: number,
  retentionCutoffMs: number,
  awaitRefresh: boolean,
) {
  const { key, hostId } = sourceOf(connection.apiUrl);
  let cache = caches.get(key);
  if (cache === undefined) {
    cache = { records: new Map(), newestMs: 0, depthMs: Infinity, checkedAtMs: 0, error: null };
    caches.set(key, cache);
  }
  const held = cache;
  const nowMs = yield* Clock.currentTimeMillis;
  let refreshing = false;
  if (
    nowMs - held.checkedAtMs >= REFRESH_TTL_MS ||
    (held.error === null && held.depthMs > retentionCutoffMs)
  ) {
    const refresh = readSessions(key, connection, held, retentionCutoffMs).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          held.error = error.message || UNREACHABLE;
        }),
      ),
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.map((atMs) => {
            held.checkedAtMs = atMs;
          }),
        ),
      ),
    );
    const done = yield* startRefresh(key, refresh);
    if (awaitRefresh) yield* Deferred.await(done);
    else refreshing = true;
  }

  const source = { dir: key, volumeId: key, ...(hostId === undefined ? {} : { hostId }) };
  if (held.depthMs === Infinity) {
    return (
      refreshing
        ? { ...source, files: [], refreshing: true }
        : { ...source, files: null, message: held.error ?? UNREACHABLE }
    ) satisfies ProviderUsageScan;
  }
  return {
    ...source,
    files: [
      {
        path: key,
        records: [...held.records.values()].filter((record) => record.timestampMs >= windowStartMs),
      },
    ],
    ...(held.error === null || refreshing
      ? { status: "ok" }
      : { status: "partial", message: held.error }),
    ...(refreshing ? { refreshing: true } : {}),
  } satisfies ProviderUsageScan;
});

export const hermesUsageReader: ProviderUsageReader<HermesSettings, never> = {
  kind: "scan",
  provider: "hermes",
  scan: Effect.fn("hermesUsageReader.scan")(function* ({
    instances,
    settings,
    windowStartMs,
    retentionCutoffMs,
    awaitRefresh,
  }) {
    // Instances sharing one Hermes share its sessions; read each Hermes once.
    const connections = new Map<string, HermesConnection>();
    for (const { instanceId, config, configured } of instances) {
      const entry = settings.providerInstances[instanceId];
      if (!configured || entry === undefined || config === undefined || !config.apiUrl) continue;
      const { key } = sourceOf(config.apiUrl);
      if (resolveProviderInstanceEnabled(entry) && !connections.has(key))
        connections.set(key, connectionOf(config));
    }
    return yield* Effect.forEach(
      connections.values(),
      (connection) => scanSource(connection, windowStartMs, retentionCutoffMs, awaitRefresh),
      { concurrency: "unbounded" },
    );
  }),
};
