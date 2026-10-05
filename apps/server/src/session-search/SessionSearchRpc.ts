/**
 * WebSocket handler for session search, kept beside the service so ws.ts
 * only spreads it in. Each connection gets its own service (and caches).
 *
 * @module session-search/SessionSearchRpc
 */
import { SESSION_SEARCH_WS_METHODS, type SessionSearchInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import * as SessionSearch from "./SessionSearch.ts";

const traceAttributes = { "rpc.aggregate": "sessionSearch" };

export const makeHandlers = Effect.gen(function* () {
  const sessionSearch = yield* SessionSearch.SessionSearch;
  return {
    [SESSION_SEARCH_WS_METHODS.search]: (input: SessionSearchInput) =>
      observeRpcEffect(
        SESSION_SEARCH_WS_METHODS.search,
        sessionSearch.search(input),
        traceAttributes,
      ),
  };
}).pipe(Effect.provide(SessionSearch.layer));
