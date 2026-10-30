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
