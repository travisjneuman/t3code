/**
 * Keeps a continued thread in step with the other app that shares its native
 * session. T3's own turns already land in the native transcript, since the
 * provider resumes the same session in place. This module covers the other
 * direction: messages the other app appends after continue are added to the
 * thread, after the T3 run they followed, and T3's idle provider session is
 * detached so its next turn resumes from disk instead of a stale process.
 *
 * Entries are told apart by time: whatever falls outside every T3 run and
 * provider turn window came from the other app. Codex entries also carry turn
 * ids, which match T3's provider turns directly. The cursor per thread lives
 * in `<state dir>/external-sessions-sync.json`. Fork add-on; see
 * docs/internals/external-sessions.md.
 *
 * @module external-sessions/externalSessionSync
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import {
  type ContinueDriver,
  type ContinueSyncStart,
  importedMessageEvents,
  isContinueDriver,
} from "./continueExternalSession.ts";
import {
  asRecord,
  asString,
  listDirectory,
  parseJsonObject,
  type TranscriptParser,
} from "./ExternalSessionSource.ts";

const STATE_FILE = "external-sessions-sync.json";
const EVENT_PREFIX = "external-session-sync";
// Batches a burst of writes (a streamed reply) into one pass.
const DEBOUNCE = "600 millis";
const STARTUP_DELAY = "5 seconds";
// Picks up archive, unarchive, and delete of tracked threads.
const REFRESH_INTERVAL = "5 minutes";
const TICK = "5 seconds";
// While a T3 run is active, the pass waits and tries again.
const RETRY_MS = 5_000;
// Fallback for a missed or failed directory watch.
const STAT_EVERY_MS = 30_000;
// Bytes read per pass; a larger backlog continues in the next pass.
const PASS_BYTES = 8 * 1024 * 1024;
// Run times come from the server, transcript times from the provider process.
const WINDOW_LEAD_MS = 2_000;
const WINDOW_TRAIL_MS = 5_000;
// A queued run is requested long before it starts; its turn starts with it.
const QUEUE_LEAD_MS = 30_000;
const RUNNING_ELSEWHERE_MS = 60_000;
// A Codex turn the other app opened and has not closed, while it keeps writing.
const OPEN_TURN_MS = 10 * 60_000;

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const NEWLINE = 0x0a;
const decoder = new TextDecoder();
const PI_SESSION_FILE = /_([0-9a-f-]{36})\.jsonl$/i;

const SyncEntry = Schema.Struct({
  driver: Schema.Literals(["claudeAgent", "codex", "grok", "pi"]),
  /** The native session id, as in the thread id. */
  sessionId: Schema.String,
  transcriptPath: Schema.String,
  /** Everything before this byte offset is synced; always a line start. */
  offset: Schema.Number,
  /** Codex: the turn still open at `offset`. */
  codexTurnId: Schema.optional(Schema.String),
});
type SyncEntry = typeof SyncEntry.Type;

const SyncState = Schema.Struct({
  version: Schema.Literal(1),
  threads: Schema.Record(Schema.String, SyncEntry),
});
const decodeSyncState = Schema.decodeUnknownOption(Schema.fromJsonString(SyncState));

export interface ExternalSessionSync {
  /** Starts syncing a thread continue just created. */
  readonly register: (start: ContinueSyncStart) => Effect.Effect<void>;
  /** Continued threads the other app is working in right now. */
  readonly runningElsewhere: Stream.Stream<ReadonlyArray<ThreadId>>;
}

interface Tracked {
  /** Messages at or after the cursor already written, by stable id: Grok grows them in place. */
  readonly written: Map<string, { readonly offset: number; readonly text: string }>;
  lastSeenSize: number;
  lastStatMs: number;
  retryAt: number | null;
  lastExternalMs: number;
  externalTurnOpen: boolean;
}

interface Line {
  readonly offset: number;
  readonly text: string;
}

interface Appended {
  readonly size: number;
  readonly lines: ReadonlyArray<Line>;
  /** Just after the last complete line read or skipped. */
  readonly end: number;
  /** Bytes past the read window remain. */
  readonly more: boolean;
}

interface ParsedMessage {
  readonly stableId: string;
  readonly offset: number;
  readonly role: "user" | "assistant";
  text: string;
  readonly atMs: number | null;
  readonly turn: string | null;
}

