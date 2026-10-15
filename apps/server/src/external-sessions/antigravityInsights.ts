/**
 * The details card's insights for Antigravity conversations, and the model
 * each one ran on for the list. Both come from the usage the conversation
 * databases record, decoded by the Usage page's reader with its own cache.
 * Fork add-on: session details.
 *
 * @module external-sessions/antigravityInsights
 */
import * as NodePath from "node:path";

import * as PlatformPath from "@effect/platform-node/NodePath";
import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import {
  makeAntigravityUsageCache,
  readAntigravityUsage,
} from "../provider/Drivers/antigravityUsageReader.ts";
import {
  addModelUsage,
  addTotals,
  label,
  modelUsageList,
  sessionRecord,
  wholeCount,
} from "./codexInsights.ts";
import type { ExternalSessionModelUsage, ReadSessionInsights } from "./ExternalSessionSource.ts";

// The reader's name for usage whose model it could not decode.
const UNKNOWN_MODEL = "antigravity-unknown";

export interface AntigravityUsage {
  /** Decodes the conversation databases that changed since the last read. */
  readonly refresh: Effect.Effect<void, never, FileSystem.FileSystem>;
  /** Whether a read has looked at this conversation's database. */
  readonly attempted: (id: string) => boolean;
  /** The model the conversation last used, from the last read. */
  readonly model: (id: string) => string | null;
  readonly readInsights: ReadSessionInsights;
}

/** The latest decoded model; usage of an unknown model names none. */
const latestModel = (records: ReadonlyArray<UsageRecord>): string | null => {
  let latest: UsageRecord | null = null;
  for (const record of records) {
    if (record.model === UNKNOWN_MODEL) continue;
    if (latest === null || record.timestampMs >= latest.timestampMs) latest = record;
  }
  return latest === null ? null : label(latest.model);
};

const antigravityRecord = (records: ReadonlyArray<UsageRecord>, stepCount: number | null) => {
  const totals = records.reduce((sum, record) => addTotals(sum, record.totals), EMPTY_TOTALS);
  const used = records.length > 0;
  return sessionRecord({
    model: latestModel(records),
    stepCount,
    apiCallCount: used ? records.length : null,
    inputTokens: used ? totals.uncachedInputTokens : null,
    cacheReadTokens: used ? totals.cachedInputTokens : null,
    cacheWriteTokens: used ? totals.cacheCreationTokens : null,
    outputTokens: used ? totals.outputTokens : null,
    reasoningTokens: used ? totals.reasoningTokens : null,
  });
};

/**
 * Antigravity records no cost, so the card's cost is ExternalSessions'
 * list-price estimate from the per-model totals. Unknown-model usage counts
 * in the tokens but is left out of pricing.
 */
const pricedUsage = (records: ReadonlyArray<UsageRecord>) => {
  const buckets = new Map<string, ExternalSessionModelUsage>();
  for (const record of records) {
    if (record.model !== UNKNOWN_MODEL) {
      addModelUsage(buckets, record.model, record.speed, record.totals);
    }
  }
  return modelUsageList(buckets);
};

/** One shared decode of `conversationsDir`, for the source's list and its details card. */
export const makeAntigravityUsage = (conversationsDir: string): AntigravityUsage => {
  const cache = makeAntigravityUsageCache();
  let byId = new Map<string, Array<UsageRecord>>();
  const attempted = new Set<string>();

  const refresh = readAntigravityUsage(conversationsDir, 0, cache).pipe(
    Effect.provide(PlatformPath.layer),
    Effect.map(({ files, errors }) => {
      const next = new Map<string, Array<UsageRecord>>();
      for (const file of files) {
        attempted.add(NodePath.basename(file.path, ".db"));
        for (const record of file.records) {
          const list = next.get(record.sessionId);
          if (list === undefined) next.set(record.sessionId, [record]);
          else list.push(record);
        }
      }
      // An undecodable database is read again only when it changes, by the card.
      for (const path of errors) attempted.add(NodePath.basename(path, ".db"));
      byId = next;
    }),
    Effect.catchCause(() => Effect.void),
  );

  return {
    refresh,
    attempted: (id) => attempted.has(id),
    model: (id) => latestModel(byId.get(id) ?? []),
    readInsights: (summary) =>
      Effect.gen(function* () {
        const id = summary.details?.sessionId ?? summary.key.replace(/^antigravity:/, "");
        yield* refresh;
        const records = byId.get(id) ?? [];
        const session = antigravityRecord(records, wholeCount(summary.details?.stepCount));
        return {
          ...(Object.keys(session).length === 0 ? {} : { session }),
          ...(records.length === 0 ? {} : { modelUsage: pricedUsage(records) }),
          context: null,
          mcpServers: null,
        };
      }).pipe(Effect.catchCause(() => Effect.succeed({}))),
  };
};
