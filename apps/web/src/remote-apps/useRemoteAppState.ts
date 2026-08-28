import type { DesktopRemoteAppBridge, RemoteAppState } from "@t3tools/contracts";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_REMOTE_APP_STATE,
  resolveRemoteAppState,
  shouldAcceptRemoteAppState,
} from "./remoteAppState";

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
  const stateRef = useRef(DEFAULT_REMOTE_APP_STATE);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (bridge === undefined) return;
    let active = true;
    initializedRef.current = false;
    void bridge
      .getState()
      .then((next) => {
        if (!active) return;
        initializedRef.current = true;
        const resolved = resolveRemoteAppState(next);
        stateRef.current = resolved;
        setState(resolved);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onStateChange((next) => {
      if (!active) return;
      const current = stateRef.current;
      if (
        initializedRef.current &&
        !shouldAcceptRemoteAppState({ current, next, initialized: true })
      ) {
        // State notifications and an IPC response can cross in flight. Do
        // not drop an opposite-surface notification outright: it may be the
        // real user transition rather than a late stale event. The main
        // process is authoritative, so re-read it before committing either
        // surface to the titlebar.
        void bridge
          .getState()
          .then((authoritative) => {
            if (!active) return;
            const resolved = resolveRemoteAppState(authoritative);
            stateRef.current = resolved;
            setState(resolved);
          })
          .catch(() => undefined);
        return;
      }
      initializedRef.current = true;
      const resolved = resolveRemoteAppState(next);
      stateRef.current = resolved;
      setState(resolved);
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
        initializedRef.current = true;
        const resolved = resolveRemoteAppState(next);
        stateRef.current = resolved;
        setState(resolved);
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
