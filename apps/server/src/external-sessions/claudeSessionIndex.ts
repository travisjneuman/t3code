/**
 * What a Claude Code transcript records about its session as a whole, for
 * the details card: the context the CLI loaded (memory files, skills, custom
 * agents, MCP tools and instructions, as attachments), compactions, token
 * totals and counts. Built by an incremental forward scan, so a repeat read
 * parses only what was appended. Subagent transcripts add their tokens only.
 * Fork add-on: session details.
 *
 * @module external-sessions/claudeSessionIndex
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  SessionContextBreakdown,
  SessionContextCategory,
  SessionContextContributor,
  SessionMcpServer,
} from "@t3tools/contracts";
import { sessionMcpServer } from "@t3tools/provider-core/server/sessionInsights";
import { tokenCount, type UsageSpeed } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import type { ClaudeContextWindow } from "./claudeContextWindow.ts";
import { addModelUsage, type ForwardScans, modelUsageList, scanForward } from "./codexInsights.ts";
import {
  asCount,
  asRecord,
  asString,
  type ExternalSessionModelUsage,
  parseJsonObject,
  timestampMs,
} from "./ExternalSessionSource.ts";

/** Recent message and tool ids kept to drop the repeats Claude writes per content block. */
const RECENT_IDS = 1_000;
/** Rough characters per token for the estimated categories. */
const CHARS_PER_TOKEN = 4;

interface Sized {
  readonly name: string;
  readonly source?: string;
  readonly chars: number;
}

/** Ids seen lately, oldest dropped first. */
class RecentIds {
  private readonly ids = new Set<string>();

  /** True the first time an id is seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > RECENT_IDS) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
}

interface UsageScan {
  readonly usage: Map<string, ExternalSessionModelUsage>;
  readonly calls: RecentIds;
}

export interface ClaudeSessionIndex extends UsageScan {
  /** The latest `instructions` attachment's files (CLAUDE.md, rules, auto memory). */
  memoryFiles: Map<string, Sized>;
  /** Memory files loaded on demand since the latest compaction. */
  readonly nestedMemory: Map<string, Sized>;
  readonly skills: Map<string, number>;
  readonly customAgents: Map<string, number>;
  readonly deferredTools: Set<string>;
  readonly mcpInstructions: Map<string, number>;
  /** Servers the CLI reported failed, pending or needing auth, by name. */
  mcpProblems: Map<string, SessionMcpServer["status"]>;
  /** Message text, tool calls and tool results since the latest compaction. */
  messageChars: number;
  compactionCount: number;
  /** Tokens in context at the latest main-chain request. */
  contextTokens: number | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  version: string | null;
  speed: string | null;
  firstAtMs: number | null;
  lastAtMs: number | null;
  lastPromptId: string | null;
  turnCount: number;
  messageCount: number;
  apiCallCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  /** Tool call and reply ids, so a record per content block counts once. */
  readonly seenIds: RecentIds;
  /** A `bridge-session` entry: Remote Control was on at some point. */
  remoteControlSeen: boolean;
}

const initialUsage = (): UsageScan => ({ usage: new Map(), calls: new RecentIds() });

const initialIndex = (): ClaudeSessionIndex => ({
  ...initialUsage(),
  memoryFiles: new Map(),
  nestedMemory: new Map(),
  skills: new Map(),
  customAgents: new Map(),
  deferredTools: new Set(),
  mcpInstructions: new Map(),
  mcpProblems: new Map(),
  messageChars: 0,
  compactionCount: 0,
  contextTokens: null,
  model: null,
  effort: null,
  permissionMode: null,
  version: null,
  speed: null,
  firstAtMs: null,
  lastAtMs: null,
  lastPromptId: null,
  turnCount: 0,
  messageCount: 0,
  apiCallCount: 0,
  toolCallCount: 0,
  toolFailureCount: 0,
  seenIds: new RecentIds(),
  remoteControlSeen: false,
});

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const text = asString(item) ?? asString(asRecord(item)?.name);
        return text === null ? [] : [text];
      })
    : [];

