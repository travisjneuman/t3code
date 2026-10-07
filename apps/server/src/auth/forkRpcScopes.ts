/**
 * Scopes for the fork's add-on RPCs, spread into `RPC_REQUIRED_SCOPES` with one line.
 *
 * @module auth/forkRpcScopes
 */
import {
  AuthOrchestrationReadScope,
  COMPARE_AGENTS_RPC_SCOPES,
  EXTERNAL_SESSIONS_RPC_SCOPES,
  SAVE_TO_NOTES_RPC_SCOPES,
  SESSION_SEARCH_WS_METHODS,
  THREAD_EXPORT_WS_METHODS,
} from "@t3tools/contracts";

export const FORK_RPC_REQUIRED_SCOPES = {
  ...EXTERNAL_SESSIONS_RPC_SCOPES,
  [SESSION_SEARCH_WS_METHODS.search]: AuthOrchestrationReadScope,
  [THREAD_EXPORT_WS_METHODS.export]: AuthOrchestrationReadScope,
  ...SAVE_TO_NOTES_RPC_SCOPES,
  ...COMPARE_AGENTS_RPC_SCOPES,
} as const;
