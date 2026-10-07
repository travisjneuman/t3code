import {
  DesktopSurfaceSchema,
  PositiveInt,
  RemoteAppAvailabilitySchema,
  RemoteAppChatImportResultSchema,
  RemoteAppDownloadIdSchema,
  RemoteAppFillPromptRequestSchema,
  RemoteAppFillPromptResultSchema,
  RemoteAppPanelNavigatedSchema,
  RemoteAppSiteSchema,
  RemoteAppSurfaceMenuAnchorSchema,
  RemoteAppStateSchema,
  RemoteAppThemeSchema,
  type RemoteAppState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../fork/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as RemoteAppManager from "./RemoteAppManager.ts";

/**
 * Remote app methods answer only the main window's own renderer. The sender is
 * checked before the payload is decoded, so a rejected call never reaches the
 * handler.
 */
export const authorized = <E, R>(
  method: DesktopIpc.DesktopIpcMethod<E, R>,
): DesktopIpc.DesktopIpcMethod<E, R | RemoteAppManager.RemoteAppManager> => ({
  channel: method.channel,
  handler: (raw, event) =>
    Effect.gen(function* () {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      const sender: RemoteAppManager.RemoteAppIpcSender | undefined = event?.sender;
      if (!(yield* manager.authorizeSender(sender))) {
        return yield* Effect.die(
          new Error(`Rejected unauthorized desktop IPC invocation for ${method.channel}.`),
        );
      }
      return yield* method.handler(raw, event);
    }),
});

const voidInput = Schema.Void;

export const setTheme = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_SET_THEME_CHANNEL,
    payload: RemoteAppThemeSchema,
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.remoteApp.setTheme")(function* (theme) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      yield* manager.setTheme(theme);
    }),
  }),
);

export const getState = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_GET_STATE_CHANNEL,
    payload: voidInput,
    result: RemoteAppStateSchema,
    handler: Effect.fn("desktop.ipc.remoteApp.getState")(function* () {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      return yield* manager.getState;
    }),
  }),
);

export const openSurfaceMenu = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_OPEN_SURFACE_MENU_CHANNEL,
    payload: RemoteAppSurfaceMenuAnchorSchema,
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.remoteApp.openSurfaceMenu")(function* (anchor) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      yield* manager.openSurfaceMenu(anchor);
    }),
  }),
);

export const setAvailableSites = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_SET_AVAILABLE_SITES_CHANNEL,
    payload: RemoteAppAvailabilitySchema,
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.remoteApp.setAvailableSites")(function* (availability) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      yield* manager.setAvailableSites(availability);
    }),
  }),
);

export const setActiveSurface = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_SET_ACTIVE_SURFACE_CHANNEL,
    payload: DesktopSurfaceSchema,
    result: RemoteAppStateSchema,
    handler: Effect.fn("desktop.ipc.remoteApp.setActiveSurface")(function* (surface) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      return yield* manager.setActiveSurface(surface);
    }),
  }),
);

export const fillSitePrompt = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_FILL_SITE_PROMPT_CHANNEL,
    payload: RemoteAppFillPromptRequestSchema,
    result: RemoteAppFillPromptResultSchema,
    handler: Effect.fn("desktop.ipc.remoteApp.fillSitePrompt")(function* (request) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      return yield* manager.fillSitePrompt(request);
    }),
  }),
);

export const showDownloadInFolder = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_SHOW_DOWNLOAD_CHANNEL,
    payload: RemoteAppDownloadIdSchema,
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.remoteApp.showDownloadInFolder")(function* (id) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      yield* manager.showDownloadInFolder(id);
    }),
  }),
);

export const importChatExport = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_IMPORT_CHAT_EXPORT_CHANNEL,
    payload: voidInput,
    result: RemoteAppChatImportResultSchema,
    handler: Effect.fn("desktop.ipc.remoteApp.importChatExport")(function* () {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      return yield* manager.importChatExport;
    }),
  }),
);

// Side panel: the preload sends each call's arguments as one object.

export const attachPanel = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_ATTACH_PANEL_CHANNEL,
    payload: Schema.Struct({ site: RemoteAppSiteSchema, webContentsId: PositiveInt }),
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.remoteApp.attachPanel")(function* ({ site, webContentsId }) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      yield* manager.attachPanel(site, webContentsId);
    }),
  }),
);

export const setPanelVisible = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_SET_PANEL_VISIBLE_CHANNEL,
    payload: Schema.Struct({ site: RemoteAppSiteSchema, visible: Schema.Boolean }),
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.remoteApp.setPanelVisible")(function* ({ site, visible }) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      yield* manager.setPanelVisible(site, visible);
    }),
  }),
);

export const navigatePanel = authorized(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOTE_APP_NAVIGATE_PANEL_CHANNEL,
    // Same shape the shell reports through onPanelNavigated.
    payload: RemoteAppPanelNavigatedSchema,
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.remoteApp.navigatePanel")(function* ({ site, url }) {
      const manager = yield* RemoteAppManager.RemoteAppManager;
      yield* manager.navigatePanel(site, url);
    }),
  }),
);

const makeAction = <const Name extends string>(
  name: Name,
  channel: string,
  action: (
    manager: RemoteAppManager.RemoteAppManager["Service"],
  ) => Effect.Effect<RemoteAppState, RemoteAppManager.RemoteAppManagerError>,
) =>
  authorized(
    DesktopIpc.makeIpcMethod({
      channel,
      payload: voidInput,
      result: RemoteAppStateSchema,
      handler: Effect.fn(`desktop.ipc.remoteApp.${name}`)(function* () {
        const manager = yield* RemoteAppManager.RemoteAppManager;
        return yield* action(manager);
      }),
    }),
  );

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
  setAvailableSites,
  setActiveSurface,
  goBack,
  goForward,
  reload,
  zoomIn,
  zoomOut,
  resetZoom,
  retry,
  clearData,
  fillSitePrompt,
  showDownloadInFolder,
  importChatExport,
  attachPanel,
  setPanelVisible,
  navigatePanel,
] as const;
