import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { authorized } from "./RemoteAppIpc.ts";
import * as RemoteAppManager from "./RemoteAppManager.ts";

const event = { sender: { id: 1, getURL: () => "t3code://app/" } };

const makeCountingMethod = () => {
  const calls = { count: 0 };
  const method: DesktopIpc.DesktopIpcMethod<never, never> = {
    channel: "remote-app:test",
    handler: () =>
      Effect.sync(() => {
        calls.count += 1;
      }),
  };
  return { calls, method };
};

const layerManager = (allowed: boolean) =>
  Layer.mock(RemoteAppManager.RemoteAppManager)({
    authorizeSender: () => Effect.succeed(allowed),
  });

describe("authorized", () => {
  it.effect("rejects an unauthorized sender before running the handler", () => {
    const { calls, method } = makeCountingMethod();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(authorized(method).handler(undefined, event));

      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(calls.count, 0);
    }).pipe(Effect.provide(layerManager(false)));
  });

  it.effect("runs the handler for the authorized main renderer", () => {
    const { calls, method } = makeCountingMethod();
    return Effect.gen(function* () {
      yield* authorized(method).handler(undefined, event);

      assert.strictEqual(calls.count, 1);
    }).pipe(Effect.provide(layerManager(true)));
  });
});
