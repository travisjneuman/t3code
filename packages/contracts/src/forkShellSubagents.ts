// Fork add-on: nested subagents. Shells that omit idle subagents still name them, so the
// sidebar's subagent toggle counts every child; expanding it reads the rows from the family.
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * Idle subagents an `omitIdleSubagents` snapshot leaves out, grouped by a parent the snapshot
 * sends. Removals drop their ids; a child that wakes arrives as a shell row and stays listed here.
 */
export const OrchestrationV2OmittedSubagents = Schema.Struct({
  parentThreadId: ThreadId,
  threadIds: Schema.Array(ThreadId),
});
