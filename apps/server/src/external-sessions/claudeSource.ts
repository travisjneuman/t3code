/**
 * Claude Code (CLI, desktop app, IDE extensions, SDK) sessions:
 * `~/.claude/projects/<dashed cwd>/<session id>.jsonl`, plus the live process
 * registry in `~/.claude/sessions/<pid>.json` for names and busy state.
 *
 * @module external-sessions/claudeSource
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ExternalSessionMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  asRecord,
  asString,
  clipMessage,
  contentText,
  type ExternalSessionInfo,
  type ExternalSessionSource,
  firstLine,
  isoTimestamp,
  listDirectory,
  parseJsonObject,
  readLines,
  readText,
  statMtimeMs,
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

interface RegistryEntry {
  readonly busy: boolean;
  readonly name: string | null;
  readonly entrypoint: string | null;
  readonly cwd: string | null;
}

const isAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const makeClaudeSource = (): ExternalSessionSource => {
  const home = NodePath.join(NodeOS.homedir(), ".claude");
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
      if (record === null || sessionId === null || !isAlive(record.pid)) continue;
      entries.set(sessionId, {
        busy: record.status === "busy",
        name: asString(record.name),
        entrypoint: asString(record.entrypoint),
        cwd: asString(record.cwd),
      });
    }
    return entries;
  });

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
        for (const line of head.lines) {
          const record = parseJsonObject(line);
          if (record === null) continue;
          cwd ??= asString(record.cwd);
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
          if (record.type === "custom-title")
            customTitle = asString(record.customTitle) ?? customTitle;
          if (record.type === "agent-name") agentName = asString(record.agentName) ?? agentName;
          if (record.type === "assistant") {
            const next = asString(asRecord(record.message)?.model);
            if (next !== null && !next.startsWith("<")) model = next;
          }
        }
        const live = (yield* readRegistry).get(id);
        const info: ExternalSessionInfo = {
          id,
          title: firstLine(
            customTitle ?? agentName ?? live?.name ?? firstPrompt ?? "Untitled session",
          ),
          cwd: cwd ?? live?.cwd ?? null,
          model,
          origin: originFor(entrypoint ?? live?.entrypoint ?? null),
          updatedAtMs: head.mtimeMs,
          busy: live?.busy ?? false,
        };
        return [info];
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
