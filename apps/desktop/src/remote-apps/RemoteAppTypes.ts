import type { RemoteAppState } from "@t3tools/contracts";

export type RemoteAppStateListener = (state: RemoteAppState) => void;

export interface RemoteAppBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const TITLEBAR_HEIGHT = 40;
