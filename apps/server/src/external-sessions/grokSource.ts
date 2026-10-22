/**
 * Grok CLI sessions: `~/.grok/sessions/<encoded cwd>/<session id>/`, with
 * `summary.json` for metadata, `events.jsonl` for turn state, and ACP
 * `updates.jsonl` for the streamed conversation.
 *
 * @module external-sessions/grokSource
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ExternalSessionMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  asCount,
  asRecord,
  asString,
  clipMessage,
  contentText,
  type ExternalSessionSource,
  firstLine,
  isoTimestamp,
  listDirectory,
  parseJsonObject,
  readLines,
  readText,
  sessionDetails,
  statMtimeMs,
  timestampMs,
  toolLine,
} from "./ExternalSessionSource.ts";
import { grokContextUsage, makeGrokInsights } from "./grokInsights.ts";

const SESSION_FILES = new Set(["summary.json", "events.jsonl", "updates.jsonl"]);
const EVENTS_TAIL_BYTES = 64 * 1024;
// Read only for a session Grok has not titled. Its first prompt follows the
// system prompt and reminders, which run to about 150 KB.
const CHAT_HISTORY_BYTES = 512 * 1024;
const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/;
// T3 Code wraps the typed request in its own instructions.
const USER_REQUEST = /<user_request>([\s\S]*?)<\/user_request>/;

/** A summary field, with blank treated as missing. */
const summaryText = (value: unknown): string | null => {
  const text = asString(value)?.trim() ?? "";
  return text === "" ? null : text;
};

/** The typed prompt in a `chat_history.jsonl` record; null for any other record. */
const promptText = (record: Record<string, unknown> | null): string | null => {
  if (record?.type !== "user" || asString(record.synthetic_reason) !== null) return null;
  const text = contentText(record.content, ["text"]);
  const query = USER_QUERY.exec(text)?.[1];
  // The first user record carries workspace info and rules, with no query.
  if (query === undefined && text.trimStart().startsWith("<user_info>")) return null;
  const prompt = (USER_REQUEST.exec(query ?? text)?.[1] ?? query ?? text).trim();
  return prompt === "" ? null : prompt;
};

const decodeCwd = (encoded: string): string | null => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
};

