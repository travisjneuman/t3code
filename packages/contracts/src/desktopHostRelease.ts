// Fork add-on: the desktop bridge for the host release a local source build starts.
import * as Schema from "effect/Schema";

/** Local host fleet build status reported by the source-built Mac app. */
export const DesktopHostReleaseStatusSchema = Schema.Struct({
  /** Succeeded means every configured host staged this commit locally. */
  state: Schema.Literals(["running", "succeeded", "failed"]),
  /** The fork commit built; empty when the build could not start. */
  commit: Schema.String,
  startedAt: Schema.Number,
  /** Available only after a successful build across all configured hosts. */
  targetVersion: Schema.optionalKey(Schema.String),
  /** Why it failed: the tool's last output line, or why it never started. */
  detail: Schema.NullOr(Schema.String),
  logPath: Schema.String,
});
export type DesktopHostReleaseStatus = typeof DesktopHostReleaseStatusSchema.Type;

export interface DesktopHostReleaseBridge {
  /** Null until this app has observed or started a local host build. */
  getStatus: () => Promise<DesktopHostReleaseStatus | null>;
  /** Retries the existing failed local build at its recorded commit. */
  retry: () => Promise<DesktopHostReleaseStatus | null>;
  onStatusChange: (listener: (status: DesktopHostReleaseStatus) => void) => () => void;
}

declare module "./ipc.ts" {
  interface DesktopBridge {
    /** Present in local source builds on macOS; builds and stages fork hosts on explicit Update. */
    hostRelease?: DesktopHostReleaseBridge;
  }
}
