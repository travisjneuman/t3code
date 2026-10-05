/**
 * Pi coding agent sessions: `~/.pi/agent/sessions/<dashed cwd>/<time>_<id>.jsonl`.
 *
 * @module external-sessions/piSource
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
  sessionDetails,
  statMtimeMs,
  toolLine,
} from "./ExternalSessionSource.ts";

const SESSION_FILE = /^.+_([0-9a-f-]{36})\.jsonl$/i;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

const toolDetail = (args: unknown): string | null => {
  const record = asRecord(args);
  if (record === null) return null;
  return asString(record.command) ?? asString(record.path) ?? asString(record.pattern);
};

export const makePiSource = (): ExternalSessionSource => {
  const sessions = NodePath.join(NodeOS.homedir(), ".pi", "agent", "sessions");

  return {
    driver: "pi",
    roots: [{ path: sessions, recursive: true }],
    sessionPathsFor: (changed) =>
      Effect.succeed(
        SESSION_FILE.test(NodePath.basename(changed)) &&
          NodePath.dirname(NodePath.dirname(changed)) === sessions
          ? [changed]
          : [],
      ),
    discover: (sinceMs) =>
      Effect.gen(function* () {
        const found: Array<string> = [];
        for (const dir of yield* listDirectory(sessions)) {
          const dirPath = NodePath.join(sessions, dir);
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
        let id = SESSION_FILE.exec(NodePath.basename(path))?.[1] ?? null;
        let cwd: string | null = null;
        let name: string | null = null;
        let firstPrompt: string | null = null;
        let model: string | null = null;
        let createdAt: string | null = null;
        let thinkingLevel: string | null = null;
        let contextTokens: number | null = null;
        const lines = tail === head ? head.lines : [...head.lines, ...(tail?.lines ?? [])];
        for (const line of lines) {
          const record = parseJsonObject(line);
          if (record === null) continue;
          if (record.type === "session") {
            id = asString(record.id) ?? id;
            cwd = asString(record.cwd) ?? cwd;
            createdAt = asString(record.timestamp) ?? createdAt;
          } else if (record.type === "session_info") {
            name = asString(record.name) ?? name;
          } else if (record.type === "model_change") {
            model = asString(record.modelId) ?? model;
          } else if (record.type === "thinking_level_change") {
            thinkingLevel = asString(record.thinkingLevel) ?? thinkingLevel;
          } else if (record.type === "message") {
            const message = asRecord(record.message);
            if (message?.role === "assistant") {
              model = asString(message.model) ?? model;
              thinkingLevel = asString(message.thinkingLevel) ?? thinkingLevel;
              // Counted the way the Pi adapter counts context.
              contextTokens = asCount(asRecord(message.usage)?.totalTokens) ?? contextTokens;
            }
            if (firstPrompt === null && message?.role === "user") {
              firstPrompt = contentText(message.content, ["text"]).trim() || null;
            }
          }
        }
        if (id === null) return [];
        return [
          {
            id,
            title: firstLine(name ?? firstPrompt ?? "Untitled session"),
            cwd,
            model,
            origin: "CLI",
            updatedAtMs: head.mtimeMs,
            busy: false,
            details: sessionDetails(id, { effort: thinkingLevel, createdAt, contextTokens }),
          },
        ];
      }),
    transcriptPath: (path) => path,
    createParser: () => ({
      push: (line) => {
        const record = parseJsonObject(line);
        const message = asRecord(record?.message);
        const id = asString(record?.id);
        if (record?.type !== "message" || message === null || id === null) return [];
        const createdAt = isoTimestamp(record.timestamp);
        if (message.role === "user") {
          const text = contentText(message.content, ["text"]).trim();
          return text === "" ? [] : [{ id, role: "user", text: clipMessage(text), createdAt }];
        }
        if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
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
          } else if (value?.type === "toolCall") {
            out.push({
              id: `${id}:${index}`,
              role: "tool",
              text: toolLine(asString(value.name) ?? "tool", toolDetail(value.arguments)),
              createdAt,
            });
          }
        });
        return out;
      },
    }),
  };
};
