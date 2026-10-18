/**
 * Fork add-on: release facts the environment descriptor reports, so clients can show where a
 * host updates from, which fork build it runs and when it started.
 *
 * @module environment/ServerReleaseFacts
 */
import type { ServerReleaseSource } from "@t3tools/contracts";
import { CLI_RELEASE_BASE_URL_ENV, cliReleaseSourceOf } from "@t3tools/shared/cliRelease";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FORK_BUILD } from "../cloud/runtimeVersion.ts";

export const readServerReleaseFacts = Effect.gen(function* () {
  // The descriptor must never fail over a display-only fact.
  const baseUrlOverride = yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(
    Config.option,
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  const releaseSource: ServerReleaseSource = cliReleaseSourceOf(baseUrlOverride);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  return {
    releaseSource,
    startedAt,
    ...(FORK_BUILD === undefined ? {} : { forkBuild: FORK_BUILD }),
  };
});
