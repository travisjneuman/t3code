/**
 * WebSocket handlers for the fork's add-on RPCs, so ws.ts spreads them in with one line.
 *
 * @module forkRpcHandlers
 */
import * as Effect from "effect/Effect";

// fork-addons:begin
import * as CompareAgentsRpc from "./compare-agents/CompareAgentsRpc.ts"; // Fork add-on(compare-agents)
import * as ExistingCheckoutRpc from "./existing-checkout/ExistingCheckoutRpc.ts"; // Fork add-on(existing-checkout)
import * as ExternalSessionsRpc from "./external-sessions/ExternalSessionsRpc.ts"; // Fork add-on(other-agents)
import * as HermesSessionsRpc from "./hermes/HermesSessionsRpc.ts"; // Fork add-on(hermes)
import * as HostBackupsRpc from "./host-backups/HostBackupsRpc.ts"; // Fork add-on(host-backups)
import * as MaintenanceQueueRpc from "./maintenance-queue/MaintenanceQueueRpc.ts"; // Fork add-on(maintenance-queue)
import * as OpenBotSessionsRpc from "./openbot/OpenBotSessionsRpc.ts"; // Fork add-on(openbot)
import * as SaveToNotesRpc from "./save-to-notes/SaveToNotesRpc.ts"; // Fork add-on(save-to-notes)
import * as SessionSearchRpc from "./session-search/SessionSearchRpc.ts"; // Fork add-on(session-search)
import * as ThreadExportRpc from "./thread-export/ThreadExportRpc.ts"; // Fork add-on(thread-export)
import * as ThreadRetentionRpc from "./thread-retention/ThreadRetentionRpc.ts"; // Fork add-on(thread-retention)

export const makeHandlers = Effect.gen(function* () {
  return {
    ...(yield* ExternalSessionsRpc.makeHandlers), // Fork add-on(other-agents)
    ...(yield* SessionSearchRpc.makeHandlers), // Fork add-on(session-search)
    ...(yield* ThreadExportRpc.makeHandlers), // Fork add-on(thread-export)
    ...(yield* SaveToNotesRpc.makeHandlers), // Fork add-on(save-to-notes)
    ...(yield* CompareAgentsRpc.makeHandlers), // Fork add-on(compare-agents)
    ...(yield* HermesSessionsRpc.makeHandlers), // Fork add-on(hermes)
    ...(yield* OpenBotSessionsRpc.makeHandlers), // Fork add-on(openbot)
    ...(yield* MaintenanceQueueRpc.makeHandlers), // Fork add-on(maintenance-queue)
    ...(yield* HostBackupsRpc.makeHandlers), // Fork add-on(host-backups)
    ...(yield* ExistingCheckoutRpc.makeHandlers), // Fork add-on(existing-checkout)
    ...(yield* ThreadRetentionRpc.makeHandlers), // Fork add-on(thread-retention)
  };
});
// fork-addons:end