export const makeGrokSource = (): ExternalSessionSource => {
  const sessions = NodePath.join(NodeOS.homedir(), ".grok", "sessions");

  return {
    driver: "grok",
    // A folder per session.
    sessionFiles: (path) => [path],
    roots: [{ path: sessions, recursive: true }],
    sessionPathsFor: (changed) => {
      const dir = NodePath.dirname(changed);
      return Effect.succeed(
        SESSION_FILES.has(NodePath.basename(changed)) &&
          NodePath.dirname(NodePath.dirname(dir)) === sessions
          ? [dir]
          : [],
      );
    },
    discover: (sinceMs) =>
      Effect.gen(function* () {
        const found: Array<string> = [];
        for (const cwdDir of yield* listDirectory(sessions)) {
          const cwdPath = NodePath.join(sessions, cwdDir);
          for (const id of yield* listDirectory(cwdPath)) {
            const path = NodePath.join(cwdPath, id);
            const mtime = yield* statMtimeMs(NodePath.join(path, "updates.jsonl"));
            if (mtime !== null && mtime >= sinceMs) found.push(path);
          }
        }
        return found;
      }),
    summarize: (path) =>
      Effect.gen(function* () {
        const summary = parseJsonObject(
          (yield* readText(NodePath.join(path, "summary.json"))) ?? "",
        );
        const info = asRecord(summary?.info);
        const id = asString(info?.id) ?? NodePath.basename(path);
        const events = yield* readLines(NodePath.join(path, "events.jsonl"), {
          fromEnd: true,
          maxBytes: EVENTS_TAIL_BYTES,
        });
        let model = asString(summary?.current_model_id);
        let busy = false;
        let yolo: boolean | null = null;
        for (const line of events?.lines ?? []) {
          const record = parseJsonObject(line);
          if (record?.type === "turn_started") {
            busy = true;
            model = asString(record.model_id) ?? model;
            if (typeof record.yolo_mode === "boolean") yolo = record.yolo_mode;
          }
          if (record?.type === "turn_ended") busy = false;
        }
        const updatedMtime = yield* statMtimeMs(NodePath.join(path, "updates.jsonl"));
        if (summary === null && updatedMtime === null) return [];
        const usage = asRecord(
          parseJsonObject((yield* readText(NodePath.join(path, "usage.json"))) ?? "")?.session,
        );
        const signals = parseJsonObject(
          (yield* readText(NodePath.join(path, "signals.json"))) ?? "",
        );
        let title = summaryText(summary?.generated_title) ?? summaryText(summary?.session_summary);
        let empty = false;
        if (title === null) {
          const chat = yield* readLines(NodePath.join(path, "chat_history.jsonl"), {
            maxBytes: CHAT_HISTORY_BYTES,
          });
          for (const line of chat?.lines ?? []) {
            title = promptText(parseJsonObject(line));
            if (title !== null) break;
          }
          // A launch with no prompt yet holds only the system prompt and reminders.
          // A history cut short may hold the prompt past the read.
          empty = title === null && chat !== null && chat.size <= CHAT_HISTORY_BYTES;
        }
        return [
          {
            id,
            title: firstLine(title ?? "Untitled session"),
            cwd: asString(info?.cwd) ?? decodeCwd(NodePath.basename(NodePath.dirname(path))),
            model,
            origin: summary?.session_kind === "headless" ? "Headless" : "CLI",
            updatedAtMs: Math.max(
              updatedMtime ?? 0,
              timestampMs(summary?.last_active_at, 0),
              events?.mtimeMs ?? 0,
            ),
            busy,
            ...(empty ? { empty: true as const } : {}),
            details: sessionDetails(id, {
              effort: asString(summary?.reasoning_effort),
              // Yolo mode approves every tool call without asking.
              approval: yolo === true ? "yolo" : null,
              sandbox: asString(summary?.sandbox_profile),
              createdAt: asString(summary?.created_at),
              messageCount: asCount(summary?.num_chat_messages),
              totalTokens: asCount(usage?.totalTokens),
              ...grokContextUsage(signals),
            }),
          },
        ];
      }),
    transcriptPath: (path) => NodePath.join(path, "updates.jsonl"),
    readInsights: makeGrokInsights(),
    createParser: () => {
      let counter = 0;
      // Chunks of one reply arrive as separate lines; they grow one message.
      let current: {
        id: string;
        role: "user" | "assistant";
        text: string;
        createdAt: string;
      } | null = null;
      return {
        push: (line) => {
          const record = parseJsonObject(line);
          const update = asRecord(asRecord(record?.params)?.update);
          const kind = asString(update?.sessionUpdate);
          if (record === null || update === null || kind === null) return [];
          const createdAt = isoTimestamp(record.timestamp);
          if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
            const content = asRecord(update.content);
            if (content?.type !== "text") return [];
            const text = asString(content.text) ?? "";
            const role = kind === "user_message_chunk" ? "user" : "assistant";
            if (current?.role !== role) {
              current = { id: `grok-${counter++}`, role, text: "", createdAt };
            }
            current.text += text;
            const trimmed = current.text.trim();
            return trimmed === ""
              ? []
              : [
                  {
                    id: current.id,
                    role,
                    text: clipMessage(trimmed),
                    createdAt: current.createdAt,
                  },
                ];
          }
          if (kind === "tool_call") {
            current = null;
            const message: ExternalSessionMessage = {
              id: asString(update.toolCallId) ?? `grok-${counter++}`,
              role: "tool",
              text: toolLine(asString(update.title) ?? "tool", null),
              createdAt,
            };
            return [message];
          }
          if (kind === "turn_completed") current = null;
          return [];
        },
      };
    },
  };
};
