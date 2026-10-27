/**
 * Thread retention: archive settled threads and delete archived ones after a number of days,
 * purge the history of deleted threads, and report what the stored threads cost on disk.
 * settings.ts spreads the field groups below. Fork add-on: thread retention.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

export const MIN_THREAD_RETENTION_DAYS = 1;
export const MAX_THREAD_RETENTION_DAYS = 365;
export const DEFAULT_THREAD_RETENTION_DAYS = 7;

export const ThreadRetentionDays = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_THREAD_RETENTION_DAYS, maximum: MAX_THREAD_RETENTION_DAYS }),
);
export type ThreadRetentionDays = typeof ThreadRetentionDays.Type;

/** Null turns the step off. */
export const ThreadRetentionSettingsFields = {
  threadRetentionArchiveSettledAfterDays: Schema.NullOr(ThreadRetentionDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_RETENTION_DAYS)),
  ),
  threadRetentionDeleteArchivedAfterDays: Schema.NullOr(ThreadRetentionDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_RETENTION_DAYS)),
  ),
};

export const ThreadRetentionSettingsPatchFields = {
  threadRetentionArchiveSettledAfterDays: Schema.optionalKey(Schema.NullOr(ThreadRetentionDays)),
  threadRetentionDeleteArchivedAfterDays: Schema.optionalKey(Schema.NullOr(ThreadRetentionDays)),
};

export const THREAD_RETENTION_WS_METHODS = {
  storage: "threadRetention.storage",
} as const;

export const ThreadRetentionStorageThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  state: Schema.Literals(["settled", "archived"]),
  settledAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  bytes: NonNegativeInt,
});
export type ThreadRetentionStorageThread = typeof ThreadRetentionStorageThread.Type;

/** Thread byte counts are approximate: stored payload lengths plus attachment files. */
export const ThreadRetentionStorageResult = Schema.Struct({
  databaseBytes: NonNegativeInt,
  attachmentsBytes: NonNegativeInt,
  threads: Schema.Array(ThreadRetentionStorageThread),
  settledBytes: NonNegativeInt,
  archivedBytes: NonNegativeInt,
  otherThreadsBytes: NonNegativeInt,
  deletedPendingPurgeBytes: NonNegativeInt,
});
export type ThreadRetentionStorageResult = typeof ThreadRetentionStorageResult.Type;

export class ThreadRetentionError extends Schema.TaggedError<ThreadRetentionError>()(
  "ThreadRetentionError",
  { message: Schema.String },
) {}

export const ThreadRetentionStorageRpc = Rpc.make(THREAD_RETENTION_WS_METHODS.storage, {
  payload: Schema.Struct({}),
  success: ThreadRetentionStorageResult,
  error: Schema.Union([ThreadRetentionError, EnvironmentAuthorizationError]),
});

export const ThreadRetentionRpcs = [ThreadRetentionStorageRpc] as const;

/** Thread titles are orchestration data, so the listing needs the same scope as thread reads. */
export const THREAD_RETENTION_RPC_SCOPES = {
  [THREAD_RETENTION_WS_METHODS.storage]: AuthOrchestrationReadScope,
} as const;
