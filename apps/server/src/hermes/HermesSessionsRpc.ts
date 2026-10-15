/**
 * WebSocket handlers for the Hermes Agent section and settings: each calls
 * one HermesSessions method. Fork add-on: Hermes provider.
 *
 * @module hermes/HermesSessionsRpc
 */
import {
  HERMES_SESSIONS_WS_METHODS,
  type HermesDashboardInput,
  type HermesSessionsContinueInput,
  type HermesSessionsDeleteInput,
  type HermesSessionsInstanceInput,
  type HermesSessionsListInput,
  type HermesSessionsUnarchiveInput,
  type HermesSessionsUpdateInput,
  type HermesT3ToolsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HermesSessions from "./HermesSessions.ts";

export const makeHandlers = Effect.gen(function* () {
  const hermes = yield* HermesSessions.HermesSessions;
  return {
    [HERMES_SESSIONS_WS_METHODS.list]: (input: HermesSessionsListInput) => hermes.list(input),
    [HERMES_SESSIONS_WS_METHODS.providers]: (input: HermesSessionsInstanceInput) =>
      hermes.providers(input.instanceId),
    [HERMES_SESSIONS_WS_METHODS.continue]: (input: HermesSessionsContinueInput) =>
      hermes.continueSession(input),
    [HERMES_SESSIONS_WS_METHODS.update]: (input: HermesSessionsUpdateInput) => hermes.update(input),
    [HERMES_SESSIONS_WS_METHODS.delete]: (input: HermesSessionsDeleteInput) =>
      hermes.deleteSessions(input),
    [HERMES_SESSIONS_WS_METHODS.listArchived]: (_input: unknown) => hermes.listArchived,
    [HERMES_SESSIONS_WS_METHODS.unarchive]: (input: HermesSessionsUnarchiveInput) =>
      hermes.unarchive(input),
    [HERMES_SESSIONS_WS_METHODS.dashboard]: (input: HermesDashboardInput) =>
      hermes.dashboard(input),
    [HERMES_SESSIONS_WS_METHODS.t3Tools]: (input: HermesT3ToolsInput) => hermes.t3Tools(input),
  };
});
