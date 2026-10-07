/**
 * Thread export: renders everything T3 persists for one thread as a Markdown
 * transcript or as complete JSON, built on the server from the orchestration
 * projection. Fork add-on; see docs/user/save-and-export-threads.md#export-a-thread.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THREAD_EXPORT_WS_METHODS = {
  export: "threadExport.export",
} as const;

/** `format` value carried at the top of every JSON export. */
export const THREAD_EXPORT_JSON_FORMAT = "t3-thread-export";
/** Bumped on any breaking change to the JSON export's top-level shape. */
export const THREAD_EXPORT_JSON_VERSION = 1;

export const ThreadExportFormat = Schema.Literals(["markdown", "json"]);
export type ThreadExportFormat = typeof ThreadExportFormat.Type;

export const ThreadExportInput = Schema.Struct({
  threadId: ThreadId,
  format: ThreadExportFormat,
});
export type ThreadExportInput = typeof ThreadExportInput.Type;

/** The finished file. The client saves `content` as `fileName`. */
export const ThreadExportResult = Schema.Struct({
  fileName: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  content: Schema.String,
});
export type ThreadExportResult = typeof ThreadExportResult.Type;

export class ThreadExportError extends Schema.TaggedError<ThreadExportError>()(
  "ThreadExportError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ThreadExportRpc = Rpc.make(THREAD_EXPORT_WS_METHODS.export, {
  payload: ThreadExportInput,
  success: ThreadExportResult,
  error: Schema.Union([ThreadExportError, EnvironmentAuthorizationError]),
});
