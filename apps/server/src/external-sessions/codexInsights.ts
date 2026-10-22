/**
 * The details card's insights for Codex sessions, read from the rollout with
 * an incremental forward scan, plus the helpers the other non-Claude sources
 * share: the forward scan, per-model token totals, and the record builder.
 * Fork add-on: session details.
 *
 * @module external-sessions/codexInsights
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  SessionMcpServer,
  SessionRateLimit,
  SessionRecord,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { tokenCount, totalTokens, type UsageSpeed } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { initialCodexScanState, parseCodexLine } from "../provider/Drivers/codexUsage.ts";
import {
  asCount,
  asRecord,
  asString,
  contentText,
  type ExternalSessionModelUsage,
  parseJsonObject,
  readLines,
  readText,
  type ReadSessionInsights,
  statMtimeMs,
  timestampMs,
} from "./ExternalSessionSource.ts";

// ---------------------------------------------------------------------------
// Shared by the Codex, Grok, Pi and Antigravity sources.

/** A record without the fields the store did not record. */
export const sessionRecord = (fields: {
  readonly [K in keyof SessionRecord]?: SessionRecord[K] | null;
}): SessionRecord => {
  const record: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    record[name] = value;
  }
  return record as SessionRecord;
};

/** A trimmed, non-empty string, as the record's labels require. */
export const label = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
};

/** A count the record can carry: a finite, non-negative whole number. */
export const wholeCount = (value: unknown): number | null => {
  const count = asCount(value);
  return count === null ? null : Math.round(count);
};

/** A scan's place in an append-only file, so the next call reads only what was appended. */
interface ForwardScan<S> {
  /** Byte offset read up to; a line start unless `skipping`. */
  end: number;
  /** `end` sits inside a line longer than a chunk, whose rest is not a line. */
  skipping: boolean;
  readonly state: S;
}

export type ForwardScans<S> = Map<string, ForwardScan<S>>;

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SCANS = 200;

/**
 * Feeds every complete line of `path` to `visit` once, across calls: each call
 * continues from where the last stopped. A file that shrank was rewritten and
 * is scanned again from the start. Progress is kept per chunk, so an
 * interrupted call loses nothing. Null when the file cannot be read.
 */
export const scanForward = <S>(
  scans: ForwardScans<S>,
  path: string,
  initial: () => S,
  visit: (state: S, line: string) => void,
): Effect.Effect<S | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    for (;;) {
      const known = scans.get(path);
      const from = known?.end ?? 0;
      const slice = yield* readLines(path, { from, maxBytes: SCAN_CHUNK_BYTES });
      if (slice === null) return scans.get(path)?.state ?? null;
      let scan = scans.get(path);
      // Another call read this chunk meanwhile; continue from where it stopped.
      if (scan !== known || (scan?.end ?? 0) !== from) continue;
      if (scan !== undefined && slice.size < from) {
        scans.delete(path);
        continue;
      }
      if (scan === undefined) {
        if (scans.size >= MAX_SCANS) scans.clear();
        scan = { end: 0, skipping: false, state: initial() };
        scans.set(path, scan);
      }
      if (slice.lines.length === 0) {
        // Only a partial last line is left, or a line runs past the whole chunk.
        if (slice.size - from <= SCAN_CHUNK_BYTES) return scan.state;
        // One byte short of the chunk, so the next read starts inside the long
        // line and its first piece is always the rest of it, never a real line.
        scan.end = from + SCAN_CHUNK_BYTES - 1;
        scan.skipping = true;
        continue;
      }
      // No yield between visiting and advancing, so no line is visited twice.
      for (const line of scan.skipping ? slice.lines.slice(1) : slice.lines) {
        visit(scan.state, line);
      }
      scan.end = slice.end;
      scan.skipping = false;
      if (slice.end >= slice.size) return scan.state;
    }
  });

export type JsonFiles<T> = Map<string, { readonly mtimeMs: number; readonly value: T }>;

/**
 * What `pick` keeps of a small JSON object file (null when it is missing or
 * not an object), parsed again only when the file's mtime changes.
 */
export const readJsonFile = <T>(
  cache: JsonFiles<T>,
  path: string,
  pick: (file: Record<string, unknown> | null) => T,
): Effect.Effect<T, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const mtimeMs = yield* statMtimeMs(path);
    if (mtimeMs === null) return pick(null);
    const known = cache.get(path);
    if (known?.mtimeMs === mtimeMs) return known.value;
    const value = pick(parseJsonObject((yield* readText(path)) ?? ""));
    if (cache.size >= MAX_SCANS) cache.clear();
    cache.set(path, { mtimeMs, value });
    return value;
  });

