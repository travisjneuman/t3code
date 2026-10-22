/**
 * Turns a Hermes session's stored messages into the entries of its T3 thread:
 * user and assistant text, reasoning, and each tool call with its result,
 * the way a live Hermes turn shows them. Each entry's key is stable across
 * syncs, so a re-sync writes only what is new. Fork add-on; see
 * docs/internals/hermes.md.
 *
 * @module hermes/hermesSessionEntries
 */
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { HermesApi } from "@t3tools/provider-hermes/server";
import * as DateTime from "effect/DateTime";

import { importedMessageEvents } from "../external-sessions/continueExternalSession.ts";

/** Same split as the live adapter: shell-like tools render as commands. */
const TOOL_AS_COMMAND = /terminal|shell|bash|exec/i;
// Keeps one chatty tool from bloating the thread; Hermes keeps the full output.
const MAX_TOOL_OUTPUT_CHARS = 20_000;
// A very long session keeps its first prompt and its newest entries.
const MAX_ENTRIES = 1_000;

export type HermesSessionEntry =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly atMs: number;
      readonly role: "user" | "assistant";
      readonly text: string;
    }
  | {
      readonly kind: "reasoning";
      readonly key: string;
      readonly atMs: number;
      readonly text: string;
    }
  | { readonly kind: "notice"; readonly key: string; readonly atMs: number; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly atMs: number;
      readonly completedAtMs: number;
      readonly name: string;
      readonly input: unknown;
      readonly output: unknown;
      readonly failed: boolean;
      readonly exitCode: number | undefined;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Hermes stores times as epoch seconds; T3 speaks milliseconds. */
export const toMs = (value: number | null) =>
  value === null ? 0 : value < 1e12 ? value * 1000 : value;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const capped = (text: string) =>
  text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated; the full output is in Hermes)`
    : text;

function toolEntry(
  call: HermesApi.HermesToolCall,
  atMs: number,
  result: HermesApi.HermesMessage | undefined,
): HermesSessionEntry {
  const command = TOOL_AS_COMMAND.test(call.name);
  const args = parseJson(call.arguments);
  const parsed = result === undefined ? undefined : parseJson(result.content);
  const body = isRecord(parsed) ? parsed : {};
  const exitCode =
    typeof body.exit_code === "number" && Number.isInteger(body.exit_code)
      ? body.exit_code
      : undefined;
  const failed =
    (exitCode !== undefined && exitCode !== 0) ||
    body.status === "error" ||
    body.success === false ||
    (typeof body.error === "string" && body.error.length > 0);
  const raw = result?.content ?? "";
  const output =
    result === undefined
      ? undefined
      : command
        ? capped(typeof body.output === "string" ? body.output : raw)
        : raw.length <= MAX_TOOL_OUTPUT_CHARS && parsed !== undefined
          ? parsed
          : capped(raw);
  return {
    kind: "tool",
    key: `t${call.id}`,
    atMs,
    completedAtMs:
      result === undefined || result.timestamp === null ? atMs : toMs(result.timestamp),
    name: call.name,
    input: command
      ? isRecord(args) && typeof args.command === "string"
        ? args.command
        : call.arguments
      : (args ?? call.arguments),
    output,
    failed,
    exitCode,
  };
}

/**
 * A session's entries, oldest first. A tool call whose result has not
 * arrived yet is left out until it has, unless the session has ended.
 */
export function sessionEntries(
  messages: ReadonlyArray<HermesApi.HermesMessage>,
  options: { readonly ended: boolean; readonly fallbackMs: number },
): HermesSessionEntry[] {
  // Compression carries a session's last tool calls and their results into the
  // next segment under the same call ids; the first copy is the original.
  const results = new Map<string, HermesApi.HermesMessage>();
  for (const message of messages) {
    if (
      message.role === "tool" &&
      message.toolCallId !== null &&
      !results.has(message.toolCallId)
    ) {
      results.set(message.toolCallId, message);
    }
  }
  const shownCalls = new Set<string>();
  const entries: HermesSessionEntry[] = [];
  let lastMs = options.fallbackMs;
  for (const message of messages) {
    const atMs = message.timestamp === null ? lastMs : toMs(message.timestamp);
    lastMs = atMs;
    if (message.role === "user" && message.content.trim()) {
      entries.push({
        kind: "message",
        key: `m${message.id}`,
        atMs,
        role: "user",
        text: message.content,
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    if (message.reasoning?.trim()) {
      entries.push({ kind: "reasoning", key: `r${message.id}`, atMs, text: message.reasoning });
    }
    if (message.content.trim()) {
      entries.push({
        kind: "message",
        key: `m${message.id}`,
        atMs,
        role: "assistant",
        text: message.content,
      });
    }
    for (const call of message.toolCalls) {
      if (shownCalls.has(call.id)) continue;
      const result = results.get(call.id);
      if (result === undefined && !options.ended) continue;
      shownCalls.add(call.id);
      entries.push(toolEntry(call, atMs, result));
    }
  }
  if (entries.length <= MAX_ENTRIES) return entries;
  const first = entries.findIndex((entry) => entry.kind === "message" && entry.role === "user");
  return first === -1 || first >= entries.length - MAX_ENTRIES
    ? entries.slice(-MAX_ENTRIES)
    : [entries[first]!, ...entries.slice(-(MAX_ENTRIES - 1))];
}

/** The events that write one entry into a thread, at `ordinal`. */
export function entryEvents(input: {
  readonly threadId: ThreadId;
  readonly prefix: string;
  readonly entry: HermesSessionEntry;
  readonly ordinal: number;
  /** Keeps event ids unique when a thread is synced again. */
  readonly batch: string;
  readonly occurredAt: DateTime.Utc;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, prefix, entry, ordinal, batch, occurredAt } = input;
  const turnItemId = entryItemId(prefix, threadId, entry.key);
  const eventId = (kind: string) =>
    EventId.make(`${prefix}:${kind}:${threadId}:${entry.key}:${batch}`);
  const at = DateTime.makeUnsafe(entry.atMs);
  if (entry.kind === "message") {
    return importedMessageEvents({
      threadId,
      messageId: MessageId.make(`${threadId}:${entry.key}`),
      turnItemId,
      eventId,
      ordinal,
      message: {
        role: entry.role,
        text: entry.text,
        createdAt: new Date(entry.atMs).toISOString(),
      },
      occurredAt,
    });
  }
  const completedAt = entry.kind === "tool" ? DateTime.makeUnsafe(entry.completedAtMs) : at;
  const common = {
    id: turnItemId,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: entry.kind === "tool" && entry.failed ? ("failed" as const) : ("completed" as const),
    title: null,
    startedAt: at,
    completedAt,
    updatedAt: completedAt,
  };
  const payload: OrchestrationV2TurnItem =
    entry.kind === "reasoning"
      ? { ...common, type: "reasoning", text: entry.text, streaming: false }
      : entry.kind === "notice"
        ? { ...common, type: "system_notice", message: entry.text }
        : TOOL_AS_COMMAND.test(entry.name)
          ? {
              ...common,
              title: entry.name,
              type: "command_execution",
              input: typeof entry.input === "string" ? entry.input : JSON.stringify(entry.input),
              ...(typeof entry.output === "string" ? { output: entry.output } : {}),
              ...(entry.failed ? { outputIndicatesFailure: true } : {}),
              ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
            }
          : {
              ...common,
              title: entry.name,
              type: "dynamic_tool",
              toolName: entry.name.trim() || null,
              input: entry.input,
              ...(entry.output === undefined ? {} : { output: entry.output }),
            };
  return [{ id: eventId("turn-item"), type: "turn-item.updated", threadId, occurredAt, payload }];
}

export const entryItemId = (prefix: string, threadId: ThreadId, key: string) =>
  TurnItemId.make(`${prefix}:turn-item:${threadId}:${key}`);

// ── Cron reports ──────────────────────────────────────────────────────

const CRON_SESSION = /^cron_(.+)_(\d{8})_(\d{6})$/;
const CRON_OUTPUT_FILE = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)\.md$/;

/** A cron session id's job and its local start stamp (`YYYYMMDDHHMMSS`). */
export function cronSessionOf(sessionId: string) {
  const match = CRON_SESSION.exec(sessionId);
  return match ? { jobId: match[1]!, stamp: `${match[2]}${match[3]}` } : undefined;
}

/** An output doc's stamp, in the same form as a session's. */
export function cronOutputStamp(fileName: string) {
  const match = CRON_OUTPUT_FILE.exec(fileName);
  return match ? match.slice(1, 7).join("") : undefined;
}

/** Milliseconds between two stamps; both are the Hermes host's local time. */
export function stampDeltaMs(from: string, to: string) {
  const ms = (stamp: string) =>
    Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14)),
    );
  return ms(to) - ms(from);
}

/** The delivered text of a cron output doc: what follows its last `## Response`. */
export function cronReportText(doc: string) {
  const marker = doc.lastIndexOf("## Response");
  return (marker === -1 ? doc : doc.slice(marker + "## Response".length)).trim();
}

/** "Delivered to Discord" for `discord:…`; a saved report for `local`. */
export function cronDeliveryNotice(deliver: string | null) {
  const platform = deliver?.split(":")[0]?.trim();
  if (!platform || platform === "local") return "Cron report saved in Hermes";
  return `Delivered to ${platform[0]!.toUpperCase()}${platform.slice(1)}`;
}
