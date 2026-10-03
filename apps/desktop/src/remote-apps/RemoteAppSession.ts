import type { RemoteAppSite } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { REMOTE_APP_SITE_DEFINITIONS } from "./RemoteAppPolicy.ts";

export class RemoteAppSessionError extends Schema.TaggedError<RemoteAppSessionError>()(
  "RemoteAppSessionError",
  {
    operation: Schema.Literals(["create", "clear"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `A dedicated remote app session failed during ${this.operation}.`;
  }
}

export class RemoteAppSession extends Context.Service<
  RemoteAppSession,
  {
    readonly partition: (site: RemoteAppSite) => string;
    readonly get: (site: RemoteAppSite) => Effect.Effect<Electron.Session, RemoteAppSessionError>;
    readonly clearData: (site: RemoteAppSite) => Effect.Effect<void, RemoteAppSessionError>;
  }
>()("@t3tools/desktop/remote-apps/RemoteAppSession") {}

export const make = Effect.sync(() => {
  const partition = (site: RemoteAppSite) => REMOTE_APP_SITE_DEFINITIONS[site].partition;
  // Electron caches sessions per partition, so repeated lookups are cheap.
  const get = (site: RemoteAppSite) =>
    Effect.try({
      try: () => Electron.session.fromPartition(partition(site)),
      catch: (cause) => new RemoteAppSessionError({ operation: "create", cause }),
    });

  return RemoteAppSession.of({
    partition,
    get,
    clearData: (site) =>
      get(site).pipe(
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