/** Adds one call's tokens to its model and speed's running totals. */
export const addModelUsage = (
  into: Map<string, ExternalSessionModelUsage>,
  model: string,
  speed: UsageSpeed,
  totals: UsageTokenTotals,
) => {
  const key = `${model}\u0000${speed}`;
  const bucket = into.get(key);
  into.set(key, {
    model,
    speed,
    totals: bucket === undefined ? totals : addTotals(bucket.totals, totals),
  });
};

/** The per-model totals ExternalSessions prices, without models that used nothing. */
export const modelUsageList = (
  buckets: Map<string, ExternalSessionModelUsage>,
): ReadonlyArray<ExternalSessionModelUsage> =>
  [...buckets.values()].filter((bucket) => totalTokens(bucket.totals) > 0);

export const addTotals = (into: UsageTokenTotals, add: UsageTokenTotals): UsageTokenTotals => ({
  uncachedInputTokens: into.uncachedInputTokens + add.uncachedInputTokens,
  cachedInputTokens: into.cachedInputTokens + add.cachedInputTokens,
  cacheCreationTokens: into.cacheCreationTokens + add.cacheCreationTokens,
  outputTokens: into.outputTokens + add.outputTokens,
  reasoningTokens: into.reasoningTokens + add.reasoningTokens,
});

// ---------------------------------------------------------------------------
// Codex rollouts.

