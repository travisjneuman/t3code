/**
 * The details card's insights for Pi sessions, summed over the session file
 * with an incremental forward scan, and the context windows Pi's model
 * catalog lists. Fork add-on: session details.
 *
 * @module external-sessions/piInsights
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { tokenCount, totalTokens } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import {
  addModelUsage,
  type ForwardScans,
  label,
  modelUsageList,
  scanForward,
  sessionRecord,
} from "./codexInsights.ts";
import {
  asCount,
  asRecord,
  asString,
  contentText,
  type ExternalSessionModelUsage,
  parseJsonObject,
  readText,
  type ReadSessionInsights,
  statMtimeMs,
  timestampMs,
} from "./ExternalSessionSource.ts";

// ---------------------------------------------------------------------------
// Context windows.

const MODELS_STORE = NodePath.join(NodeOS.homedir(), ".pi", "agent", "models-store.json");
let windows: { readonly mtimeMs: number; readonly byModel: Map<string, number> } | null = null;

const modelKey = (provider: string, model: string) => `${provider}\u0000${model}`;

/**
 * `models-store.json` is `{ <provider>: { models: [...] } }`. Only each
 * model's id and context window are kept; the catalog also holds request
 * headers, which are never read.
 */
const parseWindows = (store: Record<string, unknown> | null): Map<string, number> => {
  const byModel = new Map<string, number>();
  for (const [provider, entry] of Object.entries(store ?? {})) {
    const models = asRecord(entry)?.models;
    for (const model of Array.isArray(models) ? models : []) {
      const record = asRecord(model);
      const id = asString(record?.id);
      const window = asCount(record?.contextWindow);
      if (id !== null && window !== null && window > 0) {
        byModel.set(modelKey(provider, id), Math.round(window));
      }
    }
  }
  return byModel;
};

/** The context window Pi's catalog lists for a provider's model, or null. */
export const piContextWindow = (
  provider: string | null,
  model: string | null,
): Effect.Effect<number | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (provider === null || model === null) return null;
    const mtimeMs = yield* statMtimeMs(MODELS_STORE);
    if (mtimeMs === null) return null;
    if (windows?.mtimeMs !== mtimeMs) {
      const text = yield* readText(MODELS_STORE);
      if (text === null) return null;
      windows = { mtimeMs, byModel: parseWindows(parseJsonObject(text)) };
    }
    return windows.byModel.get(modelKey(provider, model)) ?? null;
  });

// ---------------------------------------------------------------------------
// Session files.

interface PiCounts {
  readonly buckets: Map<string, ExternalSessionModelUsage>;
  costUsd: number;
  /** A call used tokens without a positive cost, so Pi's sum is not the whole. */
  unpricedCall: boolean;
  usageRecords: number;
  model: string | null;
  effort: string | null;
  turns: number;
  messages: number;
  apiCalls: number;
  toolCalls: number;
  toolFailures: number;
  durationMs: number;
  turnStartMs: number | null;
  lastAtMs: number;
}

const initialCounts = (): PiCounts => ({
  buckets: new Map(),
  costUsd: 0,
  unpricedCall: false,
  usageRecords: 0,
  model: null,
  effort: null,
  turns: 0,
  messages: 0,
  apiCalls: 0,
  toolCalls: 0,
  toolFailures: 0,
  durationMs: 0,
  turnStartMs: null,
  lastAtMs: 0,
});

// Records whose tokens count, the way Pi's own usage reader counts them.
const USAGE_ENTRY = new Set(["usage", "compaction", "branch_summary"]);
// Tool and summary calls Pi records without a model.
const UNATTRIBUTED = "Tools/summaries";

const addUsage = (counts: PiCounts, usage: Record<string, unknown> | null, model: string) => {
  if (usage === null) return;
  const output = tokenCount(usage.output);
  const totals = {
    // Pi's input and cache counters are already disjoint.
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens: output,
    reasoningTokens: Math.min(output, tokenCount(usage.reasoning)),
  };
  const cost = asRecord(usage.cost)?.total;
  const reported = typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reported === null) return;
  counts.usageRecords += 1;
  addModelUsage(counts.buckets, model, "standard", totals);
  // Pi prices calls at zero when its catalog has no rate.
  if (reported === null) counts.unpricedCall = true;
  else counts.costUsd += reported;
};

