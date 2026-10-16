/**
 * Claude Code (CLI, desktop app, IDE extensions, SDK) sessions:
 * `~/.claude/projects/<dashed cwd>/<session id>.jsonl`, plus the live process
 * registry in `~/.claude/sessions/<pid>.json` for names, busy state and the
 * process behind each live session. The details card's record, context and
 * MCP servers come from claudeSessionIndex.ts, with Claude desktop's own
 * record of a session's settings winning where it has one.
 *
 * @module external-sessions/claudeSource
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type ExternalSessionMessage, UPSTREAM_SYNC_PROMPT_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeClaudeContextWindow } from "./claudeContextWindow.ts";
import type { ClaudeDesktopArchive } from "./claudeDesktopArchive.ts";
import {
  claudeContextBreakdown,
  claudeMcpServers,
  claudeModelUsage,
  claudeSubagentDir,
  isClaudeSubagentTranscript,
  readClaudeSessionIndex,
  readClaudeSubagentUsage,
} from "./claudeSessionIndex.ts";
import {
  addModelUsage,
  label,
  modelUsageList,
  sessionRecord,
  wholeCount,
} from "./codexInsights.ts";
import {
  asCount,
  asRecord,
  asString,
  BranchHistory,
  clipMessage,
  contentText,
  type ExternalSessionInfo,
  type ExternalSessionModelUsage,
  type ExternalSessionSource,
  firstLine,
  isoTimestamp,
  isProcessAlive,
  listDirectory,
  parseJsonObject,
  readLines,
  readText,
  sessionDetails,
  statMtimeMs,
  timestampMs,
  toolLine,
} from "./ExternalSessionSource.ts";

const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/i;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

const ORIGINS: Record<string, string> = {
  "claude-desktop": "Desktop",
  cli: "CLI",
  "claude-vscode": "VS Code",
  "claude-jetbrains": "JetBrains",
};

const originFor = (entrypoint: string | null): string | null => {
  if (entrypoint === null) return null;
  return ORIGINS[entrypoint] ?? (entrypoint.startsWith("sdk") ? "SDK" : entrypoint);
};

// Harness-injected blocks the user never typed.
const INJECTED_BLOCK =
  /<(system-reminder|task-notification|local-command-stdout|local-command-stderr|command-message|command-args)>[\s\S]*?<\/\1>/g;

const userText = (content: unknown): string => {
  const text = contentText(content, ["text"]).replace(INJECTED_BLOCK, "");
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  return (command ? command[1]! : text).trim();
};

const toolDetail = (input: unknown): string | null => {
  const record = asRecord(input);
  if (record === null) return null;
  return (
    asString(record.description) ??
    asString(record.command) ??
    asString(record.file_path) ??
    asString(record.path) ??
    asString(record.pattern) ??
    asString(record.url) ??
    asString(record.query) ??
    asString(record.prompt)
  );
};

/**
 * Context at one request: its whole prompt, cached or not. The reply's own
 * tokens are left out, as Claude desktop counts it.
 */
const contextTokens = (usage: Record<string, unknown> | null): number | null => {
  const input = asCount(usage?.input_tokens);
  if (input === null) return null;
  return (
    input +
    (asCount(usage?.cache_creation_input_tokens) ?? 0) +
    (asCount(usage?.cache_read_input_tokens) ?? 0)
  );
};