interface Parsed {
  readonly messages: ReadonlyArray<ParsedMessage>;
  readonly marks: ReadonlyArray<{ readonly atMs: number | null; readonly turn: string | null }>;
  /** Claude: the newest main-chain entry read. */
  readonly claudeLeaf: string | null;
  /** Codex: the turn open after the last line read. */
  readonly openTurn: string | null;
  /** Where the next pass starts: the end, or the start of a Grok message still growing. */
  readonly safePoint: number;
}

interface Window {
  readonly start: number;
  readonly end: number;
}

/** Epoch ms from an ISO string or epoch seconds or ms (Grok writes seconds). */
const timeOf = (value: unknown): number | null => {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : null;
  if (numeric !== null) {
    if (!Number.isFinite(numeric)) return null;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const splitLines = (bytes: Uint8Array, base: number): ReadonlyArray<Line> => {
  const lines: Array<Line> = [];
  let start = 0;
  for (;;) {
    const newline = bytes.indexOf(NEWLINE, start);
    if (newline === -1) break;
    const text = decoder.decode(bytes.subarray(start, newline)).replace(/\r$/, "");
    if (text.length > 0) lines.push({ offset: base + start, text });
    start = newline + 1;
  }
  return lines;
};

/** Complete lines from `from`, at most PASS_BYTES; a line longer than that is skipped. */
const readAppended = (path: string, from: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(path, { flag: "r" });
      const size = Number((yield* file.stat).size);
      let start = from;
      let position = from;
      let skipping = false;
      for (;;) {
        const length = Math.min(PASS_BYTES, size - position);
        // Nothing complete yet; an oversized line still being written is read again later.
        if (length <= 0) {
          return { size, lines: [], end: skipping ? from : start, more: false } satisfies Appended;
        }
        yield* file.seek(BigInt(position), "start");
        const buffer = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const read = yield* file.read(buffer.subarray(filled));
          if (read === 0) break;
          filled += read;
        }
        const bytes = buffer.subarray(0, filled);
        if (skipping) {
          const newline = bytes.indexOf(NEWLINE);
          if (newline === -1) {
            if (filled < length) return { size, lines: [], end: from, more: false };
            position += filled;
            continue;
          }
          start = position + newline + 1;
          position = start;
          skipping = false;
          continue;
        }
        const last = bytes.lastIndexOf(NEWLINE);
        if (last === -1) {
          if (filled < PASS_BYTES) {
            return { size, lines: [], end: start, more: false } satisfies Appended;
          }
          skipping = true;
          position += filled;
          continue;
        }
        const end = position + last + 1;
        return {
          size,
          lines: splitLines(bytes.subarray(0, last + 1), position),
          end,
          more: position + filled < size,
        } satisfies Appended;
      }
    }),
  ).pipe(Effect.orElseSucceed(() => null));

/**
 * Messages and per-line attribution data from appended lines. The parser is
 * fresh at the cursor, so messages get ids from the line they first appear
 * on, stable across passes.
 */
