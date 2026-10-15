/**
 * The details card's insights for Grok sessions, from the files Grok keeps
 * beside the transcript: `usage.json` (tokens, cost), `signals.json` (counts,
 * context), `prompt_context.json` (memory files) and `events.jsonl` (turn
 * times, MCP servers). Fork add-on: session details.
 *
 * @module external-sessions/grokInsights
 */
import * as NodePath from "node:path";

import type {
  SessionContextBreakdown,
  SessionContextContributor,
  SessionMcpServer,
} from "@t3tools/contracts";
import { tokenCount } from "@t3tools/provider-core/server/usage";
import { GROK_COST_USD_TICKS_PER_DOLLAR } from "@t3tools/provider-grok/server/usage";
import * as Effect from "effect/Effect";

import {
  addModelUsage,
  type ForwardScans,
  type JsonFiles,
  label,
  modelUsageList,
  readJsonFile,
  scanForward,
  sessionRecord,
  wholeCount,
} from "./codexInsights.ts";
import {
  asCount,
  asRecord,
  type ExternalSessionModelUsage,
  parseJsonObject,
  type ReadSessionInsights,
} from "./ExternalSessionSource.ts";

/** One MCP server as the latest Grok start resolved it. */
interface GrokServer {
  status: SessionMcpServer["status"];
  readonly tools: Array<string>;
}

/** What `events.jsonl` says, summed over the whole file. */
interface GrokEvents {
  /** Reset by each `mcp_config_resolved`: a resumed session starts its servers again. */
  servers: Map<string, GrokServer>;
  turns: number;
  durationMs: number;
  turnStartMs: number | null;
  lastAtMs: number;
}

const initialEvents = (): GrokEvents => ({
  servers: new Map(),
  turns: 0,
  durationMs: 0,
  turnStartMs: null,
  lastAtMs: 0,
});

// Grok writes `"ts"` and `"type"` first, so both sit in the head of each line.
const LINE_HEAD = 200;
const EVENT_TIME = /"ts":"([^"]+)"/;
const MCP_EVENT = /"type":"mcp_/;

const serverName = (value: unknown): string | null =>
  label(typeof value === "string" ? value : asRecord(value)?.name);

const visitMcpEvent = (events: GrokEvents, line: string) => {
  const record = parseJsonObject(line);
  if (record === null) return;
  switch (record.type) {
    case "mcp_config_resolved": {
      events.servers = new Map();
      for (const entry of Array.isArray(record.servers) ? record.servers : []) {
        const name = serverName(entry);
        if (name !== null) events.servers.set(name, { status: "pending", tools: [] });
      }
      for (const entry of Array.isArray(record.disabled) ? record.disabled : []) {
        const name = serverName(entry);
        if (name !== null) events.servers.set(name, { status: "disabled", tools: [] });
      }
      return;
    }
    case "mcp_server_connected": {
      const name = label(record.server_name);
      if (name === null) return;
      const tools = Array.isArray(record.tools)
        ? record.tools.flatMap((tool) => label(tool) ?? [])
        : [];
      events.servers.set(name, { status: "connected", tools });
      return;
    }
    case "mcp_init_completed": {
      // Grok reports how many failed, not which; a server that never
      // connected needs sign-in when that is all that went wrong.
      const needsAuth = (asCount(record.auth_required) ?? 0) > 0 && asCount(record.failed) === 0;
      for (const server of events.servers.values()) {
        if (server.status === "pending") server.status = needsAuth ? "needs-auth" : "failed";
      }
      return;
    }
  }
};

const closeTurn = (events: GrokEvents, endMs: number) => {
  if (events.turnStartMs !== null) {
    events.durationMs += Math.max(0, endMs - events.turnStartMs);
  }
  events.turnStartMs = null;
};