/** Settings Claude stamps on its entries; each read keeps the latest. */
interface Latest {
  effort: string | null;
  version: string | null;
  permissionMode: string | null;
  contextTokens: number | null;
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

/**
 * The local source updater's merge agent runs are named by when they started,
 * in local time ("t3 100626 143205"), so the name holds from start to finish.
 */
const upstreamSyncTitle = (createdAt: string | null): string => {
  const start = new Date(createdAt ?? Number.NaN);
  if (Number.isNaN(start.getTime())) return "t3 sync";
  const date = [start.getMonth() + 1, start.getDate(), start.getFullYear() % 100];
  const time = [start.getHours(), start.getMinutes(), start.getSeconds()];
  return `t3 ${date.map(twoDigits).join("")} ${time.map(twoDigits).join("")}`;
};

interface RegistryEntry {
  readonly pid: number;
  readonly busy: boolean;
  readonly name: string | null;
  readonly entrypoint: string | null;
  readonly cwd: string | null;
  readonly version: string | null;
  /** The process has a Remote Control bridge open; the bridge id is not kept. */
  readonly remoteControl: boolean;
}

const isoFromMs = (ms: number | null): string | null =>
  ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();

/** Adds up per-model totals from several transcripts. */
const mergeModelUsage = (
  lists: ReadonlyArray<ReadonlyArray<ExternalSessionModelUsage>>,
): ReadonlyArray<ExternalSessionModelUsage> => {
  const buckets = new Map<string, ExternalSessionModelUsage>();
  for (const list of lists) {
    for (const entry of list) addModelUsage(buckets, entry.model, entry.speed, entry.totals);
  }
  return modelUsageList(buckets);
};

/**
 * `desktopArchive` adds Claude desktop's record of a session's settings to
 * the details card; without it the transcript's alone are shown.
 */
export const makeClaudeSource = (desktopArchive?: ClaudeDesktopArchive): ExternalSessionSource => {
  const home = NodePath.join(NodeOS.homedir(), ".claude");
  const contextWindow = makeClaudeContextWindow();
  const projects = NodePath.join(home, "projects");
  const registry = NodePath.join(home, "sessions");

  const isSessionPath = (path: string) =>
    SESSION_FILE.test(NodePath.basename(path)) &&
    NodePath.dirname(NodePath.dirname(path)) === projects;

  // Only `<pid>.json` files: the registry also holds key files that are never read.
  const readRegistry = Effect.gen(function* () {
    const entries = new Map<string, RegistryEntry>();
    for (const name of yield* listDirectory(registry)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const record = parseJsonObject((yield* readText(NodePath.join(registry, name))) ?? "");
      const sessionId = asString(record?.sessionId);
      const pid = record?.pid;
      if (record === null || sessionId === null || typeof pid !== "number") continue;
      if (!isProcessAlive(pid)) continue;
      entries.set(sessionId, {
        pid,
        busy: record.status === "busy",
        name: asString(record.name),
        entrypoint: asString(record.entrypoint),
        cwd: asString(record.cwd),
        version: asString(record.version),
        remoteControl: asString(record.bridgeSessionId) !== null,
      });
    }
    return entries;
  });

  // Every entry names its branch, but a summary reads only the head and tail.
  // Branches seen in earlier reads are kept, so a long session that switched
  // branches while watched keeps all of them.
  const branchesByPath = new Map<string, BranchHistory>();
  const branchesFor = (path: string) => {
    let history = branchesByPath.get(path);
    if (history === undefined) {
      if (branchesByPath.size > 1_000) branchesByPath.clear();
      history = new BranchHistory();
      branchesByPath.set(path, history);
    }
    return history;
  };

  const transcriptFor = (sessionId: string, cwd: string) =>
    NodePath.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);

