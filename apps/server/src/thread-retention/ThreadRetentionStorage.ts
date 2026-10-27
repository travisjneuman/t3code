/**
 * What stored threads cost on disk, for the retention settings. Runs only when a client asks,
 * with one grouped read per table and a short cache. Subagent threads count toward their
 * owner's row. Fork add-on: thread retention.
 *
 * @module thread-retention/ThreadRetentionStorage
 */
import {
  ProjectId,
  ThreadId,
  ThreadRetentionError,
  type ThreadRetentionStorageResult,
  type ThreadRetentionStorageThread,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { indexThreadFamilies } from "./threadFamily.ts";

export class ThreadRetentionStorage extends Context.Service<
  ThreadRetentionStorage,
  {
    readonly storage: Effect.Effect<ThreadRetentionStorageResult, ThreadRetentionError>;
  }
>()("t3/thread-retention/ThreadRetentionStorage") {}

interface ThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
  readonly settled_override: string | null;
  readonly settled_at: string | null;
  readonly relationship: string | null;
  readonly parent_thread_id: string | null;
}

interface OwnerTotal {
  readonly row: ThreadRow;
  readonly state: "settled" | "archived";
  bytes: number;
  subagents: number;
}

interface BytesRow {
  readonly thread_id: string;
  readonly bytes: number | null;
}

const attachmentIdFromFileName = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readDatabase = Effect.gen(function* () {
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    const databaseBytes = (pages[0]?.page_count ?? 0) * (size[0]?.page_size ?? 0);
    const threads = yield* sql<ThreadRow>`
      SELECT thread_id, project_id, title, updated_at, archived_at, deleted_at,
        json_extract(payload_json, '$.settledOverride') AS settled_override,
        json_extract(payload_json, '$.settledAt') AS settled_at,
        json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
        json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id
      FROM orchestration_v2_projection_threads
    `;
    // Purge keeps thread.created and the last thread.deleted, so deleted threads count the rest.
    const events = yield* sql<BytesRow & { readonly purgeable: number | null }>`
      SELECT stream_id AS thread_id,
        SUM(length(CAST(payload_json AS BLOB))) AS bytes,
        SUM(CASE WHEN application_event_version = 2
          AND event_type NOT IN ('thread.created', 'thread.deleted')
          THEN length(CAST(payload_json AS BLOB)) ELSE 0 END) AS purgeable
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
      GROUP BY stream_id
    `;
    const turnItems = yield* sql<BytesRow>`
      SELECT thread_id, SUM(length(CAST(payload_json AS BLOB))) AS bytes
      FROM orchestration_v2_projection_turn_items GROUP BY thread_id
    `;
    const nodes = yield* sql<BytesRow>`
      SELECT thread_id, SUM(length(CAST(payload_json AS BLOB))) AS bytes
      FROM orchestration_v2_projection_nodes GROUP BY thread_id
    `;
    const messages = yield* sql<BytesRow>`
      SELECT thread_id, SUM(length(CAST(payload_json AS BLOB))) AS bytes
      FROM orchestration_v2_projection_messages GROUP BY thread_id
    `;
    return { databaseBytes, threads, events, turnItems, nodes, messages };
  }).pipe(NodeSqliteClient.readOnly);

  const readAttachments = Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(config.attachmentsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const files: Array<{ readonly segment: string | null; readonly bytes: number }> = [];
    for (const name of names) {
      const stat = yield* fs
        .stat(path.join(config.attachmentsDir, name))
        .pipe(Effect.orElseSucceed(() => null));
      if (stat?.type !== "File") continue;
      files.push({
        segment: parseThreadSegmentFromAttachmentId(attachmentIdFromFileName(name)),
        bytes: Number(stat.size),
      });
    }
    return files;
  });

  const compute = Effect.gen(function* () {
    const db = yield* readDatabase;
    const files = yield* readAttachments;

    const bytesByThread = new Map<string, number>();
    const add = (threadId: string, bytes: number) =>
      bytesByThread.set(threadId, (bytesByThread.get(threadId) ?? 0) + bytes);
    for (const rows of [db.turnItems, db.nodes, db.messages]) {
      for (const row of rows) add(row.thread_id, row.bytes ?? 0);
    }
    const eventBytes = new Map(db.events.map((row) => [row.thread_id, row] as const));

    const threadBySegment = new Map<string, string>();
    for (const thread of db.threads) {
      const segment = toSafeThreadAttachmentSegment(thread.thread_id);
      if (segment !== null && !threadBySegment.has(segment)) {
        threadBySegment.set(segment, thread.thread_id);
      }
    }
    let attachmentsBytes = 0;
    for (const file of files) {
      attachmentsBytes += file.bytes;
      const threadId = file.segment === null ? undefined : threadBySegment.get(file.segment);
      if (threadId !== undefined) add(threadId, file.bytes);
    }

    const families = indexThreadFamilies(db.threads);
    const owners = new Map<string, OwnerTotal>();
    let settledBytes = 0;
    let archivedBytes = 0;
    let otherThreadsBytes = 0;
    let deletedPendingPurgeBytes = 0;
    for (const thread of db.threads) {
      const projected = bytesByThread.get(thread.thread_id) ?? 0;
      const events = eventBytes.get(thread.thread_id);
      if (thread.deleted_at !== null) {
        deletedPendingPurgeBytes += projected + (events?.purgeable ?? 0);
        continue;
      }
      const bytes = projected + (events?.bytes ?? 0);
      const owner = families.row(families.ownerOf(thread.thread_id));
      const state =
        owner === undefined || owner.deleted_at !== null || owner.relationship === "subagent"
          ? null
          : owner.archived_at !== null
            ? "archived"
            : owner.settled_override === "settled"
              ? "settled"
              : null;
      if (owner === undefined || state === null) {
        otherThreadsBytes += bytes;
        continue;
      }
      if (state === "archived") archivedBytes += bytes;
      else settledBytes += bytes;
      const total = owners.get(owner.thread_id) ?? { row: owner, state, bytes: 0, subagents: 0 };
      total.bytes += bytes;
      if (owner.thread_id !== thread.thread_id) total.subagents += 1;
      owners.set(owner.thread_id, total);
    }
    const threads: Array<ThreadRetentionStorageThread> = [];
    for (const { row, state, bytes, subagents } of owners.values()) {
      threads.push({
        threadId: ThreadId.make(row.thread_id),
        projectId: ProjectId.make(row.project_id),
        title: row.title,
        state,
        settledAt: row.settled_at,
        archivedAt: row.archived_at,
        updatedAt: row.updated_at,
        bytes,
        ...(subagents > 0 ? { subagentCount: subagents } : {}),
      });
    }
    threads.sort((a, b) => b.bytes - a.bytes);

    return {
      databaseBytes: db.databaseBytes,
      attachmentsBytes,
      threads,
      settledBytes,
      archivedBytes,
      otherThreadsBytes,
      deletedPendingPurgeBytes,
    } satisfies ThreadRetentionStorageResult;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadRetentionError({ message: `Thread storage could not be read: ${String(cause)}` }),
    ),
    Effect.withSpan("ThreadRetentionStorage.storage"),
  );

  const storage = yield* Effect.cachedWithTTL(compute, (exit) =>
    Exit.isSuccess(exit) ? "1 minute" : 0,
  );

  return ThreadRetentionStorage.of({ storage });
});

export const layer = Layer.effect(ThreadRetentionStorage, make);
