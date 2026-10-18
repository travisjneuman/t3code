/**
 * The fork's mutations, spread into upstream's `CLIENT_GUARDED_RPC_SCOPES` with
 * one line, so each command's `permissionAtom` hides what the server would
 * refuse. Each scope repeats the one in its group's `*_RPC_SCOPES` map; change
 * both together. Reads stay unguarded, as upstream's do. Fork add-on; see
 * docs/internals/fork-add-ons.md.
 *
 * Imports only the fork groups and auth: `rpc.ts` imports those groups, and
 * `clientRpcPermissions.ts` imports this file.
 */
import { AuthOrchestrationOperateScope, AuthProvidersManageScope } from "./auth.ts";
import { COMPARE_AGENTS_WS_METHODS } from "./compareAgents.ts";
import { EXTERNAL_SESSIONS_WS_METHODS } from "./externalSessions.ts";
import { HERMES_SESSIONS_WS_METHODS } from "./hermesSessions.ts";
import { MAINTENANCE_QUEUE_WS_METHODS } from "./maintenanceQueue.ts";
import { SAVE_TO_NOTES_WS_METHODS } from "./saveToNotes.ts";

export const FORK_CLIENT_GUARDED_RPC_SCOPES = {
  [EXTERNAL_SESSIONS_WS_METHODS.continue]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.archive]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.unarchive]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.delete]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.handBack]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.release]: AuthOrchestrationOperateScope,
  [EXTERNAL_SESSIONS_WS_METHODS.openInOrigin]: AuthOrchestrationOperateScope,
  [HERMES_SESSIONS_WS_METHODS.continue]: AuthOrchestrationOperateScope,
  [HERMES_SESSIONS_WS_METHODS.update]: AuthOrchestrationOperateScope,
  [HERMES_SESSIONS_WS_METHODS.delete]: AuthOrchestrationOperateScope,
  [HERMES_SESSIONS_WS_METHODS.unarchive]: AuthOrchestrationOperateScope,
  // Dashboard reads share the route with its writes; the server gates both on this.
  [HERMES_SESSIONS_WS_METHODS.dashboard]: AuthProvidersManageScope,
  [HERMES_SESSIONS_WS_METHODS.t3Tools]: AuthProvidersManageScope,
  [SAVE_TO_NOTES_WS_METHODS.saveCopy]: AuthOrchestrationOperateScope,
  [SAVE_TO_NOTES_WS_METHODS.requestSummary]: AuthOrchestrationOperateScope,
  [COMPARE_AGENTS_WS_METHODS.start]: AuthOrchestrationOperateScope,
  [COMPARE_AGENTS_WS_METHODS.reviewSwap]: AuthOrchestrationOperateScope,
  [COMPARE_AGENTS_WS_METHODS.followUp]: AuthOrchestrationOperateScope,
  [COMPARE_AGENTS_WS_METHODS.stop]: AuthOrchestrationOperateScope,
  [MAINTENANCE_QUEUE_WS_METHODS.releaseProviderSessions]: AuthProvidersManageScope,
} as const;
