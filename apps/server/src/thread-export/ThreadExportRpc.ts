/**
 * WebSocket handler for thread export: decodes nothing beyond the contract,
 * calls ThreadExport, and lets its typed error cross the wire.
 * Fork add-on: thread export.
 *
 * @module thread-export/ThreadExportRpc
 */
import { THREAD_EXPORT_WS_METHODS, type ThreadExportInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadExport from "./ThreadExport.ts";

export const makeHandlers = Effect.gen(function* () {
  const threadExport = yield* ThreadExport.ThreadExport;
  return {
    [THREAD_EXPORT_WS_METHODS.export]: (input: ThreadExportInput) =>
      threadExport.export(input),
  };
}).pipe(Effect.provide(ThreadExport.layer));