// Context Codex injects as user messages. Codex Desktop also sends page opens,
// plugin suggestions and answers to its own question cards this way.
export const INJECTED_USER_TEXT =
  /^\s*(<environment_context>|<user_instructions>|<turn_aborted>|<recommended_plugins>|<external_codex_apps_open_page>|<send_user_message_question_reply>|# AGENTS\.md instructions)/;

/** Per-turn settings from `turn_context`; each read keeps the latest. */
export interface TurnSettings {
  model: string | null;
  effort: string | null;
  approval: string | null;
  sandbox: string | null;
}

export const readTurnContext = (payload: Record<string, unknown> | null, into: TurnSettings) => {
  into.model = asString(payload?.model) ?? into.model;
  into.effort = asString(payload?.effort) ?? into.effort;
  into.approval = asString(payload?.approval_policy) ?? into.approval;
  into.sandbox = asString(asRecord(payload?.sandbox_policy)?.type) ?? into.sandbox;
};

// Records that name their type near the line's start, ahead of any payload.
const LINE_HEAD = 200;
const EVENT_RECORD =
  /"type":"(?:session_meta|turn_context|token_count|thread_settings_applied|task_started|task_complete|turn_aborted)"/;
const RESPONSE_ITEM = /"type":"response_item"/;
const TOOL_CALL_ITEM = /"type":"(?:function_call|custom_tool_call|local_shell_call)"/;
const MESSAGE_ITEM = /"type":"message"/;

/** Everything a rollout says about its session, summed over the whole file. */
interface CodexCounts {
  readonly usage: ReturnType<typeof initialCodexScanState>;
  /** Token deltas by model and speed, for pricing. */
  readonly buckets: Map<string, ExternalSessionModelUsage>;
  readonly turn: TurnSettings;
  /** The latest `total_token_usage`. */
  totals: Record<string, unknown> | null;
  rateLimits: Record<string, unknown> | null;
  rateLimitsAtMs: number;
  serviceTier: string | null;
  turns: number;
  messages: number;
  toolCalls: number;
  apiCalls: number;
  durationMs: number;
  turnStartMs: number | null;
  lastAtMs: number;
}

const initialCounts = (): CodexCounts => ({
  usage: initialCodexScanState(),
  buckets: new Map(),
  turn: { model: null, effort: null, approval: null, sandbox: null },
  totals: null,
  rateLimits: null,
  rateLimitsAtMs: 0,
  serviceTier: null,
  turns: 0,
  messages: 0,
  toolCalls: 0,
  apiCalls: 0,
  durationMs: 0,
  turnStartMs: null,
  lastAtMs: 0,
});

/** Codex's `service_tier` as the speed it bills at; absent bills as standard. */
const serviceTierName = (tier: unknown): string =>
  tier === "priority" || tier === "fast" ? "fast" : tier === "ultrafast" ? "ultrafast" : "standard";

const visitEvent = (counts: CodexCounts, line: string) => {
  const usage = parseCodexLine(line, counts.usage);
  if (usage !== null) {
    counts.apiCalls += 1;
    addModelUsage(counts.buckets, usage.model, usage.speed, usage.totals);
  }
  // session_meta carries the base instructions and nothing the card needs.
  if (line.slice(0, LINE_HEAD).includes('"type":"session_meta"')) return;
  const record = parseJsonObject(line);
  const payload = asRecord(record?.payload);
  if (record === null || payload === null) return;
  const previousAtMs = counts.lastAtMs;
  const atMs = timestampMs(record.timestamp, counts.lastAtMs);
  counts.lastAtMs = Math.max(counts.lastAtMs, atMs);
  if (record.type === "turn_context") {
    readTurnContext(payload, counts.turn);
    return;
  }
  switch (payload.type) {
    case "token_count": {
      const info = asRecord(payload.info);
      counts.totals = asRecord(info?.total_token_usage) ?? counts.totals;
      const limits = asRecord(payload.rate_limits) ?? asRecord(info?.rate_limits);
      const limitId = asString(limits?.limit_id);
      // Model-specific limits (such as Spark) are not the plan's allowance.
      if (limits !== null && (limitId === null || limitId === "codex")) {
        counts.rateLimits = limits;
        counts.rateLimitsAtMs = atMs;
      }
      return;
    }
    case "thread_settings_applied":
      counts.serviceTier = serviceTierName(asRecord(payload.thread_settings)?.service_tier);
      return;
    case "task_started":
      // A turn left open (Codex quit mid-turn) ran until the record before this one.
      if (counts.turnStartMs !== null) {
        counts.durationMs += Math.max(0, previousAtMs - counts.turnStartMs);
      }
      counts.turns += 1;
      counts.turnStartMs = atMs;
      return;
    case "task_complete":
    case "turn_aborted":
      if (counts.turnStartMs !== null) {
        counts.durationMs += Math.max(0, atMs - counts.turnStartMs);
        counts.turnStartMs = null;
      }
      return;
  }
};

const visitResponseItem = (counts: CodexCounts, head: string, line: string) => {
  if (TOOL_CALL_ITEM.test(head)) {
    counts.toolCalls += 1;
    return;
  }
  if (!MESSAGE_ITEM.test(head)) return;
  const payload = asRecord(parseJsonObject(line)?.payload);
  if (payload?.type !== "message") return;
  // Counted the way the transcript parser lists them.
  if (payload.role === "user") {
    const text = contentText(payload.content, ["input_text"]).trim();
    if (text !== "" && !INJECTED_USER_TEXT.test(text)) counts.messages += 1;
  } else if (payload.role === "assistant") {
    if (contentText(payload.content, ["output_text"]).trim() !== "") counts.messages += 1;
  }
};

const visitRollout = (counts: CodexCounts, line: string) => {
  const head = line.slice(0, LINE_HEAD);
  if (EVENT_RECORD.test(head)) visitEvent(counts, line);
  else if (RESPONSE_ITEM.test(head)) visitResponseItem(counts, head, line);
};

const WEEK_MINUTES = 7 * 24 * 60;
const MONTH_MINUTES = 30 * 24 * 60;

const windowName = (minutes: number): string => {
  if (minutes === 300) return "5-hour";
  if (minutes >= MONTH_MINUTES) return "Monthly";
  if (minutes >= WEEK_MINUTES) return "Weekly";
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
};

/**
 * `primary` and `secondary` are positions. Without a stated window, paid plans
 * pair a 5-hour and a weekly limit and Free/Go have one monthly allowance, as
 * in `codexUsageLimits`.
 */
const rateLimits = (
  limits: Record<string, unknown> | null,
  atMs: number,
): ReadonlyArray<SessionRateLimit> => {
  if (limits === null) return [];
  const plan = asString(limits.plan_type);
  const monthly = plan === "free" || plan === "go";
  const out: Array<SessionRateLimit> = [];
  for (const [slot, fallbackMinutes] of [
    ["primary", monthly ? MONTH_MINUTES : 300],
    ["secondary", WEEK_MINUTES],
  ] as const) {
    const window = asRecord(limits[slot]);
    const usedPercent = window?.used_percent ?? window?.usedPercent;
    if (window === null || typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
      continue;
    }
    const stated = asCount(window.window_minutes ?? window.windowDurationMins);
    const minutes = stated !== null && stated > 0 ? stated : fallbackMinutes;
    const resetsAtSeconds = asCount(window.resets_at ?? window.resetsAt);
    const resetsInSeconds = asCount(window.resets_in_seconds);
    const resetsAtMs =
      resetsAtSeconds !== null
        ? timestampMs(resetsAtSeconds, 0)
        : resetsInSeconds !== null && atMs > 0
          ? atMs + resetsInSeconds * 1000
          : null;
    out.push({
      name: windowName(minutes),
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      ...(resetsAtMs !== null && resetsAtMs > 0
        ? { resetsAt: new Date(resetsAtMs).toISOString() }
        : {}),
    });
  }
  return out;
};

const codexRecord = (counts: CodexCounts, version: string | null) => {
  const totals = counts.totals;
  // Codex counts cached and cache-write input inside `input_tokens`, and
  // reasoning inside `output_tokens`, as `codexUsage` notes.
  const input = tokenCount(totals?.input_tokens);
  const cached = tokenCount(totals?.cached_input_tokens);
  const cacheWrite = wholeCount(totals?.cache_write_input_tokens);
  const output = tokenCount(totals?.output_tokens);
  const openTurnMs =
    counts.turnStartMs === null ? 0 : Math.max(0, counts.lastAtMs - counts.turnStartMs);
  return sessionRecord({
    model: label(counts.turn.model),
    version: label(version),
    effort: label(counts.turn.effort),
    permissionMode: label(counts.turn.approval),
    sandbox: label(counts.turn.sandbox),
    serviceTier: counts.serviceTier,
    turnCount: counts.turns > 0 ? counts.turns : null,
    messageCount: counts.messages > 0 ? counts.messages : null,
    toolCallCount: counts.toolCalls > 0 ? counts.toolCalls : null,
    apiCallCount: counts.apiCalls > 0 ? counts.apiCalls : null,
    durationMs: counts.turns > 0 ? Math.round(counts.durationMs + openTurnMs) : null,
    inputTokens: totals === null ? null : Math.max(0, input - cached - (cacheWrite ?? 0)),
    cacheReadTokens: totals === null ? null : cached,
    cacheWriteTokens: totals === null ? null : cacheWrite,
    outputTokens: totals === null ? null : output,
    reasoningTokens:
      totals === null ? null : Math.min(output, tokenCount(totals.reasoning_output_tokens)),
    rateLimits: rateLimits(counts.rateLimits, counts.rateLimitsAtMs),
  });
};

// `[mcp_servers.<name>]`, its name bare or quoted.
const MCP_TABLE = /^mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/;
// `<name> = { ... }` inside `[mcp_servers]`.
const MCP_INLINE = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*\{/;
const ENABLED_FALSE = /^\s*enabled\s*=\s*false\b/;
const INLINE_ENABLED_FALSE = /\benabled\s*=\s*false\b/;

/**
 * The MCP servers `config.toml` names, and whether each is enabled. Reads
 * table names and `enabled` flags only; commands, arguments, environment and
 * URLs are never kept.
 */
const parseMcpServers = (toml: string): ReadonlyArray<SessionMcpServer> => {
  const enabled = new Map<string, boolean>();
  let current: string | null = null;
  let inMcpTable = false;
  for (const line of toml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      const header = trimmed.startsWith("[[") ? null : /^\[([^\]]+)\]/.exec(trimmed)?.[1];
      const inner = header?.trim() ?? "";
      const match = MCP_TABLE.exec(inner);
      const name = label(match?.[1] ?? match?.[2] ?? match?.[3]);
      current = name;
      inMcpTable = inner === "mcp_servers";
      if (name !== null && !enabled.has(name)) enabled.set(name, true);
      continue;
    }
    if (current !== null && ENABLED_FALSE.test(line)) enabled.set(current, false);
    if (inMcpTable) {
      const match = MCP_INLINE.exec(line);
      const name = label(match?.[1] ?? match?.[2] ?? match?.[3]);
      if (name !== null) enabled.set(name, !INLINE_ENABLED_FALSE.test(line));
    }
  }
  return [...enabled].map(([name, on]): SessionMcpServer => ({
    name,
    status: on ? "configured" : "disabled",
  }));
};

