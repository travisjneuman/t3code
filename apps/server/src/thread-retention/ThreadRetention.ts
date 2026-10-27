/**
 * Thread retention: a few minutes after start and then every six hours, archive settled
 * threads and delete archived ones after the configured days, then purge the history of
 * threads deleted at least a day ago. Archive and delete go through the orchestrator like a
 * user's commands; purge keeps each tombstone (projection row, `thread.created`, latest
 * `thread.deleted`) so verification and replay still find the deleted thread.
 * Subagent threads follow their owner (see `threadFamily.ts`): a reactor repeats the owner's
 * archive, unarchive and delete on its idle children, each pass catches up children it had to
 * skip, and an owner is only retired when none of its children is pinned, scheduled or working.
 * Fork add-on: thread retention.
 *
 * @module thread-retention/ThreadRetention
 */
import {
  CommandId,
  isLiveSubagentShell,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  indexThreadFamilies,
  readThreadFamilyRows,
  type ThreadFamilyIndex,
  type ThreadFamilyRow,
} from "./threadFamily.ts";

const DAY_MS = 86_400_000;
const FIRST_PASS_DELAY = Duration.minutes(5);
const PASS_INTERVAL = Duration.hours(6);
const PURGE_AFTER_MS = DAY_MS;
const MAX_THREADS_PER_STEP = 100;
const PAGE_SIZE = 200;
// Purge deletes these by thread_id; thread rows, subagent, provider and context rows stay.
const PURGED_PROJECTION_TABLES = [
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_checkpoints",
  "orchestration_v2_projection_checkpoint_scopes",
] as const;

type RetentionAction = "archive" | "delete";
type FamilyAction = RetentionAction | "unarchive";
type CommandSource = "thread-retention" | "thread-family";

function threadIsBusy(thread: OrchestrationV2ThreadShell, nowMs: number): boolean {
  return (
    thread.pinnedAt != null ||
    thread.activeRunId !== null ||
    isLiveSubagentShell(thread) ||
    (thread.pendingGuestMessageCount ?? 0) > 0 ||
    threadHasQueuedTurnStart(thread, nowMs)
  );
}

function threadIsIdle(thread: OrchestrationV2ThreadShell, nowMs: number): boolean {
  return (
    thread.deletedAt === null &&
    thread.lineage.relationshipToParent !== "subagent" &&
    !threadIsBusy(thread, nowMs)
  );
}

function familyCommand(action: FamilyAction, commandId: CommandId, threadId: ThreadId) {
  switch (action) {
    case "archive":
      return { type: "thread.archive", commandId, threadId } as const;
    case "unarchive":
      return { type: "thread.unarchive", commandId, threadId } as const;
    case "delete":
      return { type: "thread.delete", commandId, threadId } as const;
  }
}

