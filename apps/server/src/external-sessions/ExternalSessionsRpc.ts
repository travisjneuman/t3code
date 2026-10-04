/**
 * WebSocket handlers for External Sessions, kept beside the service so ws.ts
 * only spreads them in.
 *
 * @module external-sessions/ExternalSessionsRpc
 */
import { EXTERNAL_SESSIONS_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { observeRpcStream } from "../observability/RpcInstrumentation.ts";
import * as ExternalSessions from "./ExternalSessions.ts";

const traceAttributes = { "rpc.aggregate": "externalSessions" };

export const makeHandlers = Effect.gen(function* () {
  const externalSessions = yield* ExternalSessions.ExternalSessions;
  return {
    [EXTERNAL_SESSIONS_WS_METHODS.subscribeList]: (_input: unknown) =>
      observeRpcStream(
        EXTERNAL_SESSIONS_WS_METHODS.subscribeList,
        externalSessions.subscribeList,
        traceAttributes,
      ),
    [EXTERNAL_SESSIONS_WS_METHODS.subscribeSession]: (input: { readonly key: string }) =>
      observeRpcStream(
        EXTERNAL_SESSIONS_WS_METHODS.subscribeSession,
        externalSessions.subscribeSession(input.key),
        traceAttributes,
      ),
  };
});
