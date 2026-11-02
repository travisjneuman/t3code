/**
 * The fork's WebSocket RPCs, spread into upstream's `WsRpcGroup` with one line.
 * Fork add-on; see docs/internals/fork-add-ons.md.
 */
// fork-addons:begin
import { CompareAgentsRpcs } from "./compareAgents.ts"; // Fork add-on(compare-agents)
import { ExistingCheckoutRpcs } from "./existingCheckout.ts"; // Fork add-on(existing-checkout)
import { ExternalSessionsRpcs } from "./externalSessions.ts"; // Fork add-on(other-agents)
import { HermesSessionsRpcs } from "./hermesSessions.ts"; // Fork add-on(hermes)
import { HostBackupsRpcs } from "./hostBackups.ts"; // Fork add-on(host-backups)
import { MaintenanceQueueRpcs } from "./maintenanceQueue.ts"; // Fork add-on(maintenance-queue)
import { OpenBotSessionsRpcs } from "./openbotSessions.ts"; // Fork add-on(openbot)
import { SaveToNotesRpcs } from "./saveToNotes.ts"; // Fork add-on(save-to-notes)
import { SessionSearchRpc } from "./sessionSearch.ts"; // Fork add-on(session-search)
import { ThreadExportRpc } from "./threadExport.ts"; // Fork add-on(thread-export)
import { ThreadRetentionRpcs } from "./threadRetention.ts"; // Fork add-on(thread-retention)

export const FORK_WS_RPCS = [
  ...ExternalSessionsRpcs, // Fork add-on(other-agents)
  SessionSearchRpc, // Fork add-on(session-search)
  ThreadExportRpc, // Fork add-on(thread-export)
  ...SaveToNotesRpcs, // Fork add-on(save-to-notes)
  ...CompareAgentsRpcs, // Fork add-on(compare-agents)
  ...HermesSessionsRpcs, // Fork add-on(hermes)
  ...OpenBotSessionsRpcs, // Fork add-on(openbot)
  ...MaintenanceQueueRpcs, // Fork add-on(maintenance-queue)
  ...HostBackupsRpcs, // Fork add-on(host-backups)
  ...ExistingCheckoutRpcs, // Fork add-on(existing-checkout)
  ...ThreadRetentionRpcs, // Fork add-on(thread-retention)
] as const;
// fork-addons:end