  return {
    driver: "claudeAgent",
    roots: [
      { path: projects, recursive: true },
      { path: registry, recursive: false },
    ],
    sessionPathsFor: (changed) =>
      Effect.gen(function* () {
        if (isSessionPath(changed)) return [changed];
        if (NodePath.dirname(changed) !== registry || !changed.endsWith(".json")) return [];
        // A status flip only touches the registry; map it back to the transcript.
        const record = parseJsonObject((yield* readText(changed)) ?? "");
        const sessionId = asString(record?.sessionId);
        const cwd = asString(record?.cwd);
        return sessionId === null || cwd === null ? [] : [transcriptFor(sessionId, cwd)];
      }),
    discover: (sinceMs) =>
      Effect.gen(function* () {
        const found: Array<string> = [];
        for (const dir of yield* listDirectory(projects)) {
          const dirPath = NodePath.join(projects, dir);
          for (const name of yield* listDirectory(dirPath)) {
            if (!SESSION_FILE.test(name)) continue;
            const path = NodePath.join(dirPath, name);
            const mtime = yield* statMtimeMs(path);
            if (mtime !== null && mtime >= sinceMs) found.push(path);
          }
        }
        return found;
      }),
    summarize: (path) =>
      Effect.gen(function* () {
        const head = yield* readLines(path, { maxBytes: HEAD_BYTES });
        if (head === null) return [];
        const tail =
          head.size > HEAD_BYTES
            ? yield* readLines(path, { fromEnd: true, maxBytes: TAIL_BYTES })
            : head;
        const id = NodePath.basename(path, ".jsonl");
        let cwd: string | null = null;
        let entrypoint: string | null = null;
        let firstPrompt: string | null = null;
        let createdAt: string | null = null;
        const branches = branchesFor(path);
        const latest: Latest = {
          effort: null,
          version: null,
          permissionMode: null,
          contextTokens: null,
        };
        // Subagent entries carry their own settings; the session's are on the main chain.
        const track = (record: Record<string, unknown>) => {
          if (record.isSidechain === true) return;
          branches.add(record.gitBranch, timestampMs(record.timestamp, 0));
          latest.version = asString(record.version) ?? latest.version;
          if (record.type === "user") {
            latest.permissionMode = asString(record.permissionMode) ?? latest.permissionMode;
          }
          if (record.type === "assistant") {
            const message = asRecord(record.message);
            // Synthetic replies ("<synthetic>") carry no real usage.
            if (asString(message?.model)?.startsWith("<")) return;
            latest.effort = asString(record.effort) ?? latest.effort;
            latest.contextTokens = contextTokens(asRecord(message?.usage)) ?? latest.contextTokens;
          }
        };
        for (const line of head.lines) {
          const record = parseJsonObject(line);
          if (record === null) continue;
          if (tail !== head) track(record);
          cwd ??= asString(record.cwd);
          createdAt ??= asString(record.timestamp);
          entrypoint ??= asString(record.entrypoint);
          if (firstPrompt === null && record.type === "user" && record.isMeta !== true) {
            const text = userText(asRecord(record.message)?.content);
            if (text !== "") firstPrompt = text;
          }
        }
        let customTitle: string | null = null;
        let agentName: string | null = null;
        let model: string | null = null;
        for (const line of tail?.lines ?? []) {
          const record = parseJsonObject(line);
          if (record === null) continue;
          track(record);
          if (record.type === "custom-title")
            customTitle = asString(record.customTitle) ?? customTitle;
          if (record.type === "agent-name") agentName = asString(record.agentName) ?? agentName;
          if (record.type === "assistant") {
            const next = asString(asRecord(record.message)?.model);
            if (next !== null && !next.startsWith("<")) model = next;
          }
        }
        const live = (yield* readRegistry).get(id);
        const sessionCwd = cwd ?? live?.cwd ?? null;
        const window = yield* contextWindow.resolve(model, sessionCwd);
        const fallbackTitle =
          firstPrompt?.startsWith(UPSTREAM_SYNC_PROMPT_PREFIX) === true
            ? upstreamSyncTitle(createdAt)
            : (live?.name ?? firstPrompt ?? "Untitled session");
        const info: ExternalSessionInfo = {
          id,
          title: firstLine(customTitle ?? agentName ?? fallbackTitle),
          cwd: sessionCwd,
          model,
          origin: originFor(entrypoint ?? live?.entrypoint ?? null),
          updatedAtMs: head.mtimeMs,
          busy: live?.busy ?? false,
          ...(live === undefined ? {} : { process: { pid: live.pid } }),
          details: sessionDetails(id, {
            effort: latest.effort,
            gitBranches: branches.list(),
            version: latest.version,
            approval: latest.permissionMode,
            createdAt,
            contextTokens: latest.contextTokens,
            contextWindow: window?.window ?? null,
          }),
        };
        return [info];
      }),
    readInsights: (summary, transcriptPath) =>
      Effect.gen(function* () {
        if (transcriptPath === null) return {};
        const index = yield* readClaudeSessionIndex(transcriptPath);
        if (index === null) return {};
        const id = NodePath.basename(transcriptPath, ".jsonl");
        // Subagents bill tokens too, so the session's totals and cost include theirs.
        const usage = [claudeModelUsage(index)];
        const subagents = claudeSubagentDir(transcriptPath);
        for (const name of yield* listDirectory(subagents)) {
          if (isClaudeSubagentTranscript(name)) {
            usage.push(yield* readClaudeSubagentUsage(NodePath.join(subagents, name)));
          }
        }
        const modelUsage = mergeModelUsage(usage);
        const desktop =
          desktopArchive === undefined ? null : yield* desktopArchive.sessionMetadata(id);
        const live = (yield* readRegistry).get(id);
        const model = desktop?.model ?? index.model;
        const window = yield* contextWindow.resolve(model, summary.cwd);
        const totals = modelUsage.map((entry) => entry.totals);
        const total = (pick: (entry: (typeof totals)[number]) => number) =>
          totals.reduce((sum, entry) => sum + pick(entry), 0);
        // Claude desktop's record of the session's settings wins; times span both records.
        const startedAt = [desktop?.createdAtMs, index.firstAtMs].filter(
          (ms): ms is number => typeof ms === "number",
        );
        const lastActiveAt = [desktop?.lastActivityAtMs, index.lastAtMs].filter(
          (ms): ms is number => typeof ms === "number",
        );
        const session = sessionRecord({
          source: label(summary.origin),
          model: label(model),
          startedAt: isoFromMs(startedAt.length === 0 ? null : Math.min(...startedAt)),
          lastActiveAt: isoFromMs(lastActiveAt.length === 0 ? null : Math.max(...lastActiveAt)),
          messageCount: wholeCount(index.messageCount),
          toolCallCount: wholeCount(index.toolCallCount),
          apiCallCount: wholeCount(index.apiCallCount),
          toolFailureCount: wholeCount(index.toolFailureCount),
          turnCount: wholeCount(desktop?.completedTurns ?? index.turnCount),
          inputTokens: totals.length === 0 ? null : total((entry) => entry.uncachedInputTokens),
          outputTokens: totals.length === 0 ? null : total((entry) => entry.outputTokens),
          cacheReadTokens: totals.length === 0 ? null : total((entry) => entry.cachedInputTokens),
          cacheWriteTokens:
            totals.length === 0 ? null : total((entry) => entry.cacheCreationTokens),
          version: label(desktop?.cliVersion ?? live?.version ?? index.version),
          effort: label(desktop?.effort ?? index.effort),
          permissionMode: label(desktop?.permissionMode ?? index.permissionMode),
          // A running process knows; otherwise any record of a bridge says it was used.
          remoteControl:
            live?.remoteControl ??
            (desktop?.remoteControl === true || index.remoteControlSeen ? true : null),
          serviceTier: label(index.speed),
        });
        return {
          session,
          context: claudeContextBreakdown(index, window, desktop?.connectorNames),
          mcpServers: claudeMcpServers(index, desktop?.connectorNames),
          modelUsage,
        };
      }),
    transcriptPath: (path) => path,
    createParser: () => ({
      push: (line) => {
        const record = parseJsonObject(line);
        if (record === null || record.isSidechain === true || record.isMeta === true) return [];
        const id = asString(record.uuid);
        const message = asRecord(record.message);
        if (id === null || message === null) return [];
        const createdAt = isoTimestamp(record.timestamp);
        if (record.type === "user") {
          // Tool results are already summarized by the tool line before them.
          const text = userText(message.content);
          return text === "" ? [] : [{ id, role: "user", text: clipMessage(text), createdAt }];
        }
        if (record.type !== "assistant" || !Array.isArray(message.content)) return [];
        const out: Array<ExternalSessionMessage> = [];
        message.content.forEach((block, index) => {
          const value = asRecord(block);
          if (value?.type === "text") {
            const text = asString(value.text)?.trim();
            if (text)
              out.push({
                id: `${id}:${index}`,
                role: "assistant",
                text: clipMessage(text),
                createdAt,
              });
          } else if (value?.type === "tool_use") {
            out.push({
              id: `${id}:${index}`,
              role: "tool",
              text: toolLine(asString(value.name) ?? "tool", toolDetail(value.input)),
              createdAt,
            });
          }
        });
        return out;
      },
    }),
  };
};
