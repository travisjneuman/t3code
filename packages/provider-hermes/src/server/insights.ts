/**
 * What the session details card shows for a Hermes thread, read over HTTP
 * from Hermes itself, so it answers whether or not a T3 provider session is
 * running: the session's own record, its context estimated from the stored
 * messages, the MCP servers the agent is configured with, and the files its
 * `write_file` and `patch` calls changed. Fork add-on; see
 * docs/internals/session-insights.md.
 *
 * @module provider-hermes/server/insights
 */
import type {
  SessionContextBreakdown,
  SessionContextCategory,
  SessionMcpServer,
  SessionRecord,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { HermesSettings } from "../settings.ts";
import {
  type HermesMessage,
  apiRequest,
  connectionOf,
  dashboardConnectionOf,
  dashboardRequest,
  listMessages,
} from "./api.ts";

/** One file the session's edit tools changed; `hasStats` is false when the call names no lines. */
export interface HermesSessionOutputFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hasStats: boolean;
}

export interface HermesSessionInsights {
  readonly session: SessionRecord | null;
  readonly context: SessionContextBreakdown | null;
  readonly mcpServers: ReadonlyArray<SessionMcpServer> | null;
  /** Null when the messages could not be read. */
  readonly outputs: ReadonlyArray<HermesSessionOutputFile> | null;
}

/** A session that has not ended but was quiet this long reads as idle, as Other Agents do. */
const IDLE_MS = 60 * 60 * 1000;

// Hermes's own rough count (agent/model_metadata.py): about four characters a token.
const CHARS_PER_TOKEN = 4;

const ESTIMATE_NOTE =
  "Estimated from the stored messages at about four characters a token. Hermes does not report its system prompt or tool definitions, so the real total is higher.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** Hermes stores times as epoch seconds; older rows may hold milliseconds. */
const timeMs = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
};

const isoTime = (value: unknown): string | undefined => {
  const ms = timeMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
};

