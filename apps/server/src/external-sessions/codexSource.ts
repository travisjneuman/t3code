/**
 * Codex (CLI, desktop app, IDE extension) sessions:
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. Thread names come
 * from `~/.codex/session_index.jsonl`. Subagent rollouts and T3's own Codex
 * sessions are left out.
 *
 * @module external-sessions/codexSource
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ExternalSessionMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  asCount,
  asRecord,
  asString,
  branchName,
  clipMessage,
  contentText,
  type ExternalSessionSource,
  firstLine,
  isoTimestamp,
  listDirectory,
  parseJsonObject,
  readLines,
  readPrefix,
  sessionDetails,
  statMtimeMs,
  toolLine,
} from "./ExternalSessionSource.ts";

const ROLLOUT_FILE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
// session_meta carries the full base instructions, so the first line runs to tens of KB.
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 256 * 1024;
const INDEX_BYTES = 256 * 1024;
// session_meta names its source within its first KB, ahead of the instructions.
const META_PREFIX_BYTES = 4 * 1024;
const SUBAGENT_SOURCE = /"source":\{"subagent":/;

// Context Codex injects as user messages.
const INJECTED_USER_TEXT =
  /^\s*(<environment_context>|<user_instructions>|<turn_aborted>|# AGENTS\.md instructions)/;

const originFor = (originator: string | null, source: unknown): string | null => {
  if (originator === "Codex Desktop") return "Desktop";
  if (source === "vscode") return "VS Code";
  if (source === "cli" || originator === "codex_cli_rs") return "CLI";
  if (source === "exec") return "Exec";
  return originator;
};

const toolDetail = (name: string, payload: Record<string, unknown>): string | null => {
  const input = asString(payload.input);
  if (input !== null) return name === "apply_patch" ? patchFiles(input) : input;
  const args = parseJsonObject(asString(payload.arguments) ?? "");
  if (args === null) return null;
  const command = args.cmd ?? args.command;
  if (Array.isArray(command)) return command.filter((part) => typeof part === "string").join(" ");
  return asString(command) ?? asString(args.path) ?? asString(args.query);
};

const patchFiles = (patch: string): string =>
  [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]).join(", ");

/** Per-turn settings from `turn_context`; each read keeps the latest. */
interface TurnSettings {
  model: string | null;
  effort: string | null;
  approval: string | null;
  sandbox: string | null;
}

const readTurnContext = (payload: Record<string, unknown> | null, into: TurnSettings) => {
  into.model = asString(payload?.model) ?? into.model;
  into.effort = asString(payload?.effort) ?? into.effort;
  into.approval = asString(payload?.approval_policy) ?? into.approval;
  into.sandbox = asString(asRecord(payload?.sandbox_policy)?.type) ?? into.sandbox;
};

interface CodexHead {
  readonly id: string;
  readonly cwd: string | null;
  readonly origin: string | null;
  readonly firstPrompt: string | null;
  /** The first turn's settings, for a tail that holds no turn_context. */
  readonly turn: Readonly<TurnSettings>;
  readonly createdAt: string | null;
  readonly version: string | null;
  /** Codex records the branch once, when the session starts. */
  readonly gitBranch: string | null;
}

