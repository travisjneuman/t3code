// Fork add-on desktop bridge members. The preload spreads these into the
// upstream desktopBridge object, so this file imports only channel constants
// and contract types, never Effect services.
import type {
  DesktopBridge,
  RemoteAppDownloadCapture,
  RemoteAppPanelNavigated,
  RemoteAppSendToThread,
  RemoteAppSite,
  RemoteAppState,
} from "@t3tools/contracts";

import * as IpcChannels from "./channels.ts";

type ForkDesktopBridge = Required<Pick<DesktopBridge, "confirm" | "sourceSync" | "remoteApps">>;

// Mirrors RemoteAppSiteSchema; the preload imports contract types only.
const REMOTE_APP_SURFACES = new Set([
  "t3code",
  "chatgpt",
  "claude",
  "grok",
  "gemini",
  "perplexity",
]);

function isRemoteAppSiteValue(value: unknown): value is RemoteAppSite {
  return typeof value === "string" && value !== "t3code" && REMOTE_APP_SURFACES.has(value);
}

function isRemoteAppPanelNavigated(value: unknown): value is RemoteAppPanelNavigated {
  if (typeof value !== "object" || value === null) return false;
  const navigated = value as Partial<RemoteAppPanelNavigated>;
  return (
    isRemoteAppSiteValue(navigated.site) &&
    (navigated.url === null || typeof navigated.url === "string")
  );
}

function isRemoteAppState(value: unknown): value is RemoteAppState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<RemoteAppState>;
  return (
    state.schemaVersion === 1 &&
    typeof state.activeSurface === "string" &&
    REMOTE_APP_SURFACES.has(state.activeSurface) &&
    typeof state.currentTitle === "string" &&
    typeof state.zoomFactor === "number" &&
    Array.isArray(state.recents)
  );
}

function isRemoteAppSendToThread(value: unknown): value is RemoteAppSendToThread {
  if (typeof value !== "object" || value === null) return false;
  const send = value as Partial<RemoteAppSendToThread>;
  return isRemoteAppSiteValue(send.site) && typeof send.text === "string" && send.text.length > 0;
}

function isRemoteAppDownloadCapture(value: unknown): value is RemoteAppDownloadCapture {
  if (typeof value !== "object" || value === null) return false;
  const capture = value as Partial<RemoteAppDownloadCapture>;
  return (
    typeof capture.id === "string" &&
    isRemoteAppSiteValue(capture.site) &&
    typeof capture.filename === "string" &&
    typeof capture.path === "string" &&
    (capture.kind === "text" || capture.kind === "archive") &&
    typeof capture.bytes === "number" &&
    typeof capture.language === "string" &&
    (capture.text === null || typeof capture.text === "string") &&
    typeof capture.addNow === "boolean"
  );
}

