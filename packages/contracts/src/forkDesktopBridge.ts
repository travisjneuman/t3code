// Fork add-on: desktop bridge members the fork adds to upstream's DesktopBridge.
// They merge into the interface through module augmentation, so ipc.ts keeps
// upstream's declaration.
import * as Schema from "effect/Schema";

import type { DesktopUpdateActionResult } from "./ipc.ts";
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

export const DesktopSourceSyncProgressSchema = Schema.Struct({
  phase: Schema.Literals([
    "fetching",
    "merging",
    "resolving",
    "checking",
    "repairing",
    "committing",
    "pushing",
  ]),
  conflictCount: Schema.optionalKey(Schema.Number),
});
export type DesktopSourceSyncProgress = typeof DesktopSourceSyncProgressSchema.Type;

export interface DesktopSourceSyncBridge {
  /** True when this desktop build updates from a local source checkout. */
  isEnabled: () => Promise<boolean>;
  /** Merges the official upstream into a local source build's checkout and pushes it. */
  sync: () => Promise<DesktopSourceSyncResult>;
  /** Current main-process progress, including an operation started in another window. */
  getProgress?: () => Promise<DesktopSourceSyncProgress | null>;
  /** Null clears progress on completion or failure. Optional for older desktop shells. */
  onProgress?: (listener: (progress: DesktopSourceSyncProgress | null) => void) => () => void;
}

/** The app's restart into a downloaded update, held while sessions on this machine are active. */
export const DesktopUpdateGateStateSchema = Schema.Struct({
  /** Epoch milliseconds when the install was held; null when nothing waits. */
  queuedAt: Schema.NullOr(Schema.Number),
});
export type DesktopUpdateGateState = typeof DesktopUpdateGateStateSchema.Type;

export interface DesktopUpdateGateBridge {
  /** Tells the app how many sessions on this machine are active right now. */
  reportBusySessions: (count: number) => Promise<void>;
  getState: () => Promise<DesktopUpdateGateState>;
  /** Holds the install and resolves true while this machine is not yet idle. */
  holdInstallIfBusy: () => Promise<boolean>;
  /** Installs the downloaded update now, even with sessions active. */
  installNow: () => Promise<DesktopUpdateActionResult>;
  /** Drops a held install; the update stays downloaded. */
  cancel: () => Promise<void>;
  onStateChange: (listener: (state: DesktopUpdateGateState) => void) => () => void;
}

/** The host release the Mac app started for its installed build; see HostReleasePublisher. */
export const DesktopHostReleaseStatusSchema = Schema.Struct({
  /** Succeeded also covers a commit that was already published. */
  state: Schema.Literals(["running", "succeeded", "failed"]),
  /** The fork commit released; empty when the release could not start. */
  commit: Schema.String,
  startedAt: Schema.Number,
  /** Why it failed: the tool's last output line, or why it never started. */
  detail: Schema.NullOr(Schema.String),
  logPath: Schema.String,
});
export type DesktopHostReleaseStatus = typeof DesktopHostReleaseStatusSchema.Type;

export interface DesktopHostReleaseBridge {
  /** Null until this app has started a release. */
  getStatus: () => Promise<DesktopHostReleaseStatus | null>;
  /** Starts the release again for the installed build, unless one is running. */
  retry: () => Promise<DesktopHostReleaseStatus | null>;
  onStatusChange: (listener: (status: DesktopHostReleaseStatus) => void) => () => void;
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
    /** Present in desktop builds; holds update restarts while sessions are active. */
    updateGate?: DesktopUpdateGateBridge;
    /** Present in local source builds on macOS; releases the build to the fork hosts. */
    hostRelease?: DesktopHostReleaseBridge;
  }
}
