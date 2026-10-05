/**
 * Save to notes: files a thread into the user's notes folder. "Save full
 * copy" writes the thread's prompts and final answers (no tool output) as one
 * Markdown file in the saved-threads folder. "Save summary" asks the thread's
 * own agent to write a summary note into the notes folder, filed by that
 * folder's own instructions. Both folders are server settings. Fork add-on;
 * see docs/user/thread-sidebar.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SAVE_TO_NOTES_WS_METHODS = {
  saveCopy: "saveToNotes.saveCopy",
  requestSummary: "saveToNotes.requestSummary",
} as const;

export const SaveToNotesInput = Schema.Struct({
  threadId: ThreadId,
});
export type SaveToNotesInput = typeof SaveToNotesInput.Type;

/** Where the full copy was written, on the server's machine. */
export const SaveToNotesCopyResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type SaveToNotesCopyResult = typeof SaveToNotesCopyResult.Type;

export const SaveToNotesSummaryResult = Schema.Struct({});
export type SaveToNotesSummaryResult = typeof SaveToNotesSummaryResult.Type;

export class SaveToNotesError extends Schema.TaggedError<SaveToNotesError>()("SaveToNotesError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const SaveToNotesRpcError = Schema.Union([SaveToNotesError, EnvironmentAuthorizationError]);

export const SaveToNotesSaveCopyRpc = Rpc.make(SAVE_TO_NOTES_WS_METHODS.saveCopy, {
  payload: SaveToNotesInput,
  success: SaveToNotesCopyResult,
  error: SaveToNotesRpcError,
});

export const SaveToNotesRequestSummaryRpc = Rpc.make(SAVE_TO_NOTES_WS_METHODS.requestSummary, {
  payload: SaveToNotesInput,
  success: SaveToNotesSummaryResult,
  error: SaveToNotesRpcError,
});

export const SaveToNotesRpcs = [SaveToNotesSaveCopyRpc, SaveToNotesRequestSummaryRpc] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const SAVE_TO_NOTES_RPC_SCOPES = {
  [SAVE_TO_NOTES_WS_METHODS.saveCopy]: AuthOrchestrationOperateScope,
  [SAVE_TO_NOTES_WS_METHODS.requestSummary]: AuthOrchestrationOperateScope,
} as const;