/** An object, or a JSON object string such as a tool call's arguments. */
const parseObject = (value: unknown): Record<string, unknown> | null => {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Only the fields that are set, so the wire object stays small. */
const defined = <T extends object>(fields: { readonly [K in keyof T]: T[K] | undefined }): T =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

/** The reasoning effort the session was created with, from its stored `model_config`. */
const effortOf = (session: Record<string, unknown>): string | undefined => {
  const config = parseObject(session.model_config);
  const reasoning = isRecord(config?.reasoning_config) ? config.reasoning_config : undefined;
  return text(reasoning?.effort) ?? text(config?.reasoning_effort);
};

const decodeRecord = (session: Record<string, unknown>, nowMs: number): SessionRecord => {
  const actualCost = typeof session.actual_cost_usd === "number" ? session.actual_cost_usd : null;
  const estimatedCost =
    typeof session.estimated_cost_usd === "number" ? session.estimated_cost_usd : null;
  const endedAt = isoTime(session.ended_at);
  const lastActiveMs = timeMs(session.last_active) ?? timeMs(session.started_at);
  const status: SessionRecord["status"] =
    endedAt !== undefined
      ? "ended"
      : lastActiveMs !== undefined && nowMs - lastActiveMs > IDLE_MS
        ? "idle"
        : "active";
  return defined<SessionRecord>({
    source: text(session.source),
    model: text(session.model),
    effort: effortOf(session),
    status,
    endReason: text(session.end_reason),
    startedAt: isoTime(session.started_at),
    lastActiveAt: isoTime(session.last_active),
    endedAt,
    messageCount: count(session.message_count),
    toolCallCount: count(session.tool_call_count),
    apiCallCount: count(session.api_call_count),
    costUsd: actualCost ?? estimatedCost ?? undefined,
    costEstimated: actualCost === null && estimatedCost !== null ? true : undefined,
    inputTokens: count(session.input_tokens),
    outputTokens: count(session.output_tokens),
    cacheReadTokens: count(session.cache_read_tokens),
    cacheWriteTokens: count(session.cache_write_tokens),
    reasoningTokens: count(session.reasoning_tokens),
  });
};

/**
 * Turns are the stored user messages; each lasts from its user message to the
 * last message before the next one, so the sum is the time Hermes spent on them.
 */
const turnStats = (
  messages: ReadonlyArray<HermesMessage>,
): { readonly turnCount: number; readonly durationMs: number | undefined } => {
  let turnCount = 0;
  let durationMs = 0;
  let timed = false;
  let start: number | undefined;
  let last: number | undefined;
  const close = () => {
    if (start !== undefined && last !== undefined && last > start) durationMs += last - start;
  };
  for (const message of messages) {
    const at = timeMs(message.timestamp);
    if (message.role === "user") {
      close();
      turnCount += 1;
      start = at;
      last = at;
      if (at !== undefined) timed = true;
    } else if (at !== undefined && start !== undefined) {
      last = at;
    }
  }
  close();
  return { turnCount, durationMs: timed ? Math.round(durationMs) : undefined };
};

const tokensOf = (value: string): number => Math.ceil(value.length / CHARS_PER_TOKEN);

/**
 * The context the stored messages fill, by kind. Hermes starts a new session
 * when it compresses context, so a session's messages are what its next
 * request sends, less the system prompt and tool schemas it does not report.
 */
const estimateContext = (
  messages: ReadonlyArray<HermesMessage>,
  model: string | undefined,
  maxTokens: number,
): SessionContextBreakdown => {
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let reasoning = 0;
  for (const message of messages) {
    const tokens = tokensOf(message.content);
    if (message.role === "user") user += tokens;
    else if (message.role === "tool") toolResults += tokens;
    else if (message.role === "assistant") assistant += tokens;
    for (const call of message.toolCalls) toolCalls += tokensOf(`${call.name}${call.arguments}`);
    if (message.reasoning !== null) reasoning += tokensOf(message.reasoning);
  }
  const used: ReadonlyArray<readonly [string, number]> = [
    ["User messages", user],
    ["Assistant messages", assistant],
    ["Tool calls", toolCalls],
    ["Tool results", toolResults],
    ["Reasoning", reasoning],
  ];
  const totalTokens = used.reduce((sum, [, tokens]) => sum + tokens, 0);
  const categories: Array<SessionContextCategory> = used.map(([name, tokens]) => ({
    name,
    tokens,
    kind: "used",
  }));
  if (maxTokens > totalTokens) {
    categories.push({ name: "Free space", tokens: maxTokens - totalTokens, kind: "free" });
  }
  return {
    ...(model === undefined ? {} : { model }),
    totalTokens,
    maxTokens,
    categories,
    mcpTools: [],
    memoryFiles: [],
    agents: [],
    skills: [],
    estimated: true,
    note: ESTIMATE_NOTE,
  };
};

/** The window Hermes uses for its configured model, when the session runs that model. */
const dashboardContextLength = (body: unknown, model: string): number | undefined => {
  if (!isRecord(body) || text(body.model) !== model) return undefined;
  const length = count(body.effective_context_length);
  return length === undefined || length === 0 ? undefined : length;
};

// ── Outputs ───────────────────────────────────────────────────────────

/** More files than this is a refactor; the card lists the newest. */
const MAX_OUTPUT_FILES = 500;

/** One recorded change to one file; `null` counts when the call has none. */
interface FileChange {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

const lineCount = (value: string): number => {
  if (value === "") return 0;
  const lines = value.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
};

/**
 * Lines added and removed going from `before` to `after`, with the lines both
 * share at the start and end left out. Exact for one contiguous change, which
 * is what a single replacement records. Same as Other Agents' sessionOutputs.ts.
 */
const textChangeStats = (
  before: string,
  after: string,
): { readonly additions: number; readonly deletions: number } => {
  if (before === "") return { additions: lineCount(after), deletions: 0 };
  const left = before.split("\n");
  const right = after.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  return { additions: rightEnd - start, deletions: leftEnd - start };
};

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/;

/** The files a V4A patch (`*** Update File: …`) changes, counted from its +/- lines. */
const patchChanges = (patch: string): ReadonlyArray<FileChange> => {
  const out: Array<FileChange> = [];
  let current: { path: string; additions: number; deletions: number } | null = null;
  for (const line of patch.split("\n")) {
    const file = PATCH_FILE.exec(line);
    if (file !== null) {
      if (current !== null) out.push(current);
      current = { path: file[2]!.trim(), additions: 0, deletions: 0 };
      continue;
    }
    if (current === null) continue;
    const move = PATCH_MOVE.exec(line);
    if (move !== null) {
      current.path = move[1]!.trim();
      continue;
    }
    if (line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.additions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }
  if (current !== null) out.push(current);
  return out.filter((change) => change.path !== "");
};

/**
 * Hermes's file tools: `write_file {path, content}` replaces a whole file it
 * may never have read, so it names the file without counts; `patch` carries
 * either `old_string` and `new_string` for one path or a V4A `patch`.
 */
const callChanges = (name: string, args: Record<string, unknown>): ReadonlyArray<FileChange> => {
  const path = text(args.path);
  if (name === "write_file") {
    return path === undefined ? [] : [{ path, additions: null, deletions: null }];
  }
  if (args.mode === "patch" || (typeof args.patch === "string" && args.patch !== "")) {
    return typeof args.patch === "string" ? patchChanges(args.patch) : [];
  }
  if (path === undefined) return [];
  const before = typeof args.old_string === "string" ? args.old_string : undefined;
  const after = typeof args.new_string === "string" ? args.new_string : undefined;
  // `replace_all` changes every match, and the call does not say how many there were.
  if (before === undefined || after === undefined || args.replace_all === true) {
    return [{ path, additions: null, deletions: null }];
  }
  return [{ path, ...textChangeStats(before, after) }];
};

/** A tool result Hermes recorded as failed: `{"success": false}` or an `error`. */
const failedResult = (content: string): boolean => {
  const result = parseObject(content);
  return result !== null && (result.success === false || text(result.error) !== undefined);
};

/**
 * The files a session's `write_file` and `patch` calls changed, newest first,
 * with line counts summed across edits. Calls whose result reports a failure
 * are left out; edits made through `terminal` commands are not seen.
 */
export const readHermesSessionOutputs = (
  messages: ReadonlyArray<HermesMessage>,
): ReadonlyArray<HermesSessionOutputFile> => {
  const failedCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId !== null && failedResult(message.content)) {
      failedCalls.add(message.toolCallId);
    }
  }
  const changes: Array<FileChange> = [];
  for (const message of messages) {
    for (const call of message.toolCalls) {
      if (call.name !== "write_file" && call.name !== "patch") continue;
      if (failedCalls.has(call.id)) continue;
      const args = parseObject(call.arguments);
      if (args !== null) changes.push(...callChanges(call.name, args));
    }
  }
  const byPath = new Map<
    string,
    { path: string; additions: number; deletions: number; hasStats: boolean }
  >();
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index]!;
    let entry = byPath.get(change.path);
    if (entry === undefined) {
      if (byPath.size >= MAX_OUTPUT_FILES) continue;
      entry = { path: change.path, additions: 0, deletions: 0, hasStats: false };
      byPath.set(change.path, entry);
    }
    if (change.additions !== null && change.deletions !== null) {
      entry.additions += change.additions;
      entry.deletions += change.deletions;
      entry.hasStats = true;
    }
  }
  return [...byPath.values()];
};

