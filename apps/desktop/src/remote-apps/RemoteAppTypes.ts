import type { RemoteAppState } from "@t3tools/contracts";

export type RemoteAppStateListener = (state: RemoteAppState) => void;

export interface RemoteAppBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Matches the host's --workspace-topbar-height so site views start below the
// shared header line: the macOS inset titlebar is 52px, the title bar overlay
// elsewhere is 40px.
export const TITLEBAR_HEIGHT = process.platform === "darwin" ? 52 : 40;

// Site views start level with the host's Search row rather than at the header
// line, so the sidebar artwork fades out under that line on every surface.
export const REMOTE_APP_VIEW_TOP_INSET = 8;