const visitLine = (counts: PiCounts, line: string) => {
  const record = parseJsonObject(line);
  if (record === null) return;
  const atMs = timestampMs(record.timestamp, Number.NaN);
  const timed = Number.isFinite(atMs);
  if (record.type === "thinking_level_change") {
    counts.effort = asString(record.thinkingLevel) ?? counts.effort;
  } else if (record.type === "model_change") {
    counts.model = asString(record.modelId) ?? counts.model;
  } else if (USAGE_ENTRY.has(asString(record.type) ?? "")) {
    addUsage(counts, asRecord(record.usage), asString(record.model) ?? UNATTRIBUTED);
  } else if (record.type === "message") {
    const message = asRecord(record.message);
    if (message?.role === "user") {
      // A turn runs from a prompt to the last record before the next one.
      if (counts.turnStartMs !== null) {
        counts.durationMs += Math.max(0, counts.lastAtMs - counts.turnStartMs);
      }
      counts.turnStartMs = timed ? atMs : null;
      counts.turns += 1;
      if (contentText(message.content, ["text"]).trim() !== "") counts.messages += 1;
    } else if (message?.role === "assistant") {
      counts.messages += 1;
      counts.model = asString(message.model) ?? counts.model;
      counts.effort = asString(message.thinkingLevel) ?? counts.effort;
      const usage = asRecord(message.usage);
      if (usage !== null) counts.apiCalls += 1;
      const model = asString(message.responseModel) ?? asString(message.model);
      addUsage(counts, usage, model ?? UNATTRIBUTED);
    } else if (message?.role === "toolResult") {
      counts.toolCalls += 1;
      if (message.isError === true) counts.toolFailures += 1;
      addUsage(counts, asRecord(message.usage), UNATTRIBUTED);
    }
  }
  if (timed) counts.lastAtMs = Math.max(counts.lastAtMs, atMs);
};

const piRecord = (counts: PiCounts) => {
  const totals = [...counts.buckets.values()].map((bucket) => bucket.totals);
  const sum = (pick: (t: (typeof totals)[number]) => number) =>
    counts.usageRecords === 0 ? null : totals.reduce((total, t) => total + pick(t), 0);
  const costUsd = counts.usageRecords > 0 && !counts.unpricedCall ? counts.costUsd : null;
  const openTurnMs =
    counts.turnStartMs === null ? 0 : Math.max(0, counts.lastAtMs - counts.turnStartMs);
  return sessionRecord({
    model: label(counts.model),
    effort: label(counts.effort),
    turnCount: counts.turns > 0 ? counts.turns : null,
    messageCount: counts.messages > 0 ? counts.messages : null,
    apiCallCount: counts.apiCalls > 0 ? counts.apiCalls : null,
    toolCallCount: counts.toolCalls > 0 ? counts.toolCalls : null,
    toolFailureCount: counts.toolCalls > 0 ? counts.toolFailures : null,
    durationMs: counts.turns > 0 ? Math.round(counts.durationMs + openTurnMs) : null,
    inputTokens: sum((t) => t.uncachedInputTokens),
    cacheReadTokens: sum((t) => t.cachedInputTokens),
    cacheWriteTokens: sum((t) => t.cacheCreationTokens),
    outputTokens: sum((t) => t.outputTokens),
    reasoningTokens: sum((t) => t.reasoningTokens),
    // Pi's own per-call cost; when a call lacks one, ExternalSessions prices
    // the per-model totals instead.
    costUsd,
    costEstimated: costUsd === null ? null : false,
  });
};

/**
 * Pi's insights: the record summed over the session file (tokens, Pi's cost,
 * turns, messages, tool calls and failures, turn time) and per-model totals
 * to price when Pi's cost is incomplete. Pi records no context breakdown or
 * MCP servers.
 */
export const makePiInsights = (): ReadSessionInsights => {
  const scans: ForwardScans<PiCounts> = new Map();
  return (_summary, transcriptPath) =>
    Effect.gen(function* () {
      if (transcriptPath === null) return {};
      const counts = yield* scanForward(scans, transcriptPath, initialCounts, visitLine);
      if (counts === null) return {};
      return {
        session: piRecord(counts),
        // Pi's tool and summary calls name no model, so they cannot be priced.
        modelUsage: modelUsageList(counts.buckets).filter(
          (bucket) => bucket.model !== UNATTRIBUTED,
        ),
      };
    }).pipe(Effect.catchCause(() => Effect.succeed({})));
};
