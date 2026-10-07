import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export {
  forkAppScheme,
  REMOTE_APP_DISTRIBUTION,
} from "../../apps/desktop/src/remote-apps/RemoteAppDistribution.ts";

export class ForkAppBundleCopyError extends Schema.TaggedError<ForkAppBundleCopyError>()(
  "ForkAppBundleCopyError",
  { source: Schema.String, destination: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not copy the packaged app from ${this.source} to ${this.destination}.`;
  }
}

/**
 * Copies an unpacked macOS `dir` build (the `mac-*` folder holding the .app) into the
 * output directory, where local source updates install it from. Symlinks are kept
 * verbatim: the framework links inside an .app are relative, and resolving them would
 * point them at the staging directory, which is deleted after the build.
 */
export const copyForkAppBundle = Effect.fn("copyForkAppBundle")(function* (
  source: string,
  destination: string,
) {
  yield* Effect.tryPromise({
    try: () => NodeFSP.cp(source, destination, { recursive: true, verbatimSymlinks: true }),
    catch: (cause) => new ForkAppBundleCopyError({ source, destination, cause }),
  });
  return destination;
});
