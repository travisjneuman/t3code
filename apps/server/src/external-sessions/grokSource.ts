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

const SESSION_FILES = new Set(["summary.json", "events.jsonl", "updates.jsonl"]);
const EVENTS_TAIL_BYTES = 64 * 1024;

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
        return [
          {
            id,
            title: firstLine(
              asString(summary?.generated_title) ??
                asString(summary?.session_summary) ??
                "Untitled session",
            ),
            cwd: asString(info?.cwd) ?? decodeCwd(NodePath.basename(NodePath.dirname(path))),
            model,
            origin: summary?.session_kind === "headless" ? "Headless" : "CLI",
            updatedAtMs: Math.max(
              updatedMtime ?? 0,
              timestampMs(summary?.last_active_at, 0),
              events?.mtimeMs ?? 0,
            ),
            busy,
            details: sessionDetails(id, {
              effort: asString(summary?.reasoning_effort),
              // Yolo mode approves every tool call without asking.
              approval: yolo === true ? "yolo" : null,
              sandbox: asString(summary?.sandbox_profile),
              createdAt: asString(summary?.created_at),
              messageCount: asCount(summary?.num_chat_messages),
              totalTokens: asCount(usage?.totalTokens),
            }),
          },
        ];
      }),
    transcriptPath: (path) => NodePath.join(path, "updates.jsonl"),
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
