import type { ConfirmDialogOptions, ContextMenuItem, LocalApi } from "@t3tools/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";

let cachedApi: LocalApi | undefined;

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message, options?: ConfirmDialogOptions) => {
        return requestConfirmDialog(message, options) ?? false;
      },
    },
    shell: {
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
      // A native desktop menu blocks keyboard input and closes on outside
      // interaction, so nothing to do there; the DOM fallback needs an explicit
      // dismiss when the state behind it goes away.
      close: async () => {
        if (!window.desktopBridge) {
          dismissContextMenu();
        }
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

/**
 * Remote WebContentsViews are composited above the host renderer. Use the
 * native confirmation surface for update installation while ChatGPT is active
 * so the prompt remains visible and clickable without changing surface state.
 */
export async function confirmDesktopUpdateInstall(message: string): Promise<boolean> {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const nativeConfirm = bridge?.confirm;
  const remoteApps = bridge?.remoteApps;
  if (typeof nativeConfirm === "function" && remoteApps) {
    try {
      const state = await remoteApps.getState();
      if (state.activeSurface === "chatgpt") return nativeConfirm(message);
    } catch {
      // Fall through to the renderer confirmation if an older shell or a
      // transient remote-app state lookup cannot provide the native prompt.
    }
  }
  return ensureLocalApi().dialogs.confirm(message);
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  resetRequestLatencyStateForTests();
}