export const makeCodexSource = (): ExternalSessionSource => {
  const home = NodePath.join(NodeOS.homedir(), ".codex");
  const sessions = NodePath.join(home, "sessions");
  const index = NodePath.join(home, "session_index.jsonl");

  const threadName = (id: string) =>
    Effect.map(readLines(index, { fromEnd: true, maxBytes: INDEX_BYTES }), (slice) => {
      let name: string | null = null;
      for (const line of slice?.lines ?? []) {
        if (!line.includes(id)) continue;
        const record = parseJsonObject(line);
        if (record?.id === id) name = asString(record.thread_name) ?? name;
      }
      return name;
    });

  // A rollout's head never changes once its first prompt is written.
  const heads = new Map<string, CodexHead>();
  const readHead = (path: string) =>
    Effect.gen(function* () {
      const cached = heads.get(path);
      if (cached !== undefined) return cached;
      // Most rollouts are subagents; skip them before the large head read.
      const prefix = yield* readPrefix(path, META_PREFIX_BYTES);
      if (prefix !== null && SUBAGENT_SOURCE.test(prefix)) return "hidden" as const;
      const slice = yield* readLines(path, { maxBytes: HEAD_BYTES });
      const meta = asRecord(parseJsonObject(slice?.lines[0] ?? "")?.payload);
      if (slice === null || meta === null) return null;
      const originator = asString(meta.originator);
      // Subagent threads belong to their parent; T3 renders its own Codex sessions.
      if (asRecord(meta.source)?.subagent !== undefined) return "hidden" as const;
      if (originator?.toLowerCase().includes("t3code")) return "hidden" as const;
      const id = asString(meta.id) ?? ROLLOUT_FILE.exec(NodePath.basename(path))?.[1] ?? null;
      if (id === null) return null;
      let firstPrompt: string | null = null;
      let turn: TurnSettings | null = null;
      for (const line of slice.lines) {
        const record = parseJsonObject(line);
        const payload = asRecord(record?.payload);
        if (record?.type === "turn_context" && turn === null) {
          turn = { model: null, effort: null, approval: null, sandbox: null };
          readTurnContext(payload, turn);
        }
        if (firstPrompt !== null || payload?.type !== "message" || payload.role !== "user")
          continue;
        const text = contentText(payload.content, ["input_text"]);
        if (text.trim() !== "" && !INJECTED_USER_TEXT.test(text)) firstPrompt = text;
      }
      const head: CodexHead = {
        id,
        cwd: asString(meta.cwd),
        origin: originFor(originator, meta.source),
        firstPrompt,
        turn: turn ?? { model: null, effort: null, approval: null, sandbox: null },
        createdAt: asString(meta.timestamp),
        version: asString(meta.cli_version),
        gitBranch: branchName(asRecord(meta.git)?.branch),
      };
      if (firstPrompt !== null || slice.size > HEAD_BYTES) {
        if (heads.size > 1_000) heads.clear();
        heads.set(path, head);
      }
      return head;
    });

  return {
    driver: "codex",
    roots: [{ path: sessions, recursive: true }],
    sessionPathsFor: (changed) =>
      Effect.succeed(ROLLOUT_FILE.test(NodePath.basename(changed)) ? [changed] : []),
    // A rollout stays in the folder of the day it started, so a thread started
    // weeks ago and used today sits in an old folder: check every file's mtime.
    discover: (sinceMs) =>
      Effect.gen(function* () {
        const found: Array<string> = [];
        for (const year of yield* listDirectory(sessions)) {
          for (const month of yield* listDirectory(NodePath.join(sessions, year))) {
            for (const day of yield* listDirectory(NodePath.join(sessions, year, month))) {
              const dir = NodePath.join(sessions, year, month, day);
              for (const name of yield* listDirectory(dir)) {
                if (!ROLLOUT_FILE.test(name)) continue;
                const path = NodePath.join(dir, name);
                const mtime = yield* statMtimeMs(path);
                if (mtime !== null && mtime >= sinceMs) found.push(path);
              }
            }
          }
        }
        return found;
      }),
    summarize: (path) =>
      Effect.gen(function* () {
        const head = yield* readHead(path);
        if (head === null || head === "hidden") return head ?? [];
        const tail = yield* readLines(path, { fromEnd: true, maxBytes: TAIL_BYTES });
        if (tail === null) return [];
        const turn: TurnSettings = { ...head.turn };
        let tokens: Record<string, unknown> | null = null;
        let busy = false;
        for (const line of tail.lines) {
          const record = parseJsonObject(line);
          const payload = asRecord(record?.payload);
          if (record?.type === "turn_context") readTurnContext(payload, turn);
          if (payload?.type === "token_count") tokens = asRecord(payload.info) ?? tokens;
          if (payload?.type === "task_started") busy = true;
          if (payload?.type === "task_complete" || payload?.type === "turn_aborted") busy = false;
        }
        return [
          {
            id: head.id,
            title: firstLine(
              (yield* threadName(head.id)) ?? head.firstPrompt ?? "Untitled session",
            ),
            cwd: head.cwd,
            model: turn.model,
            origin: head.origin,
            updatedAtMs: tail.mtimeMs,
            busy,
            details: sessionDetails(head.id, {
              effort: turn.effort,
              gitBranches: head.gitBranch === null ? null : [head.gitBranch],
              version: head.version,
              approval: turn.approval,
              sandbox: turn.sandbox,
              createdAt: head.createdAt,
              // Counted the way the Codex adapter counts context.
              contextTokens: asCount(asRecord(tokens?.last_token_usage)?.total_tokens),
              contextWindow: asCount(tokens?.model_context_window),
              totalTokens: asCount(asRecord(tokens?.total_token_usage)?.total_tokens),
            }),
          },
        ];
      }),
    transcriptPath: (path) => path,
    createParser: () => {
      let counter = 0;
      return {
        push: (line) => {
          const record = parseJsonObject(line);
          const payload = asRecord(record?.payload);
          if (record?.type !== "response_item" || payload === null) return [];
          const id = asString(payload.id) ?? asString(payload.call_id) ?? `codex-${counter++}`;
          const createdAt = isoTimestamp(record.timestamp);
          const out: Array<ExternalSessionMessage> = [];
          if (payload.type === "message") {
            if (payload.role === "user") {
              const text = contentText(payload.content, ["input_text"]).trim();
              if (text !== "" && !INJECTED_USER_TEXT.test(text)) {
                out.push({ id, role: "user", text: clipMessage(text), createdAt });
              }
            } else if (payload.role === "assistant") {
              const text = contentText(payload.content, ["output_text"]).trim();
              if (text !== "")
                out.push({ id, role: "assistant", text: clipMessage(text), createdAt });
            }
          } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
            const name = asString(payload.name) ?? "tool";
            out.push({
              id,
              role: "tool",
              text: toolLine(name, toolDetail(name, payload)),
              createdAt,
            });
          }
          return out;
        },
      };
    },
  };
};
