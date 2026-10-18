// Fork add-on: IPC for the host release the Mac app starts for its installed
// build. ForkDesktopUpdates.layer provides HostReleasePublisher.
import { DesktopHostReleaseStatusSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../fork/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as HostReleasePublisher from "./HostReleasePublisher.ts";

export const getStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.HOST_RELEASE_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopHostReleaseStatusSchema),
  handler: Effect.fn("desktop.ipc.hostRelease.getStatus")(function* () {
    return yield* (yield* HostReleasePublisher.HostReleasePublisher).getStatus;
  }),
});

export const retry = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.HOST_RELEASE_RETRY_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopHostReleaseStatusSchema),
  handler: Effect.fn("desktop.ipc.hostRelease.retry")(function* () {
    return yield* (yield* HostReleasePublisher.HostReleasePublisher).retry;
  }),
});

export const methods = [getStatus, retry] as const;
