import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ServerConfig } from "@t3tools/contracts";
import {
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import type { ServerUpdateOutcome } from "~/components/ServerUpdateAction";
import {
  collectServerUpdateTargets,
  type UpdateEverythingMachine,
} from "~/components/sidebar/updateEverything.logic";
import { resolveVersionMismatch, type VersionMismatch } from "~/versionSkew";

// Remote servers update to the newest published fork release, not to this client's version:
// the Mac builds from source at every upstream nightly, but hosts can only install a version
// that has a release archive. A host at or past that release is current.

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(ReleaseIndex);

const RELEASE_INDEX_PAGE_SIZE = 100;
const RELEASE_INDEX_MAX_PAGES = 3;

function releaseTagVersion(tag: string): string | undefined {
  return /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag)?.[1];
}

/** API order is not version order, and a release newer than this client is not offered. */
export function newestPublishedHostRelease(
  releases: ReadonlyArray<{ readonly tag_name: string; readonly draft?: boolean | undefined }>,
  clientVersion: string,
): string | undefined {
  const eligible = releases
    .flatMap((release) => {
      const version = releaseTagVersion(release.tag_name);
      return version !== undefined && compareSemverVersions(version, clientVersion) <= 0
        ? [{ release, version }]
        : [];
    })
    .toSorted((a, b) => compareSemverVersions(b.version, a.version))
    .map(({ release }) => release);
  return newestCliReleaseVersion(eligible, cliReleaseChannelOf(clientVersion));
}

const hostReleaseAtom = Atom.make(
  Effect.gen(function* () {
    const releases: Array<{ readonly tag_name: string; readonly draft?: boolean }> = [];
    for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
      const response = yield* HttpClient.get(cliReleaseIndexPageUrl(page));
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
        Effect.flatMap(decodeReleaseIndex),
      );
      releases.push(...body);
      if (body.length < RELEASE_INDEX_PAGE_SIZE) break;
    }
    return newestPublishedHostRelease(releases, APP_VERSION) ?? null;
  }).pipe(
    // Tracing headers would make the browser send a CORS preflight.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provide(FetchHttpClient.layer),
  ),
).pipe(Atom.keepAlive, Atom.withLabel("fork-host-release"));

/**
 * The version remote servers should run, or null while it is unknown. Unknown offers no
 * update at all, so a version without a release archive is never offered.
 */
export function useHostUpdateTarget(): string | null {
  const result = useAtomValue(hostReleaseAtom);
  // A failed refresh keeps the previous success, which may name a release since deleted.
  return AsyncResult.isSuccess(result) ? result.value : null;
}

/** Unauthenticated GitHub API calls are limited per IP, so this runs on app start and on demand. */
export function useRefreshHostUpdateTarget(): () => void {
  return useAtomRefresh(hostReleaseAtom);
}

export function resolveHostVersionMismatch(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
  hostUpdateTarget: string | null,
): VersionMismatch | null {
  return hostUpdateTarget === null
    ? null
    : resolveVersionMismatch(serverConfig?.environment.serverVersion, hostUpdateTarget);
}

export function useHostVersionMismatch(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): VersionMismatch | null {
  return resolveHostVersionMismatch(serverConfig, useHostUpdateTarget());
}

export function collectHostUpdateTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  hostUpdateTarget: string | null,
): ReturnType<typeof collectServerUpdateTargets> {
  return hostUpdateTarget === null
    ? { targets: [], skipped: [] }
    : collectServerUpdateTargets(machines, hostUpdateTarget);
}

/**
 * Update everything settles a skipped server update as a retryable failure, as Retry does,
 * instead of counting a server that never started updating as updated.
 */
export function skippedAsFailed<Args extends ReadonlyArray<unknown>>(
  update: (...args: Args) => Promise<ServerUpdateOutcome>,
): (...args: Args) => Promise<ServerUpdateOutcome> {
  return async (...args) => {
    const outcome = await update(...args);
    return outcome.status === "skipped"
      ? { status: "failed", message: "Could not start the update" }
      : outcome;
  };
}
