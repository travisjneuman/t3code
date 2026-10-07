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

import * as ExternalSessions from "./ExternalSessions.ts";

export const makeHandlers = Effect.gen(function* () {
  const externalSessions = yield* ExternalSessions.ExternalSessions;
  return {
    [EXTERNAL_SESSIONS_WS_METHODS.subscribeList]: (_input: unknown) =>
      externalSessions.subscribeList,
    [EXTERNAL_SESSIONS_WS_METHODS.subscribeSession]: (input: { readonly key: string }) =>
      externalSessions.subscribeSession(input.key),
    [EXTERNAL_SESSIONS_WS_METHODS.continue]: (input: ExternalSessionContinueInput) =>
      externalSessions.continueSession(input),
    [EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere]: (_input: unknown) =>
      externalSessions.subscribeRunningElsewhere.pipe(Stream.map((threadIds) => ({ threadIds }))),
    [EXTERNAL_SESSIONS_WS_METHODS.archive]: (input: ExternalSessionArchiveInput) =>
      externalSessions.archiveSession(input),
    [EXTERNAL_SESSIONS_WS_METHODS.unarchive]: (input: ExternalSessionUnarchiveInput) =>
      externalSessions.unarchiveSession(input.key),
    [EXTERNAL_SESSIONS_WS_METHODS.subscribeArchived]: (_input: unknown) =>
      externalSessions.subscribeArchived,
    [EXTERNAL_SESSIONS_WS_METHODS.handBack]: (input: ExternalSessionHandBackInput) =>
      externalSessions.handBack(input.threadId),
    [EXTERNAL_SESSIONS_WS_METHODS.release]: (input: ExternalSessionReleaseInput) =>
      externalSessions.release(input.threadId),
    [EXTERNAL_SESSIONS_WS_METHODS.openInOrigin]: (input: ExternalSessionOpenInOriginInput) =>
      externalSessions.openInOrigin(input.key),
  };
});
