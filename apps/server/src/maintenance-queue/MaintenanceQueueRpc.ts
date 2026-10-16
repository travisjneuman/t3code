/**
 * WebSocket handlers for the client's update queue: each calls one
 * MaintenanceQueue method. Fork add-on: maintenance queue.
 *
 * @module maintenance-queue/MaintenanceQueueRpc
 */
import {
  MAINTENANCE_QUEUE_WS_METHODS,
  type MaintenanceReleaseProviderSessionsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MaintenanceQueue from "./MaintenanceQueue.ts";

export const makeHandlers = Effect.gen(function* () {
  const maintenanceQueue = yield* MaintenanceQueue.MaintenanceQueue;
  return {
    [MAINTENANCE_QUEUE_WS_METHODS.status]: (_input: unknown) => maintenanceQueue.status,
    [MAINTENANCE_QUEUE_WS_METHODS.releaseProviderSessions]: (
      input: MaintenanceReleaseProviderSessionsInput,
    ) => maintenanceQueue.releaseProviderSessions(input),
  };
}).pipe(Effect.provide(MaintenanceQueue.layer));
