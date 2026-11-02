/**
 * WebSocket handlers for the fork's add-on RPCs, so ws.ts spreads them in with one line.
 *
 * @module forkRpcHandlers
 */
import * as Effect from "effect/Effect";

import * as CompareAgentsRpc from "./compare-agents/CompareAgentsRpc.ts";
import * as ExistingCheckoutRpc from "./existing-checkout/ExistingCheckoutRpc.ts";
import * as ExternalSessionsRpc from "./external-sessions/ExternalSessionsRpc.ts";
import * as HermesSessionsRpc from "./hermes/HermesSessionsRpc.ts";
import * as HostBackupsRpc from "./host-backups/HostBackupsRpc.ts";
import * as MaintenanceQueueRpc from "./maintenance-queue/MaintenanceQueueRpc.ts";
import * as SaveToNotesRpc from "./save-to-notes/SaveToNotesRpc.ts";
import * as SessionSearchRpc from "./session-search/SessionSearchRpc.ts";
import * as ThreadExportRpc from "./thread-export/ThreadExportRpc.ts";
import * as ThreadRetentionRpc from "./thread-retention/ThreadRetentionRpc.ts";

export const makeHandlers = Effect.gen(function* () {
  return {
    ...(yield* ExternalSessionsRpc.makeHandlers), // Fork add-on(other-agents)
    ...(yield* SessionSearchRpc.makeHandlers), // Fork add-on(session-search)
    ...(yield* ThreadExportRpc.makeHandlers), // Fork add-on(thread-export)
    ...(yield* SaveToNotesRpc.makeHandlers), // Fork add-on(save-to-notes)
    ...(yield* CompareAgentsRpc.makeHandlers), // Fork add-on(compare-agents)
    ...(yield* HermesSessionsRpc.makeHandlers), // Fork add-on(hermes)
    ...(yield* MaintenanceQueueRpc.makeHandlers), // Fork add-on(maintenance-queue)
    ...(yield* HostBackupsRpc.makeHandlers), // Fork add-on(host-backups)
    ...(yield* ExistingCheckoutRpc.makeHandlers), // Fork add-on(existing-checkout)
    ...(yield* ThreadRetentionRpc.makeHandlers), // Fork add-on(thread-retention)
  };
});
