/**
 * WebSocket handler for session search, kept beside the service so ws.ts
 * only spreads it in. Each connection gets its own service (and caches).
 *
 * @module session-search/SessionSearchRpc
 */
import { SESSION_SEARCH_WS_METHODS, type SessionSearchInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SessionSearch from "./SessionSearch.ts";

export const makeHandlers = Effect.gen(function* () {
  const sessionSearch = yield* SessionSearch.SessionSearch;
  return {
    [SESSION_SEARCH_WS_METHODS.search]: (input: SessionSearchInput) =>
      sessionSearch.search(input),
  };
}).pipe(Effect.provide(SessionSearch.layer));
