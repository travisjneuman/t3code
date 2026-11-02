/**
 * WebSocket handlers for the OpenBot section: each calls one OpenBotSessions
 * method. Fork add-on: OpenBot provider.
 *
 * @module openbot/OpenBotSessionsRpc
 */
import {
  OPENBOT_SESSIONS_WS_METHODS,
  type OpenBotSessionsListInput,
  type OpenBotSessionsNewChatInput,
  type OpenBotSessionsOpenInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as OpenBotSessions from "./OpenBotSessions.ts";

export const makeHandlers = Effect.gen(function* () {
  const openbot = yield* OpenBotSessions.OpenBotSessions;
  return {
    [OPENBOT_SESSIONS_WS_METHODS.list]: (input: OpenBotSessionsListInput) => openbot.list(input),
    [OPENBOT_SESSIONS_WS_METHODS.open]: (input: OpenBotSessionsOpenInput) => openbot.open(input),
    [OPENBOT_SESSIONS_WS_METHODS.newChat]: (input: OpenBotSessionsNewChatInput) =>
      openbot.newChat(input),
  };
});
