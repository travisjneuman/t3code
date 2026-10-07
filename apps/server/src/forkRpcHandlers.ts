/**
 * WebSocket handlers for the fork's add-on RPCs, so ws.ts spreads them in with one line.
 *
 * @module forkRpcHandlers
 */
import * as Effect from "effect/Effect";

import * as CompareAgentsRpc from "./compare-agents/CompareAgentsRpc.ts";
import * as ExternalSessionsRpc from "./external-sessions/ExternalSessionsRpc.ts";
import * as SaveToNotesRpc from "./save-to-notes/SaveToNotesRpc.ts";
import * as SessionSearchRpc from "./session-search/SessionSearchRpc.ts";
import * as ThreadExportRpc from "./thread-export/ThreadExportRpc.ts";

export const makeHandlers = Effect.gen(function* () {
  return {
    ...(yield* ExternalSessionsRpc.makeHandlers),
    ...(yield* SessionSearchRpc.makeHandlers),
    ...(yield* ThreadExportRpc.makeHandlers),
    ...(yield* SaveToNotesRpc.makeHandlers),
    ...(yield* CompareAgentsRpc.makeHandlers),
  };
});
