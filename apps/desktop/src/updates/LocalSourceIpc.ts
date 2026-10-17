// Fork add-on: IPC for the "Sync fork with official T3 Code" action of local
// source builds. The handlers need LocalSourceUpdates and DesktopUpdates,
// which ForkDesktopUpdates.layer provides.
import {
  DesktopSourceSyncProgressSchema,
  DesktopSourceSyncResultSchema,
  type DesktopSourceSyncProgress,
  type DesktopSourceSyncResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../fork/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as ForkDesktopUpdates from "./ForkDesktopUpdates.ts";
import * as LocalSourceUpdates from "./LocalSourceUpdates.ts";

// State belongs to the installed handlers, not a renderer or an individual invoke.
export const makeMethods = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const progressRef = yield* Ref.make<DesktopSourceSyncProgress | null>(null);
  const inFlightRef = yield* Ref.make<Deferred.Deferred<DesktopSourceSyncResult> | null>(null);
  const publishProgress = (progress: DesktopSourceSyncProgress | null) =>
    Ref.set(progressRef, progress).pipe(
      Effect.andThen(
        electronWindow
          .sendAll(IpcChannels.SOURCE_SYNC_PROGRESS_CHANNEL, progress)
          .pipe(Effect.ignoreCause),
      ),
    );

  const syncSource = DesktopIpc.makeIpcMethod({
    channel: IpcChannels.SOURCE_SYNC_CHANNEL,
    payload: Schema.Void,
    result: DesktopSourceSyncResultSchema,
    handler: Effect.fn("desktop.ipc.updates.syncSource")(function* () {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<DesktopSourceSyncResult>();
          const shared = yield* Ref.modify(inFlightRef, (current) => {
            const next = current ?? candidate;
            return [next, next] as const;
          });
          if (shared === candidate) {
            // Publish busy even while waiting for the checkout lock. Closing a window
            // must not cancel the shared operation or clear another window's progress.
            yield* publishProgress({ phase: "fetching" });
            yield* Effect.uninterruptibleMask((run) =>
              ForkDesktopUpdates.syncSource.pipe(
                Effect.provideService(LocalSourceUpdates.SourceSyncProgress, publishProgress),
                run,
                Effect.exit,
                Effect.flatMap((exit) =>
                  publishProgress(null).pipe(
                    Effect.andThen(Deferred.done(shared, exit)),
                    Effect.andThen(Ref.set(inFlightRef, null)),
                  ),
                ),
              ),
            ).pipe(Effect.forkIn(scope));
          }
          return yield* restore(Deferred.await(shared));
        }),
      );
    }),
  });

  const sourceSyncEnabled = DesktopIpc.makeIpcMethod({
    channel: IpcChannels.SOURCE_SYNC_ENABLED_CHANNEL,
    payload: Schema.Void,
    result: Schema.Boolean,
    handler: Effect.fn("desktop.ipc.updates.sourceSyncEnabled")(function* () {
      const localSourceUpdates = yield* LocalSourceUpdates.LocalSourceUpdates;
      return yield* localSourceUpdates.enabled;
    }),
  });

  const sourceSyncProgress = DesktopIpc.makeIpcMethod({
    channel: IpcChannels.SOURCE_SYNC_PROGRESS_GET_CHANNEL,
    payload: Schema.Void,
    result: Schema.NullOr(DesktopSourceSyncProgressSchema),
    handler: () => Ref.get(progressRef),
  });

  return [syncSource, sourceSyncEnabled, sourceSyncProgress] as const;
});
