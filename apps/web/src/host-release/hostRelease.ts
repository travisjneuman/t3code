import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  DesktopHostReleaseStatus,
  ExecutionEnvironmentDescriptor,
  ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type { ServerUpdateOutcome } from "~/components/ServerUpdateAction";
import {
  collectServerUpdateTargets,
  type UpdateEverythingMachine,
} from "~/components/sidebar/updateEverything.logic";
import {
  resolveRuntimeVersionMismatch,
  resolveServerConfigVersionMismatch,
  type VersionMismatch,
} from "~/versionSkew";

// Fork hosts update only to a version the explicit desktop Update flow has staged on every
// configured host. Generic web clients have no local build bridge and must not offer archives.
type HostBuildLookup =
  | { readonly _tag: "found"; readonly targetVersion: string }
  | { readonly _tag: "building" }
  | { readonly _tag: "local-build-required" }
  | { readonly _tag: "failed"; readonly reason: string };

function hostBuildLookup(status: DesktopHostReleaseStatus | null): HostBuildLookup {
  if (status === null) return { _tag: "local-build-required" };
  if (status.state === "running") return { _tag: "building" };
  if (status.state === "failed") {
    return { _tag: "failed", reason: status.detail ?? "local host build failed" };
  }
  return status.targetVersion === undefined || status.targetVersion.trim() === ""
    ? { _tag: "local-build-required" }
    : { _tag: "found", targetVersion: status.targetVersion };
}

const hostReleaseAtom = Atom.make(
  Effect.tryPromise({
    try: async (): Promise<HostBuildLookup> => {
      const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.hostRelease;
      return bridge === undefined
        ? { _tag: "local-build-required" }
        : hostBuildLookup(await bridge.getStatus());
    },
    catch: (error) => error,
  }).pipe(
    Effect.catch((error): Effect.Effect<HostBuildLookup> =>
      Effect.succeed({
        _tag: "failed",
        reason: error instanceof Error ? error.message : "desktop host build status unavailable",
      }),
    ),
  ),
).pipe(Atom.keepAlive, Atom.withLabel("local-fork-host-build"));

/**
 * The locally staged host version, or null until an explicit desktop Update has staged it.
 */
export function useHostUpdateTarget(): string | null {
  const result = useAtomValue(hostReleaseAtom);
  return AsyncResult.isSuccess(result) && result.value._tag === "found"
    ? result.value.targetVersion
    : null;
}

/** The locally staged version, including one newer than this app, for the host update queue. */
export function useNewestHostRelease(): string | null {
  const result = useAtomValue(hostReleaseAtom);
  return AsyncResult.isSuccess(result) && result.value._tag === "found"
    ? result.value.targetVersion
    : null;
}

/** Re-reads the local desktop bridge status on app events and on demand. */
export function useRefreshHostUpdateTarget(): () => void {
  return useAtomRefresh(hostReleaseAtom);
}

export type HostReleaseCheck =
  | { readonly status: "checking" }
  | { readonly status: "known"; readonly target: string | null }
  | { readonly status: "building" }
  | { readonly status: "local-build-required" }
  | { readonly status: "failed"; readonly reason: string };

const CHECKING: HostReleaseCheck = { status: "checking" };

export function resolveHostReleaseCheck(
  result: AsyncResult.AsyncResult<HostBuildLookup, unknown>,
): HostReleaseCheck {
  // A refresh keeps the previous value while it runs, so wait for it to settle.
  if (AsyncResult.isInitial(result) || result.waiting) return CHECKING;
  if (!AsyncResult.isSuccess(result)) {
    return { status: "failed", reason: "desktop host build status unavailable" };
  }
  const lookup = result.value;
  if (lookup._tag === "failed") return { status: "failed", reason: lookup.reason };
  if (lookup._tag === "building") return { status: "building" };
  if (lookup._tag === "local-build-required") return { status: "local-build-required" };
  return { status: "known", target: lookup.targetVersion };
}

export function useHostReleaseCheck(): HostReleaseCheck {
  return resolveHostReleaseCheck(useAtomValue(hostReleaseAtom));
}

const checkFailure = (reason: string) => `couldn't read the local host build status (${reason})`;

/** The muted line Connections shows above its hosts, including when a local build is required. */
export function hostReleaseCheckFailureNotice(check: HostReleaseCheck): string | null {
  if (check.status === "local-build-required") {
    return "Local host build required. Press Update in the source desktop app to stage fork hosts.";
  }
  if (check.status === "building") return "Building and staging the local fork version…";
  return check.status === "failed" ? `Local host build failed (${check.reason})` : null;
}

export type HostReleaseState =
  | { readonly status: "checking" }
  | { readonly status: "current" }
  | { readonly status: "building" }
  | { readonly status: "local-build-required" }
  | { readonly status: "update"; readonly version: string }
  | { readonly status: "failed"; readonly reason: string };

export function resolveHostReleaseState(
  environment: Pick<ExecutionEnvironmentDescriptor, "serverVersion" | "forkBuild">,
  check: HostReleaseCheck,
): HostReleaseState {
  if (check.status !== "known") return check;
  if (check.target === null) return { status: "local-build-required" };
  return resolveRuntimeVersionMismatch(environment, check.target) === null
    ? { status: "current" }
    : { status: "update", version: check.target };
}

export function describeHostReleaseState(state: HostReleaseState): string {
  switch (state.status) {
    case "checking":
      return "Checking local host build…";
    case "current":
      return "Up to date";
    case "building":
      return "Building and staging the local fork version…";
    case "local-build-required":
      return "Local host build required. Press Update in the source desktop app.";
    case "update":
      return `Update to ${describeRuntimeVersion(state.version)}`;
    case "failed":
      return `Local host build failed (${state.reason})`;
  }
}

/** `0.1.1-nightly.20261017.3272+17af2d5f83ab` reads as `0.1.1-nightly.20261017.3272 (fork 17af2d5)`. */
export function describeRuntimeVersion(runtimeVersion: string): string {
  const [version, build] = runtimeVersion.split("+", 2);
  return build === undefined ? runtimeVersion : `${version} (fork ${build.slice(0, 7)})`;
}

export function resolveHostVersionMismatch(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
  hostUpdateTarget: string | null,
): VersionMismatch | null {
  // A desktop app's own server ships in the same bundle that publishes host releases, so it is
  // never behind the staged target; a Mac build newer than the last staging would read as one.
  if (serverConfig?.environment.capabilities.serverSelfUpdate === "desktop-managed") {
    return resolveServerConfigVersionMismatch(serverConfig);
  }
  return hostUpdateTarget === null
    ? null
    : resolveRuntimeVersionMismatch(serverConfig?.environment, hostUpdateTarget);
}

export function useHostVersionMismatch(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): VersionMismatch | null {
  return resolveHostVersionMismatch(serverConfig, useHostUpdateTarget());
}

/**
 * Without a staged target, a failed local-status read reports every remote host it could not
 * compare, so Update everything doesn't look like nothing needs updating.
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
