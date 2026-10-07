// Fork add-on: IPC for the "Sync fork with official T3 Code" action of local
// source builds. The handlers need LocalSourceUpdates and DesktopUpdates,
// which ForkDesktopUpdates.layer provides.
import { DesktopSourceSyncResultSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../fork/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as ForkDesktopUpdates from "./ForkDesktopUpdates.ts";
import * as LocalSourceUpdates from "./LocalSourceUpdates.ts";

export const syncSource = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SOURCE_SYNC_CHANNEL,
  payload: Schema.Void,
  result: DesktopSourceSyncResultSchema,
  handler: Effect.fn("desktop.ipc.updates.syncSource")(function* () {
    return yield* ForkDesktopUpdates.syncSource;
  }),
});

export const sourceSyncEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SOURCE_SYNC_ENABLED_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.updates.sourceSyncEnabled")(function* () {
    const localSourceUpdates = yield* LocalSourceUpdates.LocalSourceUpdates;
    return yield* localSourceUpdates.enabled;
  }),
});

export const methods = [syncSource, sourceSyncEnabled] as const;
