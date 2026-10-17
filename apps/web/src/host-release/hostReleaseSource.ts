import type { ServerReleaseSource } from "@t3tools/contracts";

// A server installs updates from the release base it was built or configured with, not from
// wherever this client found the target version. Only fork hosts are safe to update in bulk to
// a fork release; the rest may fetch a different build of the same version, or fail.

/** `unknown` is a server too old to report its source. */
export type HostReleaseSource = ServerReleaseSource | "unknown";

export function hostReleaseSourceOf(environment: {
  readonly releaseSource?: ServerReleaseSource | undefined;
}): HostReleaseSource {
  return environment.releaseSource ?? "unknown";
}

const SOURCE_LABELS: Record<HostReleaseSource, string> = {
  fork: "fork releases",
  upstream: "upstream releases",
  custom: "custom mirror",
  unknown: "source unknown",
};

export function hostReleaseSourceLabel(source: HostReleaseSource): string {
  return SOURCE_LABELS[source];
}

const BULK_SKIP_REASONS: Record<Exclude<HostReleaseSource, "fork">, string> = {
  upstream: "updates from upstream releases",
  custom: "updates from a custom mirror",
  unknown: "update source unknown (older server, update it from its row once)",
};

/** Why bulk updates leave this host alone, or undefined for a fork host. */
export function nonForkBulkSkipReason(source: HostReleaseSource): string | undefined {
  return source === "fork" ? undefined : BULK_SKIP_REASONS[source];
}

/** The confirmation a single-host update shows first, or undefined for a fork host. */
export function nonForkUpdateWarning(
  source: HostReleaseSource,
  serverLabel: string,
  targetVersion: string,
): string | undefined {
  switch (source) {
    case "fork":
      return undefined;
    case "upstream":
      return `${serverLabel} installs upstream T3 Code releases, not this fork's. Updating fetches the upstream build of t3@${targetVersion}, if one exists. Update anyway?`;
    case "custom":
      return `${serverLabel} installs releases from a custom mirror (T3CODE_RELEASE_BASE_URL). Updating fetches t3@${targetVersion} from that mirror. Update anyway?`;
    case "unknown":
      return `${serverLabel} runs an older server that doesn't report where it installs releases from. If it isn't a fork build, updating may fetch a different build of t3@${targetVersion} or fail. Update anyway?`;
  }
}
