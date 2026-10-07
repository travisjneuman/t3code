import { useLayoutEffect } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { RemoteAppSwitcher } from "./RemoteAppSwitcher";
import { useRemoteAppState } from "./useRemoteAppState";
import "./remoteAppSurface.css";

const SURFACE_ATTRIBUTE = "data-remote-app-surface";

/**
 * The desktop titlebar strip that holds the surface switcher. While mounted it
 * mirrors the active surface onto <html> so `remoteAppSurface.css` can hand the
 * window to a remote site.
 */
export function RemoteAppTitlebar() {
  const { bridge, state } = useRemoteAppState();
  const enabled = isElectron && bridge !== undefined;
  const surface = state.activeSurface === "t3code" ? "t3code" : "remote";

  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    root.setAttribute(SURFACE_ATTRIBUTE, surface);
    return () => root.removeAttribute(SURFACE_ATTRIBUTE);
  }, [enabled, surface]);

  if (!enabled) return null;

  // Electron resolves drag regions in DOM order, ignoring pointer-events, so a
  // draggable strip here would swallow clicks on the chat header's controls.
  // It only drags while a web tab hides that header.
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center border-b border-border/60 bg-transparent",
        state.activeSurface !== "t3code" && "drag-region",
      )}
      data-remote-app-titlebar
      data-remote-app-active-surface={state.activeSurface}
    >
      <RemoteAppSwitcher />
    </div>
  );
}