const olderThan = (value: DateTime.Utc | null, cutoffMs: number) =>
  value !== null && DateTime.toEpochMillis(value) <= cutoffMs;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  // Keep the pass at about 10% duty, like event-store compaction.
  let sliceStarted = yield* Clock.monotonicTimeNanos;
  const betweenPages = Effect.gen(function* () {
    const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
    if (elapsed < 25_000_000n) return yield* Effect.yieldNow;
    yield* Effect.sleep((Number(elapsed) / 1_000_000) * 9);
    sliceStarted = yield* Clock.monotonicTimeNanos;
  });

  // Shared filters: a pinned, subagent, scheduled or working thread is never a candidate.
  const candidateGuards = sql`
    json_extract(t.payload_json, '$.pinnedAt') IS NULL
    AND COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_tasks s WHERE s.thread_id = t.thread_id AND s.enabled = 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs r
      WHERE r.thread_id = t.thread_id
        AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
    )
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runtime_requests q
      WHERE q.thread_id = t.thread_id AND q.status = 'pending'
    )
  `;

  const archiveCandidates = (cutoffIso: string) =>
    sql<{ readonly thread_id: string }>`
      SELECT t.thread_id FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND json_extract(t.payload_json, '$.settledOverride') = 'settled'
        AND json_extract(t.payload_json, '$.settledAt') <= ${cutoffIso}
        AND ${candidateGuards}
      ORDER BY json_extract(t.payload_json, '$.settledAt') ASC
      LIMIT ${MAX_THREADS_PER_STEP}
    `.pipe(NodeSqliteClient.readOnly);

  const deleteCandidates = (cutoffIso: string) =>
    sql<{ readonly thread_id: string }>`
      SELECT t.thread_id FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL
        AND t.archived_at IS NOT NULL
        AND t.archived_at <= ${cutoffIso}
        AND ${candidateGuards}
      ORDER BY t.archived_at ASC
      LIMIT ${MAX_THREADS_PER_STEP}
    `.pipe(NodeSqliteClient.readOnly);

  // A live thread reads its run-fork source's history and its parent's rows, transitively, so
  // every deleted thread a live one points at keeps its history. A deleted subagent is purged
  // once its parent is deleted too, since a live parent's subagent card still reads it.
  const purgeCandidates = (cutoffIso: string) =>
    sql<{ readonly thread_id: string }>`
      WITH RECURSIVE needed(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
        UNION
        SELECT ref.value
        FROM needed n
        JOIN orchestration_v2_projection_threads p ON p.thread_id = n.thread_id
        JOIN json_each(json_array(
          json_extract(p.payload_json, '$.forkedFrom.threadId'),
          json_extract(p.payload_json, '$.lineage.parentThreadId')
        )) ref
        WHERE ref.value IS NOT NULL
      )
      SELECT t.thread_id FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NOT NULL
        AND t.deleted_at <= ${cutoffIso}
        AND t.thread_id NOT IN (SELECT thread_id FROM needed)
        AND (
          COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
          OR NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads p
            WHERE p.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId')
              AND p.deleted_at IS NULL
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox o
          WHERE o.thread_id = t.thread_id AND o.status IN ('pending', 'running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id
            AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
        )
        AND (
          EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id)
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.thread_id = t.thread_id
          )
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_checkpoints c WHERE c.thread_id = t.thread_id
          )
          OR (
            SELECT COUNT(*) FROM orchestration_events e
            WHERE e.application_event_version = 2
              AND e.aggregate_kind = 'thread'
              AND e.stream_id = t.thread_id
              AND e.event_type <> 'thread.created'
          ) > 1
        )
      ORDER BY t.deleted_at ASC
      LIMIT ${MAX_THREADS_PER_STEP}
    `.pipe(NodeSqliteClient.readOnly);

  const scheduledThreadIds = sql<{ readonly thread_id: string }>`
    SELECT DISTINCT thread_id FROM scheduled_tasks WHERE enabled = 1 AND thread_id IS NOT NULL
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) => new Set(rows.map((row) => row.thread_id))),
  );

  const readFamilies = readThreadFamilyRows(sql).pipe(
    Effect.map((rows) => indexThreadFamilies(rows)),
  );

  /** A child that is scheduled or busy is left alone; its owner's state reaches it later. */
  const childIsFree = Effect.fn("ThreadRetention.childIsFree")(function* (
    childId: string,
    scheduled: ReadonlySet<string>,
  ) {
    if (scheduled.has(childId)) return false;
    const child = yield* projections.getThreadShell(ThreadId.make(childId));
    const nowMs = yield* Clock.currentTimeMillis;
    return child !== null && child.deletedAt === null && !threadIsBusy(child, nowMs);
  });

  const familyIsFree = Effect.fn("ThreadRetention.familyIsFree")(function* (
    families: ThreadFamilyIndex<ThreadFamilyRow>,
    scheduled: ReadonlySet<string>,
    threadId: string,
  ) {
    for (const childId of families.descendantsOf(threadId)) {
      if (families.row(childId)?.deleted_at !== null) continue;
      if (!(yield* childIsFree(childId, scheduled))) return false;
    }
    return true;
  });

  const dispatch = Effect.fn("ThreadRetention.dispatch")(
    function* (source: CommandSource, action: FamilyAction, threadId: ThreadId) {
      const uuid = yield* crypto.randomUUIDv4();
      const commandId = CommandId.make(`server:${source}:${action}:${threadId}:${uuid}`);
      yield* orchestrator.dispatch(familyCommand(action, commandId, threadId));
      return true;
    },
    (effect, source, action, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("thread retention skipped a thread", {
              source,
              action,
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
        ),
      ),
  );

  /**
   * Re-reads each candidate's shell so runtime-only work (guests, queued starts) also holds it,
   * and checks its subagent children the same way. The reactor below moves the children.
   */
  const runStep = Effect.fn("ThreadRetention.runStep")(function* (
    action: RetentionAction,
    days: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cutoffMs = nowMs - days * DAY_MS;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const rows = yield* action === "archive"
      ? archiveCandidates(cutoffIso)
      : deleteCandidates(cutoffIso);
    if (rows.length === 0) return 0;
    const families = yield* readFamilies;
    const scheduled = yield* scheduledThreadIds;
    let count = 0;
    for (const row of rows) {
      yield* betweenPages;
      const thread = yield* projections.getThreadShell(ThreadId.make(row.thread_id));
      if (thread === null || !threadIsIdle(thread, yield* Clock.currentTimeMillis)) continue;
      const due =
        action === "archive"
          ? thread.archivedAt === null &&
            thread.settledOverride === "settled" &&
            olderThan(thread.settledAt, cutoffMs)
          : olderThan(thread.archivedAt, cutoffMs);
      if (!due || !(yield* familyIsFree(families, scheduled, thread.id))) continue;
      if (yield* dispatch("thread-retention", action, thread.id)) count += 1;
    }
    return count;
  });

  const familyTarget = (action: FamilyAction, row: ThreadFamilyRow | undefined) => {
    if (row === undefined || row.deleted_at !== null) return false;
    if (action === "archive") return row.archived_at === null;
    if (action === "unarchive") return row.archived_at !== null;
    return true;
  };

  /** Repeats an owner's archive, unarchive or delete on its children. Unarchive is never held. */
  const cascade = Effect.fn("ThreadRetention.cascade")(function* (
    action: FamilyAction,
    ownerId: ThreadId,
  ) {
    const families = yield* readFamilies;
    const children = families
      .descendantsOf(ownerId)
      .filter((childId) => familyTarget(action, families.row(childId)));
    if (children.length === 0) return;
    const scheduled = action === "unarchive" ? new Set<string>() : yield* scheduledThreadIds;
    for (const childId of children) {
      yield* betweenPages;
      if (action !== "unarchive" && !(yield* childIsFree(childId, scheduled))) continue;
      yield* dispatch("thread-family", action, ThreadId.make(childId));
    }
  });

  /** Brings children of archived or deleted owners in line; it never unarchives. */
  const familyStep = Effect.fn("ThreadRetention.familyStep")(function* () {
    const families = yield* readFamilies;
    const pending = families.rows.flatMap((row) => {
      if (row.relationship !== "subagent" || row.deleted_at !== null) return [];
      const owner = families.row(families.ownerOf(row.thread_id));
      if (owner === undefined || owner.thread_id === row.thread_id) return [];
      if (owner.deleted_at !== null)
        return [{ action: "delete" as const, threadId: row.thread_id }];
      if (owner.archived_at !== null && row.archived_at === null) {
        return [{ action: "archive" as const, threadId: row.thread_id }];
      }
      return [];
    });
    if (pending.length === 0) return 0;
    const scheduled = yield* scheduledThreadIds;
    let count = 0;
    for (const { action, threadId } of pending) {
      if (count >= MAX_THREADS_PER_STEP) break;
      yield* betweenPages;
      if (!(yield* childIsFree(threadId, scheduled))) continue;
      if (yield* dispatch("thread-family", action, ThreadId.make(threadId))) count += 1;
    }
    return count;
  });

  const deletePaged = (table: (typeof PURGED_PROJECTION_TABLES)[number], threadId: string) =>
    Effect.gen(function* () {
      let total = 0;
      while (true) {
        const removed = yield* sql<{ readonly n: number }>`
          DELETE FROM ${sql.literal(table)}
          WHERE rowid IN (
            SELECT rowid FROM ${sql.literal(table)} WHERE thread_id = ${threadId} LIMIT ${PAGE_SIZE}
          )
          RETURNING 1 AS n
        `;
        total += removed.length;
        if (removed.length < PAGE_SIZE) return total;
        yield* betweenPages;
      }
    });

  const purgeThread = Effect.fn("ThreadRetention.purgeThread")(function* (threadId: string) {
    const anchors = yield* sql<{
      readonly created: number;
      readonly latest_deleted: number | null;
      readonly latest_thread_event: number | null;
    }>`
      SELECT
        (SELECT COUNT(*) FROM orchestration_events
          INDEXED BY orchestration_events_v2_created_threads_idx
          WHERE application_event_version = 2 AND aggregate_kind = 'thread'
            AND event_type = 'thread.created' AND stream_id = ${threadId}) AS created,
        (SELECT MAX(sequence) FROM orchestration_events
          WHERE application_event_version = 2 AND aggregate_kind = 'thread'
            AND event_type = 'thread.deleted' AND stream_id = ${threadId}) AS latest_deleted,
        (SELECT MAX(sequence) FROM orchestration_events
          WHERE application_event_version = 2 AND aggregate_kind = 'thread') AS latest_thread_event
    `.pipe(NodeSqliteClient.readOnly);
    const anchor = anchors[0];
    // Without both anchors a rebuild could not reproduce the tombstone.
    if (anchor === undefined || anchor.created === 0 || anchor.latest_deleted === null) {
      yield* Effect.logWarning("thread retention left a deleted thread unpurged", {
        threadId,
        reason: "missing-anchor-events",
      });
      return { rows: 0, events: 0 };
    }
    const keepDeleted = anchor.latest_deleted;
    // Projection verification compares against the newest thread event, so it always stays.
    const latestThreadEvent = anchor.latest_thread_event ?? keepDeleted;

    let rows = 0;
    for (const table of PURGED_PROJECTION_TABLES) {
      yield* betweenPages;
      rows += yield* deletePaged(table, threadId);
    }

    let events = 0;
    let afterSequence = 0;
    while (true) {
      yield* betweenPages;
      const page = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events
        INDEXED BY idx_orchestration_events_agent_stream_sequence
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence > ${afterSequence}
        ORDER BY sequence ASC
        LIMIT ${PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly);
      const last = page.at(-1);
      if (last === undefined) break;
      afterSequence = last.sequence;
      const obsolete = page
        .map((row) => row.sequence)
        .filter((sequence) => sequence !== keepDeleted && sequence < latestThreadEvent);
      if (obsolete.length > 0) {
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        const removed = yield* sql<{ readonly n: number }>`
          DELETE FROM orchestration_events
          WHERE sequence IN ${sql.in(obsolete)}
            AND event_type <> 'thread.created'
          RETURNING 1 AS n
        `;
        events += removed.length;
      }
      if (page.length < PAGE_SIZE) break;
    }
    return { rows, events };
  });

  const purgeStep = Effect.fn("ThreadRetention.purgeStep")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const rows = yield* purgeCandidates(new Date(nowMs - PURGE_AFTER_MS).toISOString());
    let threads = 0;
    let projectionRows = 0;
    let events = 0;
    for (const row of rows) {
      const result = yield* purgeThread(row.thread_id);
      if (result.rows > 0 || result.events > 0) threads += 1;
      projectionRows += result.rows;
      events += result.events;
    }
    return { threads, projectionRows, events };
  });

  const pass = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const archiveDays = settings.threadRetentionArchiveSettledAfterDays;
    const deleteDays = settings.threadRetentionDeleteArchivedAfterDays;
    const family = yield* familyStep();
    const archived = archiveDays === null ? 0 : yield* runStep("archive", archiveDays);
    const deleted = deleteDays === null ? 0 : yield* runStep("delete", deleteDays);
    const purged = yield* purgeStep();
    if (family > 0 || archived > 0 || deleted > 0 || purged.threads > 0) {
      yield* Effect.logInfo("Thread retention pass", {
        family,
        archived,
        deleted,
        purgedThreads: purged.threads,
        purgedProjectionRows: purged.projectionRows,
        purgedEvents: purged.events,
      });
    }
  }).pipe(
    Effect.withSpan("ThreadRetention.pass"),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logWarning("Thread retention pass failed", { cause: Cause.pretty(cause) }),
    ),
  );

  // Keyed by owner: a newer archive, unarchive or delete replaces a cascade still running.
  const cascades = yield* FiberMap.make<ThreadId>();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      if (
        (event.type !== "thread.archived" &&
          event.type !== "thread.unarchived" &&
          event.type !== "thread.deleted") ||
        event.payload.lineage.relationshipToParent === "subagent"
      ) {
        return Effect.void;
      }
      const action: FamilyAction =
        event.type === "thread.archived"
          ? "archive"
          : event.type === "thread.unarchived"
            ? "unarchive"
            : "delete";
      return FiberMap.run(
        cascades,
        event.threadId,
        cascade(action, event.threadId).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("thread family cascade failed", {
                action,
                threadId: event.threadId,
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      );
    }),
  );

  yield* forkParked(
    Effect.sleep(FIRST_PASS_DELAY).pipe(
      Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL)))),
    ),
  );
});

export const layer = Layer.effectDiscard(make);
