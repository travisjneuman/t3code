// Fork add-on: the desktop bridge for merging upstream into a local source checkout.
import * as Schema from "effect/Schema";

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

declare module "./ipc.ts" {
  interface DesktopBridge {
    /** Present in desktop builds; syncs a local source checkout with upstream. */
    sourceSync?: DesktopSourceSyncBridge;
  }
}
