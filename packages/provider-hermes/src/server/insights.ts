/**
 * What the session details card shows for a Hermes thread, read over HTTP
 * from Hermes itself, so it answers whether or not a T3 provider session is
 * running: the session's own record, its context estimated from the stored
 * messages, and the MCP servers the agent is configured with. Fork add-on;
 * see docs/internals/session-insights.md.
 *
 * @module provider-hermes/server/insights
 */
import type {
  SessionContextBreakdown,
  SessionContextCategory,
  SessionMcpServer,
  SessionRecord,
} from "@t3tools/contracts";
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

export interface HermesSessionInsights {
  readonly session: SessionRecord | null;
  readonly context: SessionContextBreakdown | null;
  readonly mcpServers: ReadonlyArray<SessionMcpServer> | null;
}

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
const isoTime = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
};

/** Only the fields that are set, so the wire object stays small. */
const defined = <T extends object>(fields: { readonly [K in keyof T]: T[K] | undefined }): T =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

const decodeRecord = (body: unknown): SessionRecord | null => {
  const session = isRecord(body) && isRecord(body.session) ? body.session : null;
  if (session === null) return null;
  const actualCost = typeof session.actual_cost_usd === "number" ? session.actual_cost_usd : null;
  const estimatedCost =
    typeof session.estimated_cost_usd === "number" ? session.estimated_cost_usd : null;
  const endedAt = isoTime(session.ended_at);
  return defined<SessionRecord>({
    source: text(session.source),
    model: text(session.model),
    status: endedAt === undefined ? "active" : "ended",
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
const contextLength = (body: unknown, model: string | undefined): number => {
  if (!isRecord(body) || model === undefined || text(body.model) !== model) return 0;
  return count(body.effective_context_length) ?? 0;
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
    const path = `/api/sessions/${encodeURIComponent(options.sessionId)}`;
    const [sessionBody, messages, modelInfo, mcpBody] = yield* Effect.all(
      [
        optional("session", apiRequest(api, "GET", path)),
        optional("messages", listMessages(api, options.sessionId)),
        dashboard.dashboardUrl === ""
          ? Effect.succeed(null)
          : optional("model", dashboardRequest(dashboard, "GET", "/api/model/info")),
        dashboard.dashboardUrl === ""
          ? Effect.succeed(null)
          : optional("mcp", dashboardRequest(dashboard, "GET", "/api/mcp/servers")),
      ],
      { concurrency: 4 },
    );
    const session = decodeRecord(sessionBody);
    const model = session?.model;
    return {
      session,
      context:
        messages === null
          ? null
          : estimateContext(messages, model, contextLength(modelInfo, model)),
      mcpServers: decodeMcpServers(mcpBody),
    };
  });