const parseLines = (
  driver: ContinueDriver,
  parser: TranscriptParser,
  lines: ReadonlyArray<Line>,
  end: number,
  codexTurnAtStart: string | null,
): Parsed => {
  const byParserId = new Map<string, ParsedMessage>();
  const marks: Array<{ atMs: number | null; turn: string | null }> = [];
  let claudeLeaf: string | null = null;
  let openTurn = codexTurnAtStart;
  let grokRole: string | null = null;
  let grokOpenStart: number | null = null;
  for (const line of lines) {
    const record = parseJsonObject(line.text);
    if (record === null) continue;
    const atMs = timeOf(record.timestamp);
    let turn = openTurn;
    if (driver === "codex") {
      const payload = asRecord(record.payload);
      const kind = asString(payload?.type);
      const turnId = asString(payload?.turn_id);
      if (record.type === "event_msg" && kind === "task_started" && turnId !== null) {
        openTurn = turnId;
        turn = turnId;
      } else if (record.type === "turn_context" && turnId !== null) {
        openTurn = turnId;
        turn = turnId;
      } else if (
        record.type === "event_msg" &&
        (kind === "task_complete" || kind === "turn_aborted")
      ) {
        turn = turnId ?? openTurn;
        openTurn = null;
      }
    } else if (driver === "claudeAgent") {
      if (record.isSidechain !== true && (record.type === "user" || record.type === "assistant")) {
        claudeLeaf = asString(record.uuid) ?? claudeLeaf;
      }
      // Compaction summaries and transcript-only notes are not conversation.
      if (record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) continue;
    } else if (driver === "grok") {
      // Mirrors grokSource's parser: a role change opens a message, a tool call or turn end closes it.
      const update = asRecord(asRecord(record.params)?.update);
      const kind = asString(update?.sessionUpdate);
      if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
        if (asRecord(update?.content)?.type === "text") {
          const role = kind === "user_message_chunk" ? "user" : "assistant";
          if (grokRole !== role) {
            grokRole = role;
            grokOpenStart = line.offset;
          }
        }
      } else if (kind === "tool_call" || kind === "turn_completed") {
        grokRole = null;
        grokOpenStart = null;
      }
    }
    marks.push({ atMs, turn });
    parser.push(line.text).forEach((message, index) => {
      if (message.role === "tool") return;
      const existing = byParserId.get(message.id);
      if (existing !== undefined) {
        existing.text = message.text;
        return;
      }
      byParserId.set(message.id, {
        stableId: `${line.offset}:${index}`,
        offset: line.offset,
        role: message.role,
        text: message.text,
        atMs,
        turn,
      });
    });
  }
  return {
    messages: [...byParserId.values()],
    marks,
    claudeLeaf,
    openTurn,
    safePoint: driver === "grok" && grokOpenStart !== null ? grokOpenStart : end,
  };
};

