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
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
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

/** The atom never fails, so a failed check can say why instead of looking like "no release". */
type HostReleaseLookup =
  | { readonly _tag: "found"; readonly version: string }
  | { readonly _tag: "none" }
  | { readonly _tag: "failed"; readonly reason: string };

function formatRateLimitReset(epochSeconds: string | undefined): string {
  const seconds = Number(epochSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const time = new Date(seconds * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `, resets ${time}`;
}

/** GitHub exposes its rate-limit headers to CORS reads, so the reason costs no extra call. */
export function describeHostReleaseCheckFailure(error: unknown, online: boolean): string {
  if (!online) return "offline";
  if (!HttpClientError.isHttpClientError(error)) return "unexpected response from GitHub";
  const reason = error.reason;
  if (reason._tag === "StatusCodeError") {
    const { status, headers } = reason.response;
    if (status === 429 || (status === 403 && headers["x-ratelimit-remaining"] === "0")) {
      return `GitHub rate limit${formatRateLimitReset(headers["x-ratelimit-reset"])}`;
    }
    return `GitHub returned ${status}`;
  }
  return reason._tag === "TransportError"
    ? "GitHub unreachable"
    : "unexpected response from GitHub";
}

const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

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
    const version = newestPublishedHostRelease(releases, APP_VERSION);
    const lookup: HostReleaseLookup =
      version === undefined ? { _tag: "none" } : { _tag: "found", version };
    return lookup;
  }).pipe(
    Effect.catch((error): Effect.Effect<HostReleaseLookup> =>
      Effect.succeed({
        _tag: "failed",
        reason: describeHostReleaseCheckFailure(error, isOnline()),
      }),
    ),
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
  // A failed check settles as a value that replaces an earlier find, which may name a release
  // since deleted.
  return AsyncResult.isSuccess(result) && result.value._tag === "found"
    ? result.value.version
    : null;
}

/** Unauthenticated GitHub API calls are limited per IP, so this runs on app start and on demand. */
export function useRefreshHostUpdateTarget(): () => void {
  return useAtomRefresh(hostReleaseAtom);
}

export type HostReleaseCheck =
  | { readonly status: "checking" }
  | { readonly status: "known"; readonly target: string | null }
  | { readonly status: "failed"; readonly reason: string };

const CHECKING: HostReleaseCheck = { status: "checking" };

export function resolveHostReleaseCheck(
  result: AsyncResult.AsyncResult<HostReleaseLookup, unknown>,
): HostReleaseCheck {
  // A refresh keeps the previous value while it runs; showing it would make Retry look idle.
  if (AsyncResult.isInitial(result) || result.waiting) return CHECKING;
  if (!AsyncResult.isSuccess(result)) {
    return { status: "failed", reason: "unexpected response from GitHub" };
  }
  const lookup = result.value;
  if (lookup._tag === "failed") return { status: "failed", reason: lookup.reason };
  return { status: "known", target: lookup._tag === "found" ? lookup.version : null };
}

export function useHostReleaseCheck(): HostReleaseCheck {
  return resolveHostReleaseCheck(useAtomValue(hostReleaseAtom));
}

const checkFailure = (reason: string) => `couldn't check fork releases (${reason})`;

/** The muted line Connections shows above its hosts, or null unless the check failed. */
export function hostReleaseCheckFailureNotice(check: HostReleaseCheck): string | null {
  return check.status === "failed" ? `Couldn't check fork releases (${check.reason})` : null;
}

export type HostReleaseState =
  | { readonly status: "checking" }
  | { readonly status: "current" }
  | { readonly status: "no-release" }
  | { readonly status: "update"; readonly version: string }
  | { readonly status: "failed"; readonly reason: string };

export function resolveHostReleaseState(
  serverVersion: string,
  check: HostReleaseCheck,
): HostReleaseState {
  if (check.status !== "known") return check;
  if (check.target === null) return { status: "no-release" };
  return resolveVersionMismatch(serverVersion, check.target) === null
    ? { status: "current" }
    : { status: "update", version: check.target };
}

export function describeHostReleaseState(state: HostReleaseState): string {
  switch (state.status) {
    case "checking":
      return "Checking fork releases…";
    case "current":
      return "Up to date";
    case "no-release":
      return "No fork release published yet";
    case "update":
      return `Update to ${state.version}`;
    case "failed":
      return `Couldn't check fork releases (${state.reason})`;
  }
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

/**
 * Without a known release, a failed check reports every remote host it could not compare, so
 * Update everything says it couldn't check instead of looking like nothing needs updating.
 */
export function collectHostUpdateTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  hostUpdateTarget: string | null,
  check?: HostReleaseCheck,
): ReturnType<typeof collectServerUpdateTargets> {
  if (hostUpdateTarget !== null) return collectServerUpdateTargets(machines, hostUpdateTarget);
  if (check?.status !== "failed") return { targets: [], skipped: [] };
  const reason = checkFailure(check.reason);
  return {
    targets: [],
    skipped: machines
      .filter((machine) => !machine.hostedByThisApp)
      .map(({ environmentId, label }) => ({ environmentId, label, reason })),
  };
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