/** Memory files under the server's home read as `~/...`, as Claude Desktop shows them. */
const homeRelativePath = (path: string): string => {
  const home = NodeOS.homedir();
  return home.length > 1 && path.startsWith(home + NodePath.sep)
    ? `~${path.slice(home.length)}`
    : path;
};

const textLength = (content: unknown): number => {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) chars += asString(asRecord(block)?.text)?.length ?? 0;
  return chars;
};

/**
 * Counts one assistant request's tokens once, the way the usage page does
 * (first record per message and request id), and returns whether it was new.
 */
const addUsage = (scan: UsageScan, record: Record<string, unknown>): boolean => {
  const message = asRecord(record.message);
  const usage = asRecord(message?.usage);
  const model = asString(message?.model);
  if (usage === null || model === null || model.startsWith("<")) return false;
  const messageId = asString(message?.id);
  const requestId = asString(record.requestId);
  if (messageId !== null || requestId !== null) {
    if (!scan.calls.add(`${messageId ?? ""}:${requestId ?? ""}`)) return false;
  }
  const speed: UsageSpeed = usage.speed === "fast" ? "fast" : "standard";
  addModelUsage(scan.usage, model, speed, {
    uncachedInputTokens: tokenCount(usage.input_tokens),
    cachedInputTokens: tokenCount(usage.cache_read_input_tokens),
    cacheCreationTokens: tokenCount(usage.cache_creation_input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    reasoningTokens: 0,
  });
  return true;
};

const visitAttachment = (index: ClaudeSessionIndex, attachment: Record<string, unknown>) => {
  switch (attachment.type) {
    case "instructions": {
      if (!Array.isArray(attachment.files)) return;
      const files = new Map<string, Sized>();
      for (const item of attachment.files) {
        const file = asRecord(item);
        const path = asString(file?.path);
        if (path === null) continue;
        const source = asString(file?.type);
        files.set(path, {
          name: homeRelativePath(path),
          ...(source === null ? {} : { source }),
          chars: asString(file?.content)?.length ?? 0,
        });
      }
      index.memoryFiles = files;
      return;
    }
    case "nested_memory": {
      const path = asString(attachment.path);
      if (path === null) return;
      const content = asRecord(attachment.content);
      const source = asString(content?.type);
      index.nestedMemory.set(path, {
        name: homeRelativePath(path),
        ...(source === null ? {} : { source }),
        chars: asString(content?.content)?.length ?? 0,
      });
      return;
    }
    case "skill_listing": {
      if (attachment.isInitial === true) index.skills.clear();
      // One "- name" or "- name: description" line per skill.
      for (const line of (asString(attachment.content) ?? "").split("\n")) {
        if (!line.startsWith("- ")) continue;
        const name = line.slice(2).split(":", 1)[0]!.trim();
        if (name !== "") index.skills.set(name, line.length);
      }
      for (const name of strings(attachment.names)) {
        if (!index.skills.has(name)) index.skills.set(name, 0);
      }
      return;
    }
    case "agent_listing_delta": {
      if (attachment.isInitial === true) index.customAgents.clear();
      const builtIn = new Set(strings(attachment.builtInTypes));
      const lines = Array.isArray(attachment.addedLines) ? attachment.addedLines : [];
      strings(attachment.addedTypes).forEach((type, position) => {
        if (builtIn.has(type)) return;
        index.customAgents.set(type, asString(lines[position])?.length ?? 0);
      });
      for (const type of strings(attachment.removedTypes)) index.customAgents.delete(type);
      return;
    }
    case "deferred_tools_delta": {
      for (const name of strings(attachment.addedNames)) index.deferredTools.add(name);
      for (const name of strings(attachment.readdedNames)) index.deferredTools.add(name);
      for (const name of strings(attachment.removedNames)) index.deferredTools.delete(name);
      const lists = [
        [attachment.failedMcpServers, "failed"],
        [attachment.pendingMcpServers, "pending"],
        [attachment.needsAuthMcpServers, "needs-auth"],
      ] as const;
      // Each delta carries the current lists; a null one was not reported.
      if (lists.some(([value]) => Array.isArray(value))) {
        const problems = new Map<string, SessionMcpServer["status"]>();
        for (const [value, status] of lists) {
          for (const name of strings(value)) problems.set(name, status);
        }
        index.mcpProblems = problems;
      }
      return;
    }
    case "mcp_instructions_delta": {
      const blocks = Array.isArray(attachment.addedBlocks) ? attachment.addedBlocks : [];
      strings(attachment.addedNames).forEach((name, position) => {
        index.mcpInstructions.set(name, asString(blocks[position])?.length ?? 0);
      });
      for (const name of strings(attachment.removedNames)) index.mcpInstructions.delete(name);
      return;
    }
  }
};

const visitUser = (index: ClaudeSessionIndex, record: Record<string, unknown>) => {
  index.permissionMode = asString(record.permissionMode) ?? index.permissionMode;
  const content = asRecord(record.message)?.content;
  let text = typeof content === "string" ? content.length : 0;
  if (Array.isArray(content)) {
    for (const item of content) {
      const block = asRecord(item);
      if (block?.type === "text") text += asString(block.text)?.length ?? 0;
      else if (block?.type === "tool_result") {
        index.messageChars += textLength(block.content);
        if (block.is_error === true) index.toolFailureCount += 1;
      }
    }
  }
  index.messageChars += text;
  if (text === 0 || record.isMeta === true || record.isCompactSummary === true) return;
  index.messageCount += 1;
  // Every entry of a turn carries the prompt's id; older CLIs write none.
  const promptId = asString(record.promptId);
  if (promptId === null || promptId !== index.lastPromptId) index.turnCount += 1;
  index.lastPromptId = promptId;
};

const visitAssistant = (index: ClaudeSessionIndex, record: Record<string, unknown>) => {
  const message = asRecord(record.message);
  const model = asString(message?.model);
  // Synthetic replies ("<synthetic>") are the CLI's own, with no request behind them.
  if (model === null || model.startsWith("<")) return;
  index.model = model;
  index.effort = asString(record.effort) ?? index.effort;
  if (addUsage(index, record)) {
    index.apiCallCount += 1;
    const usage = asRecord(message?.usage);
    index.speed = asString(usage?.speed) ?? index.speed;
    const input = asCount(usage?.input_tokens);
    if (input !== null) {
      index.contextTokens =
        input +
        (asCount(usage?.cache_creation_input_tokens) ?? 0) +
        (asCount(usage?.cache_read_input_tokens) ?? 0);
    }
  }
  const content = message?.content;
  if (!Array.isArray(content)) return;
  let hasText = false;
  for (const item of content) {
    const block = asRecord(item);
    if (block?.type === "text") {
      index.messageChars += asString(block.text)?.length ?? 0;
      hasText = true;
    } else if (block?.type === "tool_use") {
      const id = asString(block.id);
      if (id !== null && !index.seenIds.add(id)) continue;
      index.toolCallCount += 1;
      const input = JSON.stringify(block.input ?? {});
      index.messageChars += (asString(block.name)?.length ?? 0) + input.length;
    }
  }
  // Claude writes a record per content block; a reply counts once.
  const messageId = asString(message?.id);
  if (hasText && (messageId === null || index.seenIds.add(`message:${messageId}`))) {
    index.messageCount += 1;
  }
};

const visitMain = (index: ClaudeSessionIndex, line: string) => {
  const record = parseJsonObject(line);
  if (record === null) return;
  // Older CLIs wrote subagent turns into the main transcript; they cost tokens, nothing more.
  if (record.isSidechain === true) {
    if (record.type === "assistant") addUsage(index, record);
    return;
  }
  const at = timestampMs(record.timestamp, Number.NaN);
  if (Number.isFinite(at)) {
    index.firstAtMs ??= at;
    index.lastAtMs = Math.max(index.lastAtMs ?? at, at);
  }
  index.version = asString(record.version) ?? index.version;
  switch (record.type) {
    case "attachment": {
      const attachment = asRecord(record.attachment);
      if (attachment !== null) visitAttachment(index, attachment);
      return;
    }
    case "bridge-session":
      index.remoteControlSeen = true;
      return;
    case "system":
      if (record.subtype === "compact_boundary") {
        index.compactionCount += 1;
        index.messageChars = 0;
        index.nestedMemory.clear();
      }
      return;
    case "user":
      visitUser(index, record);
      return;
    case "assistant":
      visitAssistant(index, record);
      return;
  }
};

const visitSubagent = (scan: UsageScan, line: string) => {
  if (!line.includes('"usage"')) return;
  const record = parseJsonObject(line);
  if (record?.type === "assistant") addUsage(scan, record);
};

const mainScans: ForwardScans<ClaudeSessionIndex> = new Map();
const subagentScans: ForwardScans<UsageScan> = new Map();

/** The session's index, brought up to date with what was appended since the last read. */
export const readClaudeSessionIndex = (
  path: string,
): Effect.Effect<ClaudeSessionIndex | null, never, FileSystem.FileSystem> =>
  scanForward(mainScans, path, initialIndex, visitMain);

/** Subagent transcripts sit beside the session's: `<session id>/subagents/agent-*.jsonl`. */
export const claudeSubagentDir = (transcriptPath: string): string =>
  NodePath.join(
    NodePath.dirname(transcriptPath),
    NodePath.basename(transcriptPath, ".jsonl"),
    "subagents",
  );

export const isClaudeSubagentTranscript = (name: string): boolean =>
  name.startsWith("agent-") && name.endsWith(".jsonl");

/** A subagent transcript's token totals, brought up to date the same way. */
export const readClaudeSubagentUsage = (
  path: string,
): Effect.Effect<ReadonlyArray<ExternalSessionModelUsage>, never, FileSystem.FileSystem> =>
  Effect.map(scanForward(subagentScans, path, initialUsage, visitSubagent), (scan) =>
    scan === null ? [] : modelUsageList(scan.usage),
  );

/** The main chain's token totals per model and speed. */
export const claudeModelUsage = (
  index: ClaudeSessionIndex,
): ReadonlyArray<ExternalSessionModelUsage> => modelUsageList(index.usage);

const estimate = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

const sizedContributors = (items: Iterable<Sized>): Array<SessionContextContributor> =>
  [...items].flatMap((item) => {
    const name = item.name.trim();
    const source = item.source?.trim();
    return name === ""
      ? []
      : [{ name, ...(source ? { source } : {}), tokens: estimate(item.chars) }];
  });

const namedContributors = (items: ReadonlyMap<string, number>): Array<SessionContextContributor> =>
  sizedContributors([...items].map(([name, chars]) => ({ name, chars })));

const sum = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

/** The server part of an MCP tool's wire name, normalized as the CLI writes it. */
const normalizeServer = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

const mcpTool = (name: string): { readonly server: string; readonly tool: string } | null => {
  if (!name.startsWith("mcp__")) return null;
  const separator = name.indexOf("__", 5);
  if (separator <= 5 || separator + 2 >= name.length) return null;
  return { server: name.slice(5, separator), tool: name.slice(separator + 2) };
};

/**
 * Server names as the CLI reported them, keyed by their normalized form. A
 * claude.ai connector is reported by its id, so a known connector name wins.
 */
const serverNames = (index: ClaudeSessionIndex, connectorNames: ReadonlyMap<string, string>) => {
  const names = new Map<string, string>();
  for (const name of [...index.mcpInstructions.keys(), ...index.mcpProblems.keys()]) {
    names.set(normalizeServer(name), name);
  }
  for (const [id, name] of connectorNames) names.set(normalizeServer(id), name);
  return names;
};

/**
 * The MCP servers the transcript shows: those with tools or instructions are
 * connected, and the CLI's latest failed, pending and needs-auth lists win.
 * Null when the transcript records no MCP server at all.
 */
export const claudeMcpServers = (
  index: ClaudeSessionIndex,
  connectorNames: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<SessionMcpServer> | null => {
  const names = serverNames(index, connectorNames);
  const servers = new Map<string, { status: SessionMcpServer["status"]; tools: number }>();
  const server = (normalized: string) => {
    let entry = servers.get(normalized);
    if (entry === undefined) {
      entry = { status: "connected", tools: 0 };
      servers.set(normalized, entry);
    }
    return entry;
  };
  for (const name of index.deferredTools) {
    const tool = mcpTool(name);
    if (tool !== null) server(tool.server).tools += 1;
  }
  for (const name of index.mcpInstructions.keys()) server(normalizeServer(name));
  for (const [name, status] of index.mcpProblems) server(normalizeServer(name)).status = status;
  if (servers.size === 0) return null;
  return [...servers]
    .flatMap(([normalized, entry]) => {
      const row = sessionMcpServer({
        name: names.get(normalized) ?? normalized,
        status: entry.status,
        ...(entry.tools > 0 ? { toolCount: entry.tools } : {}),
      });
      return row === undefined ? [] : [row];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

const ESTIMATE_NOTE =
  "Estimated from the transcript: each category is its text length over four, fitted to the measured total. System prompt and tools is the rest. MCP tools load on demand and are listed without sizes.";

/**
 * The context as the transcript records it: the measured total at the latest
 * request, split into estimated categories. Null before the first request or
 * when the window is unknown.
 */
export const claudeContextBreakdown = (
  index: ClaudeSessionIndex,
  window: ClaudeContextWindow | null,
  connectorNames: ReadonlyMap<string, string> = new Map(),
): SessionContextBreakdown | null => {
  const total = index.contextTokens;
  if (total === null || window === null) return null;
  const memoryFiles = sizedContributors([
    ...index.memoryFiles.values(),
    ...index.nestedMemory.values(),
  ]);
  const skills = namedContributors(index.skills);
  const agents = namedContributors(index.customAgents);
  const names = serverNames(index, connectorNames);
  const mcpTools = [...index.deferredTools].flatMap((name): Array<SessionContextContributor> => {
    const tool = mcpTool(name);
    if (tool === null) return [];
    return [{ name: tool.tool, source: names.get(tool.server) ?? tool.server }];
  });
  const parts: Array<readonly [string, number]> = [
    ["Memory files", sum(memoryFiles.map((file) => file.tokens ?? 0))],
    ["Skills", sum(skills.map((skill) => skill.tokens ?? 0))],
    ["Custom agents", sum(agents.map((agent) => agent.tokens ?? 0))],
    ["MCP instructions", estimate(sum(index.mcpInstructions.values()))],
  ];
  // Estimates that overshoot the measured total shrink to fit inside it.
  const known = sum(parts.map(([, tokens]) => tokens));
  const scale = known > total ? total / known : 1;
  const fitted = parts.map(([name, tokens]) => [name, Math.floor(tokens * scale)] as const);
  const fittedKnown = sum(fitted.map(([, tokens]) => tokens));
  const messages = Math.min(estimate(index.messageChars), total - fittedKnown);
  const used: Array<readonly [string, number]> = [
    ["System prompt and tools", total - fittedKnown - messages],
    ...fitted,
    ["Messages", messages],
  ];
  const categories: Array<SessionContextCategory> = used.flatMap(([name, tokens]) =>
    tokens > 0 ? [{ name, tokens, kind: "used" as const }] : [],
  );
  const reserve =
    window.autoCompactThreshold === null ? 0 : window.window - window.autoCompactThreshold;
  const buffer = Math.min(reserve, Math.max(0, window.window - total));
  const free = Math.max(0, window.window - total - buffer);
  if (free > 0) categories.push({ name: "Free space", tokens: free, kind: "free" });
  if (buffer > 0) categories.push({ name: "Autocompact buffer", tokens: buffer, kind: "buffer" });
  return {
    ...(index.model === null ? {} : { model: index.model }),
    totalTokens: total,
    maxTokens: window.window,
    categories,
    mcpTools,
    memoryFiles,
    agents,
    skills,
    estimated: true,
    note: ESTIMATE_NOTE,
    autoCompactEnabled: window.autoCompactEnabled,
    ...(window.autoCompactThreshold === null
      ? {}
      : { autoCompactThreshold: window.autoCompactThreshold }),
    compactionCount: index.compactionCount,
  };
};
