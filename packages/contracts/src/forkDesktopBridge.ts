// Fork add-on: desktop bridge members the fork adds to upstream's DesktopBridge.
// They merge into the interface through module augmentation, so ipc.ts keeps
// upstream's declaration.
import * as Schema from "effect/Schema";

import type { DesktopRemoteAppBridge } from "./remote-apps.ts";

/** Outcome of merging upstream/main into a local source checkout without building. */
export interface DesktopSourceSyncResult {
  ok: boolean;
  /** Upstream commits merged; 0 when the checkout already had them all. */
  merged: number;
  message: string;
}

export const DesktopSourceSyncResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  merged: Schema.Number,
  message: Schema.String,
});

export interface DesktopSourceSyncBridge {
  /** True when this desktop build updates from a local source checkout. */
  isEnabled: () => Promise<boolean>;
  /** Merges the official upstream into a local source build's checkout and pushes it. */
  sync: () => Promise<DesktopSourceSyncResult>;
}

declare module "./ipc.ts" {
  interface DesktopBridge {
    /**
     * Presents a native confirmation above embedded WebContentsViews. Optional
     * so older desktop shells can continue using the renderer confirmation host.
     */
    confirm?: (message: string) => Promise<boolean>;
    /** Present in desktop builds; syncs a local source checkout with upstream. */
    sourceSync?: DesktopSourceSyncBridge;
    /** Desktop-only isolated ChatGPT surface. */
    remoteApps?: DesktopRemoteAppBridge;
  }
}