export function makeForkDesktopBridge(ipcRenderer: Electron.IpcRenderer): ForkDesktopBridge {
  return {
    confirm: (message) => ipcRenderer.invoke(IpcChannels.CONFIRM_DIALOG_CHANNEL, message),
    sourceSync: {
      isEnabled: () => ipcRenderer.invoke(IpcChannels.SOURCE_SYNC_ENABLED_CHANNEL),
      sync: () => ipcRenderer.invoke(IpcChannels.SOURCE_SYNC_CHANNEL),
    },
    remoteApps: {
      getState: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_GET_STATE_CHANNEL),
      setTheme: (theme) => ipcRenderer.invoke(IpcChannels.REMOTE_APP_SET_THEME_CHANNEL, theme),
      openSurfaceMenu: (anchor) =>
        ipcRenderer.invoke(IpcChannels.REMOTE_APP_OPEN_SURFACE_MENU_CHANNEL, anchor),
      setAvailableSites: (availability) =>
        ipcRenderer.invoke(IpcChannels.REMOTE_APP_SET_AVAILABLE_SITES_CHANNEL, availability),
      setActiveSurface: (surface) =>
        ipcRenderer.invoke(IpcChannels.REMOTE_APP_SET_ACTIVE_SURFACE_CHANNEL, surface),
      goBack: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_GO_BACK_CHANNEL),
      goForward: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_GO_FORWARD_CHANNEL),
      reload: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_RELOAD_CHANNEL),
      zoomIn: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_ZOOM_IN_CHANNEL),
      zoomOut: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_ZOOM_OUT_CHANNEL),
      resetZoom: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_RESET_ZOOM_CHANNEL),
      retry: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_RETRY_CHANNEL),
      clearData: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_CLEAR_DATA_CHANNEL),
      fillSitePrompt: (request) =>
        ipcRenderer.invoke(IpcChannels.REMOTE_APP_FILL_SITE_PROMPT_CHANNEL, request),
      onStateChange: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
          if (isRemoteAppState(state)) listener(state);
        };
        ipcRenderer.on(IpcChannels.REMOTE_APP_STATE_CHANGE_CHANNEL, wrappedListener);
        return () => {
          ipcRenderer.removeListener(IpcChannels.REMOTE_APP_STATE_CHANGE_CHANNEL, wrappedListener);
        };
      },
      onSendToThread: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, send: unknown) => {
          if (isRemoteAppSendToThread(send)) listener(send);
        };
        ipcRenderer.on(IpcChannels.REMOTE_APP_SEND_TO_THREAD_CHANNEL, wrappedListener);
        return () => {
          ipcRenderer.removeListener(
            IpcChannels.REMOTE_APP_SEND_TO_THREAD_CHANNEL,
            wrappedListener,
          );
        };
      },
      onDownloadCaptured: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, capture: unknown) => {
          if (isRemoteAppDownloadCapture(capture)) listener(capture);
        };
        ipcRenderer.on(IpcChannels.REMOTE_APP_DOWNLOAD_CAPTURED_CHANNEL, wrappedListener);
        return () => {
          ipcRenderer.removeListener(
            IpcChannels.REMOTE_APP_DOWNLOAD_CAPTURED_CHANNEL,
            wrappedListener,
          );
        };
      },
      showDownloadInFolder: (id) =>
        ipcRenderer.invoke(IpcChannels.REMOTE_APP_SHOW_DOWNLOAD_CHANNEL, id),
      importChatExport: () => ipcRenderer.invoke(IpcChannels.REMOTE_APP_IMPORT_CHAT_EXPORT_CHANNEL),
      attachPanel: (site, webContentsId) =>
        ipcRenderer.invoke(IpcChannels.REMOTE_APP_ATTACH_PANEL_CHANNEL, { site, webContentsId }),
      setPanelVisible: (site, visible) =>
        ipcRenderer.invoke(IpcChannels.REMOTE_APP_SET_PANEL_VISIBLE_CHANNEL, { site, visible }),
      navigatePanel: (site, url) =>
        ipcRenderer.invoke(IpcChannels.REMOTE_APP_NAVIGATE_PANEL_CHANNEL, { site, url }),
      onPanelNavigated: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, navigated: unknown) => {
          if (isRemoteAppPanelNavigated(navigated)) listener(navigated);
        };
        ipcRenderer.on(IpcChannels.REMOTE_APP_PANEL_NAVIGATED_CHANNEL, wrappedListener);
        return () => {
          ipcRenderer.removeListener(
            IpcChannels.REMOTE_APP_PANEL_NAVIGATED_CHANNEL,
            wrappedListener,
          );
        };
      },
      onOpenInPanel: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, site: unknown) => {
          if (isRemoteAppSiteValue(site)) listener(site);
        };
        ipcRenderer.on(IpcChannels.REMOTE_APP_OPEN_IN_PANEL_CHANNEL, wrappedListener);
        return () => {
          ipcRenderer.removeListener(IpcChannels.REMOTE_APP_OPEN_IN_PANEL_CHANNEL, wrappedListener);
        };
      },
    },
  };
}
