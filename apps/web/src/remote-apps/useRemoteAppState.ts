import type { DesktopRemoteAppBridge, RemoteAppState } from "@t3tools/contracts";
import { useMemo, useSyncExternalStore } from "react";

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

/*
 * One module-level store mirrors the desktop shell's remote-app state, so no
 * provider has to wrap the app tree. The bridge subscription opens with the
 * first subscriber (`RemoteAppSync` at the app root) and closes with the last.
 */
let snapshot = DEFAULT_REMOTE_APP_STATE;
let initialized = false;
const listeners = new Set<() => void>();
let disconnect: (() => void) | null = null;

function readBridge(): DesktopRemoteAppBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.remoteApps;
}

function commit(next: RemoteAppState | null | undefined): void {
  snapshot = resolveRemoteAppState(next);
  for (const listener of listeners) listener();
}

function connect(bridge: DesktopRemoteAppBridge): () => void {
  let active = true;
  initialized = false;
  void bridge
    .getState()
    .then((next) => {
      if (!active) return;
      initialized = true;
      commit(next);
    })
    .catch(() => undefined);
  const unsubscribe = bridge.onStateChange((next) => {
    if (!active) return;
    const current = snapshot;
    if (initialized && !shouldAcceptRemoteAppState({ current, next, initialized: true })) {
      // State notifications and an IPC response can cross in flight. Do
      // not drop an opposite-surface notification outright: it may be the
      // real user transition rather than a late stale event. The main
      // process is authoritative, so re-read it before committing either
      // surface to the titlebar.
      void bridge
        .getState()
        .then((authoritative) => {
          if (!active) return;
          commit(authoritative);
        })
        .catch(() => undefined);
      return;
    }
    initialized = true;
    commit(next);
  });
  return () => {
    active = false;
    unsubscribe();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const bridge = readBridge();
  if (bridge !== undefined && disconnect === null) disconnect = connect(bridge);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && disconnect !== null) {
      disconnect();
      disconnect = null;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => DEFAULT_REMOTE_APP_STATE;

async function invoke(
  action: (current: DesktopRemoteAppBridge) => Promise<RemoteAppState>,
): Promise<void> {
  const bridge = readBridge();
  if (bridge === undefined) return;
  try {
    const next = await action(bridge);
    initialized = true;
    commit(next);
  } catch {
    // Main-process state events remain authoritative after a failed action.
  }
}

const actions = {
  setActiveSurface: (surface: RemoteAppState["activeSurface"]) =>
    invoke((current) => current.setActiveSurface(surface)),
  goBack: () => invoke((current) => current.goBack()),
  goForward: () => invoke((current) => current.goForward()),
  reload: () => invoke((current) => current.reload()),
  zoomIn: () => invoke((current) => current.zoomIn()),
  zoomOut: () => invoke((current) => current.zoomOut()),
  resetZoom: () => invoke((current) => current.resetZoom()),
  retry: () => invoke((current) => current.retry()),
  clearData: () => invoke((current) => current.clearData()),
} as const;

/** Switches the desktop window's surface without subscribing to remote-app state. */
export const setRemoteAppSurface = actions.setActiveSurface;

export function useRemoteAppState(): RemoteAppContextValue {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const bridge = readBridge();
  return useMemo(() => ({ state, bridge, ...actions }), [bridge, state]);
}

/** Only the desktop window's active surface, for components that re-render on nothing else. */
export function useRemoteAppActiveSurface(): RemoteAppState["activeSurface"] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.activeSurface,
    () => DEFAULT_REMOTE_APP_STATE.activeSurface,
  );
}