const visitEventLine = (events: GrokEvents, line: string) => {
  const head = line.slice(0, LINE_HEAD);
  const time = EVENT_TIME.exec(head)?.[1];
  const atMs = time === undefined ? Number.NaN : Date.parse(time);
  if (head.includes('"type":"turn_started"')) {
    // A turn left open (Grok quit mid-turn) ran until the last event before this one.
    closeTurn(events, events.lastAtMs);
    events.turns += 1;
    events.turnStartMs = Number.isFinite(atMs) ? atMs : null;
  } else if (head.includes('"type":"turn_ended"')) {
    closeTurn(events, Number.isFinite(atMs) ? atMs : events.lastAtMs);
  } else if (MCP_EVENT.test(head)) {
    visitMcpEvent(events, line);
  }
  if (Number.isFinite(atMs)) events.lastAtMs = Math.max(events.lastAtMs, atMs);
};

const durationMs = (events: GrokEvents): number =>
  Math.round(
    events.durationMs +
      (events.turnStartMs === null ? 0 : Math.max(0, events.lastAtMs - events.turnStartMs)),
  );

/** Grok's per-model totals; its input counts include cached and cache-write tokens. */
const grokModelUsage = (usage: Record<string, unknown> | null) => {
  const buckets = new Map<string, ExternalSessionModelUsage>();
  for (const [model, raw] of Object.entries(asRecord(usage?.modelUsage) ?? {})) {
    const totals = asRecord(raw);
    const name = label(model);
    if (totals === null || name === null) continue;
    const cached = tokenCount(totals.cachedReadTokens);
    const cacheWrite = tokenCount(totals.cacheCreationTokens);
    const output = tokenCount(totals.outputTokens);
    addModelUsage(buckets, name, "standard", {
      uncachedInputTokens: Math.max(0, tokenCount(totals.inputTokens) - cached - cacheWrite),
      cachedInputTokens: cached,
      cacheCreationTokens: cacheWrite,
      outputTokens: output,
      reasoningTokens: Math.min(output, tokenCount(totals.reasoningTokens)),
    });
  }
  return modelUsageList(buckets);
};

const grokRecord = (
  usage: Record<string, unknown> | null,
  signals: Record<string, unknown> | null,
  events: GrokEvents | null,
) => {
  const input = tokenCount(usage?.inputTokens);
  const cached = tokenCount(usage?.cachedReadTokens);
  const cacheWrite = tokenCount(usage?.cacheCreationTokens);
  const output = tokenCount(usage?.outputTokens);
  const ticks = asCount(usage?.costUsdTicks);
  // Zero ticks beside real tokens means Grok did not price the session.
  const costUsd =
    ticks === null || (ticks === 0 && input + output > 0)
      ? null
      : ticks / GROK_COST_USD_TICKS_PER_DOLLAR;
  const users = wholeCount(signals?.userMessageCount);
  const assistants = wholeCount(signals?.assistantMessageCount);
  return sessionRecord({
    model: label(usage?.primaryModelId) ?? label(signals?.primaryModelId),
    turnCount: wholeCount(usage?.turnCount) ?? wholeCount(signals?.turnCount),
    messageCount: users === null || assistants === null ? null : users + assistants,
    toolCallCount: wholeCount(signals?.toolCallCount),
    toolFailureCount: wholeCount(signals?.toolFailureCount),
    apiCallCount: wholeCount(usage?.modelCalls),
    durationMs: events === null || events.turns === 0 ? null : durationMs(events),
    inputTokens: usage === null ? null : Math.max(0, input - cached - cacheWrite),
    cacheReadTokens: usage === null ? null : cached,
    cacheWriteTokens: usage === null ? null : cacheWrite,
    outputTokens: usage === null ? null : output,
    reasoningTokens: usage === null ? null : Math.min(output, tokenCount(usage.reasoningTokens)),
    costUsd,
    costEstimated: costUsd === null ? null : false,
  });
};

