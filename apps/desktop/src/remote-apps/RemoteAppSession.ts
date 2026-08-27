import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { REMOTE_APP_PARTITION } from "./RemoteAppPolicy.ts";

export class RemoteAppSessionError extends Schema.TaggedErrorClass<RemoteAppSessionError>()(
  "RemoteAppSessionError",
  {
    operation: Schema.Literals(["create", "clear"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The dedicated ChatGPT session failed during ${this.operation}.`;
  }
}

export class RemoteAppSession extends Context.Service<
  RemoteAppSession,
  {
    readonly partition: typeof REMOTE_APP_PARTITION;
    readonly get: Effect.Effect<Electron.Session, RemoteAppSessionError>;
    readonly clearData: Effect.Effect<void, RemoteAppSessionError>;
  }
>()("@t3tools/desktop/remote-apps/RemoteAppSession") {}

export const make = Effect.gen(function* () {
  const sessionRef = yield* Ref.make<Option.Option<Electron.Session>>(Option.none());

  const get = Effect.gen(function* () {
    const current = yield* Ref.get(sessionRef);
    if (Option.isSome(current)) return current.value;
    const session = yield* Effect.try({
      try: () => Electron.session.fromPartition(REMOTE_APP_PARTITION),
      catch: (cause) => new RemoteAppSessionError({ operation: "create", cause }),
    });
    yield* Ref.set(sessionRef, Option.some(session));
    return session;
  });

  return RemoteAppSession.of({
    partition: REMOTE_APP_PARTITION,
    get,
    clearData: get.pipe(
      Effect.flatMap((session) =>
        Effect.tryPromise({
          try: async () => {
            await session.clearStorageData({
              storages: [
                "cookies",
                "filesystem",
                "indexdb",
                "localstorage",
                "shadercache",
                "websql",
                "serviceworkers",
                "cachestorage",
              ],
              quotas: ["temporary"],
            });
            await session.clearCache();
          },
          catch: (cause) => new RemoteAppSessionError({ operation: "clear", cause }),
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(RemoteAppSession, make);
