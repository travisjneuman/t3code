/**
 * WebSocket handler for thread retention storage, kept beside the service so the fork RPC
 * handlers only spread it in. Each connection gets its own service (and cache).
 *
 * @module thread-retention/ThreadRetentionRpc
 */
import { THREAD_RETENTION_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadRetentionStorage from "./ThreadRetentionStorage.ts";

export const makeHandlers = Effect.gen(function* () {
  const retention = yield* ThreadRetentionStorage.ThreadRetentionStorage;
  return {
    [THREAD_RETENTION_WS_METHODS.storage]: (_input: unknown) => retention.storage,
  };
}).pipe(Effect.provide(ThreadRetentionStorage.layer));