/** The memory files Grok loaded (`AGENTS.md` and the like), named but not sized. */
const memoryFiles = (
  prompt: Record<string, unknown> | null,
): ReadonlyArray<SessionContextContributor> => {
  const entries: unknown = prompt?.agents_md_files;
  return (Array.isArray(entries) ? entries : []).flatMap(
    (entry: unknown): ReadonlyArray<SessionContextContributor> => {
      const file = asRecord(entry);
      const name = label(file?.file_path) ?? label(file?.file_name);
      if (name === null) return [];
      const source = label(file?.source);
      return [source === null ? { name } : { name, source }];
    },
  );
};

const grokContext = (
  signals: Record<string, unknown> | null,
  memory: ReadonlyArray<SessionContextContributor>,
  events: GrokEvents | null,
  model: string | undefined,
): SessionContextBreakdown | null => {
  const used = wholeCount(signals?.contextTokensUsed);
  const window = wholeCount(signals?.contextWindowTokens);
  if (used === null || window === null || window === 0) return null;
  const compactions = wholeCount(signals?.compactionCount);
  const mcpTools = [...(events?.servers ?? [])].flatMap(([server, entry]) =>
    entry.tools.map((name): SessionContextContributor => ({ name, source: server })),
  );
  return {
    ...(model === undefined ? {} : { model }),
    totalTokens: used,
    maxTokens: window,
    // Grok reports the total in context, not what fills it.
    categories: window > used ? [{ name: "Free space", tokens: window - used, kind: "free" }] : [],
    mcpTools,
    memoryFiles: memory,
    agents: [],
    skills: [],
    ...(compactions === null ? {} : { compactionCount: compactions }),
  };
};

const mcpServers = (events: GrokEvents): ReadonlyArray<SessionMcpServer> =>
  [...events.servers].map(([name, server]): SessionMcpServer => ({
    name,
    status: server.status,
    ...(server.status === "connected" ? { toolCount: server.tools.length } : {}),
  }));

/** The context size `signals.json` records, for the session's details. */
export const grokContextUsage = (signals: Record<string, unknown> | null) => ({
  contextTokens: asCount(signals?.contextTokensUsed),
  contextWindow: asCount(signals?.contextWindowTokens),
});

/**
 * Grok's insights: the record (tokens, Grok's own cost, counts, turn time),
 * the context total against its window with the MCP tools and memory files
 * that fill it, and the MCP servers the latest start connected.
 */
export const makeGrokInsights = (): ReadSessionInsights => {
  // Usage and signals are small; of the prompt context (which holds the
  // memory files' text) only the files' names are kept.
  const files: JsonFiles<Record<string, unknown> | null> = new Map();
  const prompts: JsonFiles<ReadonlyArray<SessionContextContributor>> = new Map();
  const whole = (file: Record<string, unknown> | null) => file;
  const scans: ForwardScans<GrokEvents> = new Map();
  return (_summary, transcriptPath) =>
    Effect.gen(function* () {
      if (transcriptPath === null) return {};
      const dir = NodePath.dirname(transcriptPath);
      const usageFile = yield* readJsonFile(files, NodePath.join(dir, "usage.json"), whole);
      const usage = asRecord(usageFile?.session);
      const signals = yield* readJsonFile(files, NodePath.join(dir, "signals.json"), whole);
      const memory = yield* readJsonFile(
        prompts,
        NodePath.join(dir, "prompt_context.json"),
        memoryFiles,
      );
      const events = yield* scanForward(
        scans,
        NodePath.join(dir, "events.jsonl"),
        initialEvents,
        visitEventLine,
      );
      const session = grokRecord(usage, signals, events);
      const context = grokContext(signals, memory, events, session.model);
      const servers = events === null ? [] : mcpServers(events);
      return {
        ...(Object.keys(session).length === 0 ? {} : { session }),
        ...(usage === null ? {} : { modelUsage: grokModelUsage(usage) }),
        context,
        ...(servers.length === 0 ? {} : { mcpServers: servers }),
      };
    }).pipe(Effect.catchCause(() => Effect.succeed({})));
};
