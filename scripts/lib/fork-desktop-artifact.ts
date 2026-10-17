import * as NodeFSP from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  acquireCheckoutBuildLock,
  checkoutBuildLockPath,
} from "../../apps/desktop/src/updates/CheckoutBuildLock.ts";

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

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export class CheckoutBuildLockedError extends Schema.TaggedError<CheckoutBuildLockedError>()(
  "CheckoutBuildLockedError",
  { lockPath: Schema.String, holder: Schema.optionalKey(Schema.Number) },
) {
  override get message(): string {
    const holder = this.holder === undefined ? "" : ` (process ${this.holder})`;
    return `Another desktop build${holder} is running in this checkout; wait for it to finish. Lock: ${this.lockPath}`;
  }
}

/** Runs a build holding the checkout's build lock, which local source updates respect. */
export const withCheckoutBuildLock = <A, E, R>(build: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => acquireCheckoutBuildLock(REPO_ROOT)).pipe(
      Effect.flatMap((lock) =>
        lock.acquired
          ? Effect.succeed(lock)
          : Effect.fail(
              new CheckoutBuildLockedError({
                lockPath: checkoutBuildLockPath(REPO_ROOT),
                ...(lock.holder === undefined ? {} : { holder: lock.holder }),
              }),
            ),
      ),
    ),
    () => build,
    (lock) => Effect.sync(lock.release),
  );
