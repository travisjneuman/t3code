/**
 * The `rpc.aggregate` span labels of the fork's add-on RPCs, spread into `RPC_AGGREGATES`.
 * Fork add-on: add-on RPCs.
 *
 * @module observability/forkRpcAggregates
 */
import {
  COMPARE_AGENTS_WS_METHODS,
  EXTERNAL_SESSIONS_WS_METHODS,
  SAVE_TO_NOTES_WS_METHODS,
  SESSION_SEARCH_WS_METHODS,
  THREAD_EXPORT_WS_METHODS,
} from "@t3tools/contracts";

const label = <const M extends Record<string, string>, const A extends string>(
  methods: M,
  aggregate: A,
) =>
  Object.fromEntries(Object.values(methods).map((method) => [method, aggregate])) as Record<
    M[keyof M],
    A
  >;

export const FORK_RPC_AGGREGATES = {
  ...label(EXTERNAL_SESSIONS_WS_METHODS, "externalSessions"),
  ...label(SESSION_SEARCH_WS_METHODS, "sessionSearch"),
  ...label(THREAD_EXPORT_WS_METHODS, "threadExport"),
  ...label(SAVE_TO_NOTES_WS_METHODS, "saveToNotes"),
  ...label(COMPARE_AGENTS_WS_METHODS, "compareAgents"),
};
