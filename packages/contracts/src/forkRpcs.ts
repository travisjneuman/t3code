/**
 * The fork's WebSocket RPCs, spread into upstream's `WsRpcGroup` with one line.
 * Fork add-on; see docs/internals/fork-add-ons.md.
 */
import { CompareAgentsRpcs } from "./compareAgents.ts";
import { ExistingCheckoutRpcs } from "./existingCheckout.ts";
import { ExternalSessionsRpcs } from "./externalSessions.ts";
import { HermesSessionsRpcs } from "./hermesSessions.ts";
import { HostBackupsRpcs } from "./hostBackups.ts";
import { MaintenanceQueueRpcs } from "./maintenanceQueue.ts";
import { SaveToNotesRpcs } from "./saveToNotes.ts";
import { SessionSearchRpc } from "./sessionSearch.ts";
import { ThreadExportRpc } from "./threadExport.ts";
import { ThreadRetentionRpcs } from "./threadRetention.ts";

export const FORK_WS_RPCS = [
  ...ExternalSessionsRpcs, // Fork add-on(other-agents)
  SessionSearchRpc, // Fork add-on(session-search)
  ThreadExportRpc, // Fork add-on(thread-export)
  ...SaveToNotesRpcs, // Fork add-on(save-to-notes)
  ...CompareAgentsRpcs, // Fork add-on(compare-agents)
  ...HermesSessionsRpcs, // Fork add-on(hermes)
  ...MaintenanceQueueRpcs, // Fork add-on(maintenance-queue)
  ...HostBackupsRpcs, // Fork add-on(host-backups)
  ...ExistingCheckoutRpcs, // Fork add-on(existing-checkout)
  ...ThreadRetentionRpcs, // Fork add-on(thread-retention)
] as const;
