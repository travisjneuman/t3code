/**
 * WebSocket handlers for External Sessions, kept beside the service so ws.ts
 * only spreads them in.
 *
 * @module external-sessions/ExternalSessionsRpc
 */
import {
  EXTERNAL_SESSIONS_WS_METHODS,
  type ExternalSessionContinueInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
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
    [EXTERNAL_SESSIONS_WS_METHODS.continue]: (input: ExternalSessionContinueInput) =>
      observeRpcEffect(
        EXTERNAL_SESSIONS_WS_METHODS.continue,
        externalSessions.continueSession(input),
        traceAttributes,
      ),
    [EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere]: (_input: unknown) =>
      observeRpcStream(
        EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere,
        externalSessions.subscribeRunningElsewhere.pipe(Stream.map((threadIds) => ({ threadIds }))),
        traceAttributes,
      ),
  };
});