const codexConfigPath = NodePath.join(NodeOS.homedir(), ".codex", "config.toml");
let mcpConfig: {
  readonly mtimeMs: number;
  readonly servers: ReadonlyArray<SessionMcpServer>;
} | null = null;

const readMcpServers = Effect.gen(function* () {
  const mtimeMs = yield* statMtimeMs(codexConfigPath);
  if (mtimeMs === null) return null;
  if (mcpConfig?.mtimeMs === mtimeMs) return mcpConfig.servers;
  const text = yield* readText(codexConfigPath);
  if (text === null) return null;
  mcpConfig = { mtimeMs, servers: parseMcpServers(text) };
  return mcpConfig.servers;
});

/**
 * Codex's insights: the record summed over the whole rollout (tokens, turns,
 * messages, tool calls, rate limits), per-model totals for ExternalSessions to
 * price (Codex records no cost), and the MCP servers its config names. Codex records no context categories, so context is null and
 * the card shows the totals from the session's details.
 */
export const makeCodexInsights = (): ReadSessionInsights => {
  const scans: ForwardScans<CodexCounts> = new Map();
  return (summary, transcriptPath) =>
    Effect.gen(function* () {
      const counts =
        transcriptPath === null
          ? null
          : yield* scanForward(scans, transcriptPath, initialCounts, visitRollout);
      const mcpServers = yield* readMcpServers;
      return {
        ...(counts === null
          ? {}
          : {
              session: codexRecord(counts, summary.details?.version ?? null),
              modelUsage: modelUsageList(counts.buckets),
            }),
        context: null,
        ...(mcpServers === null ? {} : { mcpServers }),
      };
    }).pipe(Effect.catchCause(() => Effect.succeed({})));
};
