import type { ServerReleaseSource } from "@t3tools/contracts";

// A server installs updates from the source it was built or configured with, not from
// wherever this client learned the target version. Only fork hosts are safe to update in bulk
// to a locally staged fork build; other sources may fetch a different build or fail.

/** `unknown` is a server too old to report its source. */
export type HostReleaseSource = ServerReleaseSource | "unknown";

export function hostReleaseSourceOf(environment: {
  readonly releaseSource?: ServerReleaseSource | undefined;
}): HostReleaseSource {
  return environment.releaseSource ?? "unknown";
}

const SOURCE_LABELS: Record<HostReleaseSource, string> = {
  fork: "locally staged fork builds",
  upstream: "upstream releases",
  custom: "custom release source",
  unknown: "source unknown",
};

export function hostReleaseSourceLabel(source: HostReleaseSource): string {
  return SOURCE_LABELS[source];
}

const BULK_SKIP_REASONS: Record<Exclude<HostReleaseSource, "fork">, string> = {
  upstream: "updates from upstream releases",
  custom: "updates from a custom release source",
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
      return `${serverLabel} installs releases from a custom release source. Updating fetches t3@${targetVersion} from that source. Update anyway?`;
    case "unknown":
      return `${serverLabel} runs an older server that doesn't report where it installs releases from. If it isn't a fork build, updating may fetch a different build of t3@${targetVersion} or fail. Update anyway?`;
  }
}
