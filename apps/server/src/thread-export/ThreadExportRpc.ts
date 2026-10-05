/**
 * WebSocket handler for thread export: decodes nothing beyond the contract,
 * calls ThreadExport, and lets its typed error cross the wire.
 * Fork add-on: thread export.
 *
 * @module thread-export/ThreadExportRpc
 */
import { THREAD_EXPORT_WS_METHODS, type ThreadExportInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import * as ThreadExport from "./ThreadExport.ts";

const traceAttributes = { "rpc.aggregate": "threadExport" };

export const makeHandlers = Effect.gen(function* () {
  const threadExport = yield* ThreadExport.ThreadExport;
  return {
    [THREAD_EXPORT_WS_METHODS.export]: (input: ThreadExportInput) =>
      observeRpcEffect(
        THREAD_EXPORT_WS_METHODS.export,
        threadExport.export(input),
        traceAttributes,
      ),
  };
}).pipe(Effect.provide(ThreadExport.layer));
