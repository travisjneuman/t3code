/**
 * Fork mutations spread into `CLIENT_GUARDED_RPC_SCOPES`. Each scope repeats its group's
 * `*_RPC_SCOPES` entry; change both together. Imports only the fork groups and auth, because
 * `clientRpcPermissions.ts` imports this file. See docs/internals/fork-add-ons.md.
 */
// fork-addons:begin
import {
  AuthOrchestrationOperateScope, // Fork add-on(other-agents,hermes,openbot,save-to-notes,compare-agents)
  AuthProvidersManageScope, // Fork add-on(hermes,maintenance-queue)
} from "./auth.ts";
import { COMPARE_AGENTS_WS_METHODS } from "./compareAgents.ts"; // Fork add-on(compare-agents)
import { EXTERNAL_SESSIONS_WS_METHODS } from "./externalSessions.ts"; // Fork add-on(other-agents)
import { HERMES_SESSIONS_WS_METHODS } from "./hermesSessions.ts"; // Fork add-on(hermes)
import { MAINTENANCE_QUEUE_WS_METHODS } from "./maintenanceQueue.ts"; // Fork add-on(maintenance-queue)
import { OPENBOT_SESSIONS_WS_METHODS } from "./openbotSessions.ts"; // Fork add-on(openbot)
import { SAVE_TO_NOTES_WS_METHODS } from "./saveToNotes.ts"; // Fork add-on(save-to-notes)

export const FORK_CLIENT_GUARDED_RPC_SCOPES = {
  [EXTERNAL_SESSIONS_WS_METHODS.continue]: AuthOrchestrationOperateScope, // Fork add-on(other-agents)
  [EXTERNAL_SESSIONS_WS_METHODS.archive]: AuthOrchestrationOperateScope, // Fork add-on(other-agents)
  [EXTERNAL_SESSIONS_WS_METHODS.unarchive]: AuthOrchestrationOperateScope, // Fork add-on(other-agents)
  [EXTERNAL_SESSIONS_WS_METHODS.delete]: AuthOrchestrationOperateScope, // Fork add-on(other-agents)
  [EXTERNAL_SESSIONS_WS_METHODS.handBack]: AuthOrchestrationOperateScope, // Fork add-on(other-agents)
  [EXTERNAL_SESSIONS_WS_METHODS.release]: AuthOrchestrationOperateScope, // Fork add-on(other-agents)
  [EXTERNAL_SESSIONS_WS_METHODS.openInOrigin]: AuthOrchestrationOperateScope, // Fork add-on(other-agents)
  [HERMES_SESSIONS_WS_METHODS.continue]: AuthOrchestrationOperateScope, // Fork add-on(hermes)
  [HERMES_SESSIONS_WS_METHODS.update]: AuthOrchestrationOperateScope, // Fork add-on(hermes)
  [HERMES_SESSIONS_WS_METHODS.delete]: AuthOrchestrationOperateScope, // Fork add-on(hermes)
  [HERMES_SESSIONS_WS_METHODS.unarchive]: AuthOrchestrationOperateScope, // Fork add-on(hermes)
  // Dashboard reads share the route with its writes; the server gates both on this.
  [HERMES_SESSIONS_WS_METHODS.dashboard]: AuthProvidersManageScope, // Fork add-on(hermes)
  [HERMES_SESSIONS_WS_METHODS.t3Tools]: AuthProvidersManageScope, // Fork add-on(hermes)
  [OPENBOT_SESSIONS_WS_METHODS.open]: AuthOrchestrationOperateScope, // Fork add-on(openbot)
  [SAVE_TO_NOTES_WS_METHODS.saveCopy]: AuthOrchestrationOperateScope, // Fork add-on(save-to-notes)
  [SAVE_TO_NOTES_WS_METHODS.requestSummary]: AuthOrchestrationOperateScope, // Fork add-on(save-to-notes)
  [COMPARE_AGENTS_WS_METHODS.start]: AuthOrchestrationOperateScope, // Fork add-on(compare-agents)
  [COMPARE_AGENTS_WS_METHODS.reviewSwap]: AuthOrchestrationOperateScope, // Fork add-on(compare-agents)
  [COMPARE_AGENTS_WS_METHODS.followUp]: AuthOrchestrationOperateScope, // Fork add-on(compare-agents)
  [COMPARE_AGENTS_WS_METHODS.stop]: AuthOrchestrationOperateScope, // Fork add-on(compare-agents)
  [MAINTENANCE_QUEUE_WS_METHODS.releaseProviderSessions]: AuthProvidersManageScope, // Fork add-on(maintenance-queue)
} as const;
// fork-addons:end
