/**
 * WebSocket handlers for External Sessions, kept beside the service so ws.ts
 * only spreads them in.
 *
 * @module external-sessions/ExternalSessionsRpc
 */
import {
  EXTERNAL_SESSIONS_WS_METHODS,
  type ExternalSessionArchiveInput,
  type ExternalSessionContinueInput,
  type ExternalSessionHandBackInput,
  type ExternalSessionReleaseInput,
  type ExternalSessionOpenInOriginInput,
  type ExternalSessionUnarchiveInput,
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
    [EXTERNAL_SESSIONS_WS_METHODS.archive]: (input: ExternalSessionArchiveInput) =>
      observeRpcEffect(
        EXTERNAL_SESSIONS_WS_METHODS.archive,
        externalSessions.archiveSession(input),
        traceAttributes,
      ),
    [EXTERNAL_SESSIONS_WS_METHODS.unarchive]: (input: ExternalSessionUnarchiveInput) =>
      observeRpcEffect(
        EXTERNAL_SESSIONS_WS_METHODS.unarchive,
        externalSessions.unarchiveSession(input.key),
        traceAttributes,
      ),
    [EXTERNAL_SESSIONS_WS_METHODS.subscribeArchived]: (_input: unknown) =>
      observeRpcStream(
        EXTERNAL_SESSIONS_WS_METHODS.subscribeArchived,
        externalSessions.subscribeArchived,
        traceAttributes,
      ),
    [EXTERNAL_SESSIONS_WS_METHODS.handBack]: (input: ExternalSessionHandBackInput) =>
      observeRpcEffect(
        EXTERNAL_SESSIONS_WS_METHODS.handBack,
        externalSessions.handBack(input.threadId),
        traceAttributes,
      ),
    [EXTERNAL_SESSIONS_WS_METHODS.release]: (input: ExternalSessionReleaseInput) =>
      observeRpcEffect(
        EXTERNAL_SESSIONS_WS_METHODS.release,
        externalSessions.release(input.threadId),
        traceAttributes,
      ),
    [EXTERNAL_SESSIONS_WS_METHODS.openInOrigin]: (input: ExternalSessionOpenInOriginInput) =>
      observeRpcEffect(
        EXTERNAL_SESSIONS_WS_METHODS.openInOrigin,
        externalSessions.openInOrigin(input.key),
        traceAttributes,
      ),
  };
});
