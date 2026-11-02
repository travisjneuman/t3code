/**
 * OpenBot usage for the Usage page. OpenBot records each turn's tokens and its
 * own list-price estimate per model in openbot.db; a refresh reads only rows
 * added since the last one, in one batched query.
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

import type { OpenBotSettings } from "../settings.ts";
import { describeLocation, query, type OpenBotLocation } from "./host.ts";

const PAGE_ROWS = 20_000;
const MAX_PAGES = 10;
const REFRESH_TTL_MS = 60_000;
const UNREADABLE = "OpenBot's usage could not be read.";
const NO_USAGE_TABLE = "This OpenBot version does not record token usage.";

interface SourceCache {
  readonly records: Map<string, UsageRecord>;
  /** Highest rowid read; Infinity depth means no read has succeeded yet. */
  afterRowId: number;
  depthMs: number;
  checkedAtMs: number;
  error: string | null;
}

const caches = new Map<string, SourceCache>();
const refreshes = new Map<string, Deferred.Deferred<void>>();

const str = (value: unknown) => (typeof value === "string" ? value : "");

const recordOf = (row: Record<string, unknown>): UsageRecord | null => {
  const agentId = str(row.agent_id);
  const recordId = str(row.record_id);
  const timestampMs = Date.parse(str(row.occurred_at));
  if (!agentId || !recordId || !Number.isFinite(timestampMs)) return null;
  const totals = {
    uncachedInputTokens: tokenCount(row.uncached),
    cachedInputTokens: tokenCount(row.cached),
    cacheCreationTokens: tokenCount(row.cache_creation),
    outputTokens: tokenCount(row.output),
    reasoningTokens: 0,
  };
  const cost = row.cost;
  // Zero or missing means OpenBot had no rate for the model; let shared pricing estimate.
  const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return null;
  return {
    provider: "openbot",
    timestampMs,
    model: str(row.model).trim() || "unknown",
    sessionId: str(row.session_id),
    totals,
    reportedCostUsd,
    speed: "standard",
    dedupeKey: `openbot:${agentId}:${recordId}`,
  };
};

const readRecords = Effect.fn("openBotUsageReader.readRecords")(function* (
  location: OpenBotLocation,
  cache: SourceCache,
  retentionCutoffMs: number,
) {
  // A wider window than the cache covers re-reads from the start.
  if (cache.depthMs > retentionCutoffMs) cache.afterRowId = 0;
  const since = new Date(retentionCutoffMs).toISOString();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const [head = [], rows = []] = yield* query(location, [
      { sql: "SELECT MAX(rowid) AS last_row_id FROM agent_usage_records" },
      {
        sql: `SELECT rowid AS row_id, agent_id, record_id, session_id, model, occurred_at,
                json_extract(tokens_json, '$.uncachedInput') AS uncached,
                json_extract(tokens_json, '$.cachedInput') AS cached,
                json_extract(tokens_json, '$.cacheCreation') AS cache_creation,
                json_extract(tokens_json, '$.output') AS output,
                estimated_cost_usd AS cost
           FROM agent_usage_records
          WHERE rowid > ? AND occurred_at >= ?
          ORDER BY rowid
          LIMIT ?`,
        params: [cache.afterRowId, since, PAGE_ROWS],
      },
    ]);
    const lastRowId = Number(head[0]?.last_row_id ?? 0);
    if (lastRowId < cache.afterRowId) {
      // A replaced database starts its rowids over.
      cache.records.clear();
      cache.afterRowId = 0;
      continue;
    }
    for (const row of rows) {
      cache.afterRowId = Math.max(cache.afterRowId, Number(row.row_id ?? 0));
      const record = recordOf(row);
      if (record !== null && record.dedupeKey !== null) cache.records.set(record.dedupeKey, record);
    }
    if (rows.length < PAGE_ROWS) break;
  }
  for (const [key, record] of cache.records)
    if (record.timestampMs < retentionCutoffMs) cache.records.delete(key);
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

const scanSource = Effect.fn("openBotUsageReader.scanSource")(function* (
  key: string,
  location: OpenBotLocation,
  windowStartMs: number,
  retentionCutoffMs: number,
  awaitRefresh: boolean,
) {
  let cache = caches.get(key);
  if (cache === undefined) {
    cache = { records: new Map(), afterRowId: 0, depthMs: Infinity, checkedAtMs: 0, error: null };
    caches.set(key, cache);
  }
  const held = cache;
  const nowMs = yield* Clock.currentTimeMillis;
  let refreshing = false;
  if (
    nowMs - held.checkedAtMs >= REFRESH_TTL_MS ||
    (held.error === null && held.depthMs > retentionCutoffMs)
  ) {
    const refresh = readRecords(location, held, retentionCutoffMs).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          held.error = error.message.includes("no such table")
            ? NO_USAGE_TABLE
            : error.message || UNREADABLE;
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

  const dir = describeLocation(location);
  // Over SSH the database is on another machine; it has no local volume to identify it.
  const source = location.sshHost ? { dir, hostId: location.sshHost, volumeId: "" } : { dir };
  if (held.depthMs === Infinity) {
    return (
      refreshing
        ? { ...source, files: [], refreshing: true }
        : { ...source, files: null, message: held.error ?? UNREADABLE }
    ) satisfies ProviderUsageScan;
  }
  return {
    ...source,
    files: [
      {
        path: dir,
        records: [...held.records.values()].filter((record) => record.timestampMs >= windowStartMs),
      },
    ],
    ...(held.error === null || refreshing
      ? { status: "ok" }
      : { status: "partial", message: held.error }),
    ...(refreshing ? { refreshing: true } : {}),
  } satisfies ProviderUsageScan;
});

export const openBotUsageReader: ProviderUsageReader<OpenBotSettings, never> = {
  kind: "scan",
  provider: "openbot",
  scan: Effect.fn("openBotUsageReader.scan")(function* ({
    instances,
    settings,
    windowStartMs,
    retentionCutoffMs,
    awaitRefresh,
  }) {
    // Instances pointing at one OpenBot share its database; read each once.
    const locations = new Map<string, OpenBotLocation>();
    for (const { instanceId, config, configured } of instances) {
      const entry = settings.providerInstances[instanceId];
      if (!configured || entry === undefined || config === undefined) continue;
      const key = `${config.sshHost}\u0000${config.configDir}`;
      if (resolveProviderInstanceEnabled(entry) && !locations.has(key))
        locations.set(key, { sshHost: config.sshHost, configDir: config.configDir });
    }
    return yield* Effect.forEach(
      locations,
      ([key, location]) =>
        scanSource(key, location, windowStartMs, retentionCutoffMs, awaitRefresh),
      { concurrency: "unbounded" },
    );
  }),
};
