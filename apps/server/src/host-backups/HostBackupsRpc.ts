/**
 * WebSocket handler for the host backups listing: calls one HostBackups method.
 * Fork add-on: host backups.
 *
 * @module host-backups/HostBackupsRpc
 */
import { HOST_BACKUPS_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HostBackups from "./HostBackups.ts";

export const makeHandlers = Effect.gen(function* () {
  const hostBackups = yield* HostBackups.HostBackups;
  return {
    [HOST_BACKUPS_WS_METHODS.list]: (_input: unknown) => hostBackups.list,
  };
}).pipe(Effect.provide(HostBackups.layer));
