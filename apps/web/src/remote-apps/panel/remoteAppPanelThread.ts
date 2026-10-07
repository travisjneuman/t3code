import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

/*
 * The thread the chat view shows, published for the app-wide panel host, the
 * tab menus, and the command palette. A tiny module store, so the chat view
 * only writes it from an effect and never re-renders because of it.
 */
let activeThread: ScopedThreadRef | null = null;
const listeners = new Set<() => void>();

function publish(ref: ScopedThreadRef | null): void {
  if (activeThread === ref) return;
  activeThread = ref;
  for (const listener of listeners) listener();
}

export function subscribeActiveRemoteAppPanelThread(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getActiveRemoteAppPanelThread = (): ScopedThreadRef | null => activeThread;

/** Called by the chat view with the thread it shows. */
export function useRemoteAppPanelThread(ref: ScopedThreadRef | null): void {
  useEffect(() => {
    if (ref === null) return;
    publish(ref);
    return () => {
      if (activeThread === ref) publish(null);
    };
  }, [ref]);
}

/** The thread the chat view shows, or null while no chat view is open. */
export function useActiveRemoteAppPanelThread(): ScopedThreadRef | null {
  return useSyncExternalStore(
    subscribeActiveRemoteAppPanelThread,
    getActiveRemoteAppPanelThread,
    () => null,
  );
}