export const make = (parserFor: (driver: ContinueDriver) => TranscriptParser) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const withLock = lock.withPermits(1);
    const provideFs = Effect.provideService(FileSystem.FileSystem, fileSystem);
    const statePath = NodePath.join(config.stateDir, STATE_FILE);

    // Entries outlive tracking: an archived thread keeps its cursor for unarchive.
    const entries = new Map<string, SyncEntry>();
    const tracked = new Map<string, Tracked>();
    const unresolvable = new Set<string>();
    const dirty = new Set<string>();
    const wake = yield* Queue.sliding<void>(1);
    const running = yield* SubscriptionRef.make<ReadonlyArray<ThreadId>>([]);
    const watchers = new Map<
      string,
      { readonly fiber: Fiber.Fiber<void>; readonly threads: Set<string> }
    >();
    let nonce = 0;
    const nextNonce = () => `${Date.now().toString(36)}-${(nonce++).toString(36)}`;

    const stored = yield* fileSystem.readFileString(statePath).pipe(Effect.option);
    if (Option.isSome(stored)) {
      const decoded = decodeSyncState(stored.value);
      if (Option.isSome(decoded)) {
        for (const [threadId, entry] of Object.entries(decoded.value.threads)) {
          entries.set(threadId, entry);
        }
      }
    }

    // Built when it runs, from the entries at that time.
    const persist = Effect.suspend(() =>
      writeFileStringAtomically({
        filePath: statePath,
        contents: `${JSON.stringify({ version: 1, threads: Object.fromEntries(entries) })}\n`,
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.ignore({ log: true }),
    );

    const markDirty = (threadId: string) =>
      Effect.suspend(() => {
        dirty.add(threadId);
        return Queue.offer(wake, undefined);
      });

    const watchDirectory = (directory: string) =>
      fileSystem.watch(directory).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const name = NodePath.basename(event.path);
            for (const threadId of watchers.get(directory)?.threads ?? []) {
              const entry = entries.get(threadId);
              if (entry !== undefined && NodePath.basename(entry.transcriptPath) === name) {
                yield* markDirty(threadId);
              }
            }
          }),
        ),
        // A missing directory is covered by the periodic stat.
        Effect.ignore,
      );

    const track = (threadId: string) =>
      Effect.gen(function* () {
        const entry = entries.get(threadId);
        if (entry === undefined || tracked.has(threadId)) return;
        tracked.set(threadId, {
          written: new Map(),
          lastSeenSize: entry.offset,
          lastStatMs: Date.now(),
          retryAt: null,
          lastExternalMs: 0,
          externalTurnOpen: false,
        });
        const directory = NodePath.dirname(entry.transcriptPath);
        const watcher = watchers.get(directory);
        if (watcher !== undefined) watcher.threads.add(threadId);
        else {
          const fiber = yield* Effect.forkIn(watchDirectory(directory), scope);
          watchers.set(directory, { fiber, threads: new Set([threadId]) });
        }
        // Catch up on anything written since the cursor.
        yield* markDirty(threadId);
      });

    const untrack = (threadId: string) =>
      Effect.gen(function* () {
        if (!tracked.delete(threadId)) return;
        dirty.delete(threadId);
        for (const [directory, watcher] of watchers) {
          if (!watcher.threads.delete(threadId) || watcher.threads.size > 0) continue;
          watchers.delete(directory);
          yield* Fiber.interrupt(watcher.fiber);
        }
      });

    const publishRunning = Effect.gen(function* () {
      const now = Date.now();
      const ids = [...tracked]
        .filter(
          ([, state]) =>
            now - state.lastExternalMs < RUNNING_ELSEWHERE_MS ||
            (state.externalTurnOpen && now - state.lastExternalMs < OPEN_TURN_MS),
        )
        .map(([threadId]) => ThreadId.make(threadId))
        .sort();
      const current = yield* SubscriptionRef.get(running);
      if (current.join("\n") !== ids.join("\n")) yield* SubscriptionRef.set(running, ids);
    });

    const hasActiveRun = (threadId: string) =>
      sql<{ readonly active: number }>`
        SELECT 1 AS active
        FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId}
          AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
          AND CASE
            WHEN json_valid(payload_json) THEN COALESCE(json_extract(payload_json, '$.queueHeld'), 0)
            ELSE 0
          END = 0
        LIMIT 1
      `.pipe(Effect.map((rows) => rows.length > 0));

    /** One sync pass over a thread's appended transcript lines. */
    const syncThread = (threadId: string) =>
      Effect.gen(function* () {
        const state = tracked.get(threadId);
        const entry = entries.get(threadId);
        if (state === undefined || entry === undefined) return;
        const retry = () => {
          state.retryAt = Date.now() + RETRY_MS;
        };
        state.retryAt = null;
        state.lastStatMs = Date.now();
        const size = yield* fileSystem.stat(entry.transcriptPath).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => null),
        );
        // Missing for now; the periodic stat looks again.
        if (size === null) return;
        state.lastSeenSize = size;
        if (size === entry.offset) return;
        if (size < entry.offset) {
          // Replaced or truncated: nothing before the new end can be matched up.
          entries.set(threadId, { ...entry, offset: size });
          state.written.clear();
          yield* persist;
          return;
        }
        // T3's own turn is writing; look again once it ends, without reading its output now.
        if (yield* hasActiveRun(threadId)) return retry();
        const appended = yield* provideFs(readAppended(entry.transcriptPath, entry.offset));
        if (appended === null || appended.size < entry.offset) return;
        if (appended.lines.length === 0) {
          if (appended.end !== entry.offset) {
            entries.set(threadId, { ...entry, offset: appended.end });
            yield* persist;
          }
          return;
        }

        const records = yield* orchestrator.getThreadRecords(ThreadId.make(threadId), [
          "runs",
          "providerTurns",
          "providerSessions",
          "providerThreads",
        ]);
        if (records.thread.deletedAt !== null || records.thread.archivedAt !== null) {
          // The refresh decides between dropping and keeping the entry.
          yield* untrack(threadId);
          return;
        }
        if (
          records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status) && run.queueHeld !== true)
        ) {
          return retry();
        }

        const parsed = parseLines(
          entry.driver,
          parserFor(entry.driver),
          appended.lines,
          appended.end,
          entry.codexTurnId ?? null,
        );
        const nowMs = Date.now();
        const windows: Array<Window> = [];
        for (const run of records.runs) {
          if (run.startedAt === null) continue;
          const requested = DateTime.toEpochMillis(run.requestedAt);
          const started = DateTime.toEpochMillis(run.startedAt);
          const completed =
            run.completedAt === null ? started : DateTime.toEpochMillis(run.completedAt);
          windows.push({
            start: Math.max(requested, started - QUEUE_LEAD_MS) - WINDOW_LEAD_MS,
            end: Math.max(completed, started) + WINDOW_TRAIL_MS,
          });
        }
        // With no run active, an open provider turn is either background work
        // T3 still tracks, which keeps writing, or a stale record, which must
        // not swallow everything after it.
        const withBackgroundWork = new Set(
          records.providerThreads
            .filter((providerThread) => (providerThread.pendingBackgroundTasks ?? []).length > 0)
            .map((providerThread) => providerThread.id),
        );
        const t3Turns = new Set<string>();
        for (const turn of records.providerTurns) {
          const nativeId = turn.nativeTurnRef?.nativeId;
          if (nativeId !== null && nativeId !== undefined) t3Turns.add(nativeId);
          if (turn.startedAt === null) continue;
          const started = DateTime.toEpochMillis(turn.startedAt);
          const end =
            turn.completedAt !== null
              ? DateTime.toEpochMillis(turn.completedAt)
              : (turn.status === "running" || turn.status === "pending") &&
                  withBackgroundWork.has(turn.providerThreadId)
                ? nowMs
                : started;
          windows.push({ start: started - WINDOW_LEAD_MS, end: end + WINDOW_TRAIL_MS });
        }
        // T3's when its Codex turn id is one of T3's turns, or when it falls in a
        // T3 window. An entry without a time cannot be placed, so it is not copied.
        const isT3 = (atMs: number | null, turn: string | null) =>
          (turn !== null && t3Turns.has(turn)) ||
          atMs === null ||
          windows.some((window) => atMs >= window.start && atMs <= window.end);

        let lastExternalMs = state.lastExternalMs;
        let lastLineExternal = false;
        for (const mark of parsed.marks) {
          if (mark.atMs === null) continue;
          lastLineExternal = !isT3(mark.atMs, mark.turn);
          if (lastLineExternal) lastExternalMs = Math.max(lastExternalMs, mark.atMs);
        }
        state.lastExternalMs = lastExternalMs;
        state.externalTurnOpen =
          parsed.openTurn !== null && !t3Turns.has(parsed.openTurn) && lastLineExternal;

        const changed = parsed.messages.filter(
          (message) =>
            !isT3(message.atMs, message.turn) &&
            state.written.get(message.stableId)?.text !== message.text,
        );
        if (changed.length > 0) {
          const now = yield* DateTime.now;
          const batch = nextNonce();
          const activeProviderThread = records.providerThreads.find(
            (candidate) => candidate.id === records.thread.activeProviderThreadId,
          );
          const nativeId = entry.driver === "pi" ? entry.transcriptPath : entry.sessionId;
          const boundHere = activeProviderThread?.nativeThreadRef?.nativeId === nativeId;
          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const message of changed) {
            const atMs = message.atMs ?? nowMs;
            // After the latest run that started before it; runless band when none did.
            let band: number | undefined;
            for (const run of records.runs) {
              const started = DateTime.toEpochMillis(run.startedAt ?? run.requestedAt);
              if (started <= atMs && (band === undefined || run.ordinal > band)) band = run.ordinal;
            }
            const turnItemId = TurnItemId.make(
              `${EVENT_PREFIX}:turn-item:${threadId}:${message.stableId}`,
            );
            // Placed now, in the run's band; the sink's own allocation keeps it.
            const ordinal = yield* positions.allocate({
              threadId: ThreadId.make(threadId),
              turnItemId,
              runId: null,
              ...(band === undefined ? {} : { runOrdinal: band }),
            });
            events.push(
              ...importedMessageEvents({
                threadId: ThreadId.make(threadId),
                messageId: MessageId.make(`${threadId}:ext:${message.stableId}`),
                turnItemId,
                eventId: (kind) =>
                  EventId.make(`${EVENT_PREFIX}:${kind}:${threadId}:${message.stableId}:${batch}`),
                ordinal,
                message: {
                  role: message.role,
                  text: message.text,
                  createdAt: new Date(atMs).toISOString(),
                },
                occurredAt: now,
              }),
            );
          }
          // Claude resumes at the head; point it at the other app's newest entry.
          if (
            entry.driver === "claudeAgent" &&
            boundHere &&
            activeProviderThread !== undefined &&
            parsed.claudeLeaf !== null &&
            activeProviderThread.nativeConversationHeadRef?.nativeId !== parsed.claudeLeaf
          ) {
            const payload: OrchestrationV2ProviderThread = {
              ...activeProviderThread,
              nativeConversationHeadRef: {
                driver: activeProviderThread.driver,
                nativeId: parsed.claudeLeaf,
                strength: "weak",
              },
              updatedAt: now,
            };
            events.push({
              id: EventId.make(`${EVENT_PREFIX}:provider-thread:${threadId}:${batch}`),
              type: "provider-thread.updated",
              threadId: ThreadId.make(threadId),
              driver: activeProviderThread.driver,
              providerInstanceId: activeProviderThread.providerInstanceId,
              occurredAt: now,
              payload,
            });
          }
          yield* eventSink.write({ events });
          for (const message of changed) {
            state.written.set(message.stableId, { offset: message.offset, text: message.text });
          }
          // A live provider process holds the session as it was; let the next
          // turn resume it from disk. Not while it runs background work.
          if (
            boundHere &&
            activeProviderThread !== undefined &&
            (activeProviderThread.pendingBackgroundTasks ?? []).length === 0 &&
            // A turn the user just sent keeps its session.
            !(yield* hasActiveRun(threadId))
          ) {
            for (const session of records.providerSessions) {
              if (session.status === "stopped" || session.status === "error") continue;
              yield* orchestrator
                .dispatch({
                  type: "provider-session.detach",
                  commandId: CommandId.make(
                    `${EVENT_PREFIX}:detach:${threadId}:${session.id}:${batch}`,
                  ),
                  threadId: ThreadId.make(threadId),
                  providerSessionId: session.id,
                  reason: "The session continued in another app.",
                })
                .pipe(Effect.ignore({ log: true }));
            }
          }
        }

        for (const [stableId, written] of state.written) {
          if (written.offset < parsed.safePoint) state.written.delete(stableId);
        }
        entries.set(threadId, {
          driver: entry.driver,
          sessionId: entry.sessionId,
          transcriptPath: entry.transcriptPath,
          // A Grok message longer than one read cannot hold the cursor back forever.
          offset:
            appended.more && parsed.safePoint <= entry.offset ? appended.end : parsed.safePoint,
          ...(parsed.openTurn === null ? {} : { codexTurnId: parsed.openTurn }),
        });
        yield* persist;
        yield* publishRunning;
        if (appended.more) yield* markDirty(threadId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
            const state = tracked.get(threadId);
            if (state !== undefined) state.retryAt = Date.now() + RETRY_MS;
            yield* Effect.logWarning("External session sync pass failed", { threadId, cause });
          }),
        ),
      );

    /**
     * A thread continued before this sync existed: find its transcript.
     * Claude and Codex catch up from the size continue recorded; Grok and Pi
     * recorded none, so they start at the current end.
     */
    const resolveLegacy = (threadId: string) =>
      Effect.gen(function* () {
        const records = yield* orchestrator.getThreadRecords(ThreadId.make(threadId), [
          "providerThreads",
        ]);
        for (const providerThread of records.providerThreads) {
          const driver = providerThread.driver;
          const nativeId = providerThread.nativeThreadRef?.nativeId;
          if (!isContinueDriver(driver) || nativeId === null || nativeId === undefined) continue;
          const sessionId =
            driver === "pi" ? (PI_SESSION_FILE.exec(nativeId)?.[1] ?? null) : nativeId;
          if (sessionId === null || !threadId.endsWith(`:${sessionId}`)) continue;
          const sizeOf = (file: string) =>
            fileSystem.stat(file).pipe(
              Effect.map((info) => Number(info.size)),
              Effect.option,
            );
          if (driver === "pi") {
            const size = yield* sizeOf(nativeId);
            if (Option.isNone(size)) return null;
            return { driver, sessionId, transcriptPath: nativeId, offset: size.value };
          }
          if (driver === "grok") {
            const sessions = NodePath.join(NodeOS.homedir(), ".grok", "sessions");
            for (const directory of yield* provideFs(listDirectory(sessions))) {
              const file = NodePath.join(sessions, directory, sessionId, "updates.jsonl");
              const size = yield* sizeOf(file);
              if (Option.isSome(size)) {
                return { driver, sessionId, transcriptPath: file, offset: size.value };
              }
            }
            return null;
          }
          const imported = yield* sql<{
            readonly file_path: string | null;
            readonly size: number | null;
            readonly session_id: string | null;
          }>`
            SELECT
              json_extract(value, '$.filePath') AS file_path,
              json_extract(value, '$.size') AS size,
              json_extract(value, '$.providerSessionId') AS session_id
            FROM provider_session_runtime,
              json_each(CASE
                WHEN json_valid(runtime_payload_json)
                  AND json_type(runtime_payload_json, '$.importedTranscripts') = 'array'
                THEN json_extract(runtime_payload_json, '$.importedTranscripts')
                ELSE '[]'
              END)
            WHERE thread_id = ${threadId}
          `;
          const record = imported.find(
            (row) => row.session_id === sessionId && typeof row.file_path === "string",
          );
          if (record === undefined || record.file_path === null) return null;
          const size = yield* sizeOf(record.file_path);
          if (Option.isNone(size)) return null;
          return {
            driver,
            sessionId,
            transcriptPath: record.file_path,
            offset: Math.min(record.size ?? size.value, size.value),
          };
        }
        return null;
      }).pipe(Effect.orElseSucceed(() => null));

    /** Tracks continued threads and drops entries of deleted ones. */
    const refresh = Effect.gen(function* () {
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly archived_at: string | null;
        readonly deleted_at: string | null;
        readonly history_origin: string | null;
      }>`
        SELECT
          thread_id,
          archived_at,
          deleted_at,
          CASE
            WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.historyOrigin')
          END AS history_origin
        FROM orchestration_v2_projection_threads
        WHERE thread_id LIKE 'import:%'
      `;
      const byId = new Map(rows.map((row) => [row.thread_id, row]));
      let changed = false;
      for (const threadId of [...entries.keys()]) {
        const row = byId.get(threadId);
        if (row !== undefined && row.deleted_at === null) continue;
        entries.delete(threadId);
        changed = true;
        yield* untrack(threadId);
      }
      for (const threadId of [...tracked.keys()]) {
        if (byId.get(threadId)?.archived_at !== null) yield* untrack(threadId);
      }
      for (const row of rows) {
        if (row.history_origin !== "native" || row.deleted_at !== null) continue;
        if (row.archived_at !== null || tracked.has(row.thread_id)) continue;
        if (!entries.has(row.thread_id)) {
          if (unresolvable.has(row.thread_id)) continue;
          const resolved = yield* resolveLegacy(row.thread_id);
          if (resolved === null) {
            unresolvable.add(row.thread_id);
            continue;
          }
          entries.set(row.thread_id, resolved);
          changed = true;
        }
        yield* track(row.thread_id);
      }
      if (changed) yield* persist;
    }).pipe(Effect.ignore({ log: true }));

    /** Re-dirties threads waiting on a T3 run, and stats files a missed watch event left behind. */
    const tick = Effect.gen(function* () {
      const now = Date.now();
      for (const [threadId, state] of tracked) {
        if (state.retryAt !== null && now >= state.retryAt) {
          state.retryAt = null;
          yield* markDirty(threadId);
          continue;
        }
        if (now - state.lastStatMs < STAT_EVERY_MS) continue;
        state.lastStatMs = now;
        const entry = entries.get(threadId);
        if (entry === undefined) continue;
        const size = yield* fileSystem.stat(entry.transcriptPath).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => null),
        );
        if (size !== null && size !== state.lastSeenSize) yield* markDirty(threadId);
      }
      yield* publishRunning;
    });

    const loop = Effect.gen(function* () {
      yield* Queue.take(wake);
      yield* Effect.sleep(DEBOUNCE);
      const batch = [...dirty];
      dirty.clear();
      for (const threadId of batch) yield* withLock(syncThread(threadId));
    });

    yield* Effect.forkIn(Effect.forever(loop), scope);
    yield* Effect.forkIn(
      Effect.sleep(STARTUP_DELAY).pipe(
        Effect.andThen(Effect.repeat(withLock(refresh), Schedule.spaced(REFRESH_INTERVAL))),
      ),
      scope,
    );
    yield* Effect.forkIn(Effect.repeat(withLock(tick), Schedule.spaced(TICK)), scope);

    const register: ExternalSessionSync["register"] = (start) =>
      withLock(
        Effect.gen(function* () {
          entries.set(start.threadId, {
            driver: start.driver,
            sessionId: start.sessionId,
            transcriptPath: start.transcriptPath,
            offset: start.offset,
          });
          unresolvable.delete(start.threadId);
          yield* persist;
          yield* track(start.threadId);
        }),
      );

    return {
      register,
      runningElsewhere: SubscriptionRef.changes(running),
    } satisfies ExternalSessionSync;
  });
