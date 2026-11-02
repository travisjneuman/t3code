/**
 * Scopes for the fork's add-on RPCs, spread into `RPC_REQUIRED_SCOPES` with one line.
 *
 * @module auth/forkRpcScopes
 */
import {
  AuthOrchestrationReadScope,
  COMPARE_AGENTS_RPC_SCOPES,
  EXISTING_CHECKOUT_RPC_SCOPES,
  EXTERNAL_SESSIONS_RPC_SCOPES,
  HERMES_SESSIONS_RPC_SCOPES,
  HOST_BACKUPS_RPC_SCOPES,
  MAINTENANCE_QUEUE_RPC_SCOPES,
  OPENBOT_SESSIONS_RPC_SCOPES,
  SAVE_TO_NOTES_RPC_SCOPES,
  SESSION_SEARCH_WS_METHODS,
  THREAD_EXPORT_WS_METHODS,
  THREAD_RETENTION_RPC_SCOPES,
} from "@t3tools/contracts";

export const FORK_RPC_REQUIRED_SCOPES = {
  ...EXTERNAL_SESSIONS_RPC_SCOPES, // Fork add-on(other-agents)
  [SESSION_SEARCH_WS_METHODS.search]: AuthOrchestrationReadScope, // Fork add-on(session-search)
  [THREAD_EXPORT_WS_METHODS.export]: AuthOrchestrationReadScope, // Fork add-on(thread-export)
  ...SAVE_TO_NOTES_RPC_SCOPES, // Fork add-on(save-to-notes)
  ...COMPARE_AGENTS_RPC_SCOPES, // Fork add-on(compare-agents)
  ...HERMES_SESSIONS_RPC_SCOPES, // Fork add-on(hermes)
  ...OPENBOT_SESSIONS_RPC_SCOPES, // Fork add-on(openbot)
  ...MAINTENANCE_QUEUE_RPC_SCOPES, // Fork add-on(maintenance-queue)
  ...HOST_BACKUPS_RPC_SCOPES, // Fork add-on(host-backups)
  ...EXISTING_CHECKOUT_RPC_SCOPES, // Fork add-on(existing-checkout)
  ...THREAD_RETENTION_RPC_SCOPES, // Fork add-on(thread-retention)
} as const;