/**
 * Servers from the agent's MCP configuration. Hermes reports what is
 * configured, not what connected, so an enabled server shows as configured.
 * Commands, URLs and environment values are never read past the name.
 */
const decodeMcpServers = (body: unknown): ReadonlyArray<SessionMcpServer> | null => {
  if (!isRecord(body) || !Array.isArray(body.servers)) return null;
  return body.servers.flatMap((entry): Array<SessionMcpServer> => {
    if (!isRecord(entry)) return [];
    const name = text(entry.name);
    if (name === undefined) return [];
    const toolCount = Array.isArray(entry.tools) ? entry.tools.length : undefined;
    return [
      {
        name,
        status: entry.enabled === false ? "disabled" : "configured",
        ...(toolCount === undefined || toolCount === 0 ? {} : { toolCount }),
      },
    ];
  });
};

/** Logs a failed read and leaves that part empty, so one outage never blanks the card. */
const optional = <A>(part: string, read: Effect.Effect<A, { readonly message: string }>) =>
  read.pipe(
    Effect.map((value): A | null => value),
    Effect.catch((error) =>
      Effect.logWarning("hermes.session-insights.read-failed", {
        part,
        detail: error.message,
      }).pipe(Effect.as(null)),
    ),
  );

/** Everything Hermes reports about one session; read-only GETs, nothing written. */
export const read = (options: {
  readonly settings: HermesSettings;
  readonly sessionId: string;
}): Effect.Effect<HermesSessionInsights> =>
  Effect.gen(function* () {
    const api = connectionOf(options.settings);
    const dashboard = dashboardConnectionOf(options.settings);
    const fromDashboard = (part: string, path: string) =>
      dashboard.dashboardUrl === ""
        ? Effect.succeed(null)
        : optional(part, dashboardRequest(dashboard, "GET", path));
    const path = `/api/sessions/${encodeURIComponent(options.sessionId)}`;
    const [sessionBody, messages, modelInfo, mcpBody, statusBody] = yield* Effect.all(
      [
        optional("session", apiRequest(api, "GET", path)),
        optional("messages", listMessages(api, options.sessionId)),
        fromDashboard("model", "/api/model/info"),
        fromDashboard("mcp", "/api/mcp/servers"),
        fromDashboard("status", "/api/status"),
      ],
      { concurrency: 5 },
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const stored =
      isRecord(sessionBody) && isRecord(sessionBody.session) ? sessionBody.session : null;
    const record = stored === null ? null : decodeRecord(stored, nowMs);
    const turns = messages === null ? undefined : turnStats(messages);
    // The running Hermes's version, so only for a session it is still writing.
    const version =
      record?.status === "ended" || !isRecord(statusBody) ? undefined : text(statusBody.version);
    const session =
      record === null
        ? null
        : defined<SessionRecord>({
            ...record,
            version,
            turnCount: turns?.turnCount,
            durationMs: turns?.durationMs,
          });
    const model = session?.model;
    // Hermes reports a window only for its configured model (`/api/model/info`);
    // `/api/model/options` carries no per-model window, so another model's stays unknown.
    const maxTokens = model === undefined ? undefined : dashboardContextLength(modelInfo, model);
    return {
      session,
      context: messages === null ? null : estimateContext(messages, model, maxTokens ?? 0),
      mcpServers: decodeMcpServers(mcpBody),
      outputs: messages === null ? null : readHermesSessionOutputs(messages),
    };
  });
