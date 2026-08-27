import type { DesktopRemoteAppBridge, RemoteAppState } from "@t3tools/contracts";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { DEFAULT_REMOTE_APP_STATE, resolveRemoteAppState } from "./remoteAppState";

interface RemoteAppContextValue {
  readonly state: RemoteAppState;
  readonly bridge: DesktopRemoteAppBridge | undefined;
  readonly setActiveSurface: (surface: RemoteAppState["activeSurface"]) => Promise<void>;
  readonly goBack: () => Promise<void>;
  readonly goForward: () => Promise<void>;
  readonly reload: () => Promise<void>;
  readonly zoomIn: () => Promise<void>;
  readonly zoomOut: () => Promise<void>;
  readonly resetZoom: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly clearData: () => Promise<void>;
}

const RemoteAppContext = createContext<RemoteAppContextValue | null>(null);

export function RemoteAppProvider({ children }: { readonly children: ReactNode }) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.remoteApps;
  const [state, setState] = useState(DEFAULT_REMOTE_APP_STATE);

  useEffect(() => {
    if (bridge === undefined) return;
    let active = true;
    void bridge
      .getState()
      .then((next) => {
        if (active) setState(resolveRemoteAppState(next));
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onStateChange((next) => {
      if (active) setState(resolveRemoteAppState(next));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  const invoke = useCallback(
    async (action: (current: DesktopRemoteAppBridge) => Promise<RemoteAppState>) => {
      if (bridge === undefined) return;
      try {
        const next = await action(bridge);
        setState(resolveRemoteAppState(next));
      } catch {
        // Main-process state events remain authoritative after a failed action.
      }
    },
    [bridge],
  );
  const value = useMemo<RemoteAppContextValue>(
    () => ({
      state,
      bridge,
      setActiveSurface: (surface) => invoke((current) => current.setActiveSurface(surface)),
      goBack: () => invoke((current) => current.goBack()),
      goForward: () => invoke((current) => current.goForward()),
      reload: () => invoke((current) => current.reload()),
      zoomIn: () => invoke((current) => current.zoomIn()),
      zoomOut: () => invoke((current) => current.zoomOut()),
      resetZoom: () => invoke((current) => current.resetZoom()),
      retry: () => invoke((current) => current.retry()),
      clearData: () => invoke((current) => current.clearData()),
    }),
    [bridge, invoke, state],
  );

  return createElement(RemoteAppContext.Provider, { value }, children);
}

export function useRemoteAppState(): RemoteAppContextValue {
  const value = useContext(RemoteAppContext);
  if (value === null) {
    return {
      state: DEFAULT_REMOTE_APP_STATE,
      bridge: undefined,
      setActiveSurface: async () => undefined,
      goBack: async () => undefined,
      goForward: async () => undefined,
      reload: async () => undefined,
      zoomIn: async () => undefined,
      zoomOut: async () => undefined,
      resetZoom: async () => undefined,
      retry: async () => undefined,
      clearData: async () => undefined,
    };
  }
  return value;
}
