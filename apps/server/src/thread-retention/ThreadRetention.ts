/**
 * Thread retention: a few minutes after start and then every six hours, archive settled
 * threads and delete archived ones after the configured days, then purge the history of
 * threads deleted at least a day ago. Archive and delete go through the orchestrator like a
 * user's commands; purge keeps each tombstone (projection row, `thread.created`, latest
 * `thread.deleted`) so verification and replay still find the deleted thread.
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
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

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

function threadIsIdle(thread: OrchestrationV2ThreadShell, nowMs: number): boolean {
  return (
    thread.deletedAt === null &&
    thread.pinnedAt == null &&
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.activeRunId === null &&
    !isLiveSubagentShell(thread) &&
    (thread.pendingGuestMessageCount ?? 0) === 0 &&
    !threadHasQueuedTurnStart(thread, nowMs)
  );
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
  // every deleted thread a live one points at keeps its history.
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
        AND COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
        AND t.thread_id NOT IN (SELECT thread_id FROM needed)
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

  const dispatch = Effect.fn("ThreadRetention.dispatch")(
    function* (action: RetentionAction, threadId: ThreadId) {
      const uuid = yield* crypto.randomUUIDv4();
      const commandId = CommandId.make(`server:thread-retention:${action}:${threadId}:${uuid}`);
      yield* orchestrator.dispatch(
        action === "archive"
          ? { type: "thread.archive", commandId, threadId }
          : { type: "thread.delete", commandId, threadId },
      );
      return true;
    },
    (effect, action, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("thread retention skipped a thread", {
              action,
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
        ),
      ),
  );

  /** Re-reads each candidate's shell so runtime-only work (guests, queued starts) also holds it. */
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
      if (due && (yield* dispatch(action, thread.id))) count += 1;
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
    const archived = archiveDays === null ? 0 : yield* runStep("archive", archiveDays);
    const deleted = deleteDays === null ? 0 : yield* runStep("delete", deleteDays);
    const purged = yield* purgeStep();
    if (archived > 0 || deleted > 0 || purged.threads > 0) {
      yield* Effect.logInfo("Thread retention pass", {
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

  yield* forkParked(
    Effect.sleep(FIRST_PASS_DELAY).pipe(
      Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL)))),
    ),
  );
});

export const layer = Layer.effectDiscard(make);
