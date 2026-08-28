import {
  DesktopSurfaceSchema,
  RemoteAppSurfaceMenuAnchorSchema,
  RemoteAppStateSchema,
  RemoteAppThemeSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as RemoteAppManager from "../../remote-apps/RemoteAppManager.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const authorize = (event: DesktopIpc.DesktopIpcInvokeEvent) =>
  Effect.gen(function* () {
    const manager = yield* RemoteAppManager.RemoteAppManager;
    return yield* manager.authorizeSender(event);
  });

const voidInput = Schema.Void;

export const setTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_APP_SET_THEME_CHANNEL,
  payload: RemoteAppThemeSchema,
  result: Schema.Void,
  authorize,
  handler: Effect.fn("desktop.ipc.remoteApp.setTheme")(function* (theme) {
    const manager = yield* RemoteAppManager.RemoteAppManager;
    yield* manager.setTheme(theme);
  }),
});

export const getState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_APP_GET_STATE_CHANNEL,
  payload: voidInput,
  result: RemoteAppStateSchema,
  authorize,
  handler: Effect.fn("desktop.ipc.remoteApp.getState")(function* () {
    const manager = yield* RemoteAppManager.RemoteAppManager;
    return yield* manager.getState;
  }),
});

export const openSurfaceMenu = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_APP_OPEN_SURFACE_MENU_CHANNEL,
  payload: RemoteAppSurfaceMenuAnchorSchema,
  result: Schema.Void,
  authorize,
  handler: Effect.fn("desktop.ipc.remoteApp.openSurfaceMenu")(function* (anchor) {
    const manager = yield* RemoteAppManager.RemoteAppManager;
    yield* manager.openSurfaceMenu(anchor);
  }),
});

export const setActiveSurface = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_APP_SET_ACTIVE_SURFACE_CHANNEL,
  payload: DesktopSurfaceSchema,
  result: RemoteAppStateSchema,
  authorize,
  handler: Effect.fn("desktop.ipc.remoteApp.setActiveSurface")(function* (surface) {
    const manager = yield* RemoteAppManager.RemoteAppManager;
    return yield* manager.setActiveSurface(surface);
  }),
});

const makeAction = <const Name extends string>(
  name: Name,
  channel: string,
  action: (
    manager: RemoteAppManager.RemoteAppManager["Service"],
  ) => Effect.Effect<
    import("@t3tools/contracts").RemoteAppState,
    RemoteAppManager.RemoteAppManagerError
  >,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: voidInput,
    result: RemoteAppStateSchema,
    authorize,
    handler: Effect.fn(`desktop.ipc.remoteApp.${name}`)(function* () {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      return yield* action(manager);
    }),
  });

export const goBack = makeAction(
  "goBack",
  IpcChannels.REMOTE_APP_GO_BACK_CHANNEL,
  (manager) => manager.goBack,
);
export const goForward = makeAction(
  "goForward",
  IpcChannels.REMOTE_APP_GO_FORWARD_CHANNEL,
  (manager) => manager.goForward,
);
export const reload = makeAction(
  "reload",
  IpcChannels.REMOTE_APP_RELOAD_CHANNEL,
  (manager) => manager.reload,
);
export const zoomIn = makeAction(
  "zoomIn",
  IpcChannels.REMOTE_APP_ZOOM_IN_CHANNEL,
  (manager) => manager.zoomIn,
);
export const zoomOut = makeAction(
  "zoomOut",
  IpcChannels.REMOTE_APP_ZOOM_OUT_CHANNEL,
  (manager) => manager.zoomOut,
);
export const resetZoom = makeAction(
  "resetZoom",
  IpcChannels.REMOTE_APP_RESET_ZOOM_CHANNEL,
  (manager) => manager.resetZoom,
);
export const retry = makeAction(
  "retry",
  IpcChannels.REMOTE_APP_RETRY_CHANNEL,
  (manager) => manager.retry,
);
export const clearData = makeAction(
  "clearData",
  IpcChannels.REMOTE_APP_CLEAR_DATA_CHANNEL,
  (manager) => manager.clearData,
);

export const methods = [
  setTheme,
  getState,
  openSurfaceMenu,
  setActiveSurface,
  goBack,
  goForward,
  reload,
  zoomIn,
  zoomOut,
  resetZoom,
  retry,
  clearData,
] as const;
