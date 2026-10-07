import * as Effect from "effect/Effect";

import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as RemoteAppIpc from "../remote-apps/RemoteAppIpc.ts";
import * as LocalSourceIpc from "../updates/LocalSourceIpc.ts";
import { confirm } from "./confirm.ts";

/** Registers every fork add-on IPC method next to the upstream handlers. */
export const installForkIpcHandlers = Effect.fn("desktop.ipc.installForkHandlers")(function* (
  ipc: DesktopIpc.DesktopIpc["Service"],
) {
  yield* ipc.handle(confirm);
  for (const sourceSyncMethod of LocalSourceIpc.methods) {
    yield* ipc.handle(sourceSyncMethod);
  }
  for (const remoteAppMethod of RemoteAppIpc.methods) {
    yield* ipc.handle(remoteAppMethod);
  }
});
