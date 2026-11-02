/**
 * Turns an OpenBot conversation's rows into the entries of its T3 thread, and
 * each entry into the events that write it. Keys are OpenBot's message ids, so
 * a re-sync writes only what is new. Fork add-on; see docs/internals/openbot.md.
 *
 * @module openbot/openbotEntries
 */
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { OpenBotDb } from "@t3tools/provider-openbot/server";
import * as DateTime from "effect/DateTime";

import { importedMessageEvents } from "../external-sessions/continueExternalSession.ts";

// A very long conversation keeps its first prompt and its newest entries.
const MAX_ENTRIES = 1_000;

export const conversationEntries = (
  rows: ReadonlyArray<OpenBotDb.OpenBotMessageRow>,
  names: ReadonlyMap<string, string>,
): OpenBotDb.OpenBotEntry[] => {
  const entries = rows
    .filter((row) => row.settled)
    .flatMap((row) => OpenBotDb.rowEntries(row, names));
  if (entries.length <= MAX_ENTRIES) return entries;
  const first = entries.findIndex((entry) => entry.kind === "message" && entry.role === "user");
  return first === -1 || first >= entries.length - MAX_ENTRIES
    ? entries.slice(-MAX_ENTRIES)
    : [entries[first]!, ...entries.slice(-(MAX_ENTRIES - 1))];
};

export const entryItemId = (prefix: string, threadId: ThreadId, key: string) =>
  TurnItemId.make(`${prefix}:turn-item:${threadId}:${key}`);

/** The events that write one entry into a thread, at `ordinal`. */
export function entryEvents(input: {
  readonly threadId: ThreadId;
  readonly prefix: string;
  readonly entry: OpenBotDb.OpenBotEntry;
  readonly ordinal: number;
  /** Keeps event ids unique when a thread is synced again. */
  readonly batch: string;
  readonly occurredAt: DateTime.Utc;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, prefix, entry, ordinal, batch, occurredAt } = input;
  const turnItemId = entryItemId(prefix, threadId, entry.key);
  const eventId = (kind: string) =>
    EventId.make(`${prefix}:${kind}:${threadId}:${entry.key}:${batch}`);
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
  const at = DateTime.makeUnsafe(entry.atMs);
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
    completedAt: at,
    updatedAt: at,
  };
  const payload: OrchestrationV2TurnItem =
    entry.kind === "reasoning"
      ? { ...common, type: "reasoning", text: entry.text, streaming: false }
      : entry.kind === "notice"
        ? { ...common, type: "system_notice", message: entry.text }
        : entry.command !== undefined
          ? {
              ...common,
              title: entry.title,
              type: "command_execution",
              input: entry.command,
              ...(entry.failed ? { outputIndicatesFailure: true } : {}),
            }
          : { ...common, title: entry.title, type: "dynamic_tool", toolName: entry.title, input: null };
  return [{ id: eventId("turn-item"), type: "turn-item.updated", threadId, occurredAt, payload }];
}
