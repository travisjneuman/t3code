import type { ServerConfig } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  describeHostReleaseState,
  type HostReleaseCheck,
  resolveHostReleaseState,
} from "./hostRelease";
import {
  type HostReleaseSource,
  hostReleaseSourceLabel,
  hostReleaseSourceOf,
} from "./hostReleaseSource";

type HostEnvironment = Pick<
  ServerConfig["environment"],
  "serverVersion" | "releaseSource" | "startedAt"
>;

/** Version, channel and release source, so a row says what it runs and where it updates from. */
export function hostRowSubtitle(
  serverVersion: string,
  environment: Pick<HostEnvironment, "releaseSource"> | undefined,
): string {
  return [
    serverVersion,
    cliReleaseChannelOf(serverVersion),
    hostReleaseSourceLabel(hostReleaseSourceOf(environment ?? {})),
  ].join(" · ");
}

const UPDATES_FROM: Record<HostReleaseSource, string> = {
  fork: "Updates from fork releases",
  upstream: "Updates from upstream releases",
  custom: "Updates from a custom mirror (T3CODE_RELEASE_BASE_URL)",
  unknown: "Update source not reported (older server)",
};

function describeStart(startedAt: string | undefined): string {
  const relative = startedAt === undefined ? "" : formatRelativeTimeLabel(startedAt);
  if (startedAt === undefined || relative === "") return "Start time not reported";
  const absolute = new Date(startedAt).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `Started ${relative} (${absolute})`;
}

/** Lines appended to a row's status tooltip; empty until the host has reported its config. */
export function hostRowTooltipFacts(
  environment: HostEnvironment | undefined,
  check: HostReleaseCheck,
): string {
  if (environment === undefined) return "";
  const release = resolveHostReleaseState(environment.serverVersion, check);
  return [
    "",
    describeStart(environment.startedAt),
    UPDATES_FROM[hostReleaseSourceOf(environment)],
    // The tooltip already names an available update with both versions.
    ...(release.status === "update" ? [] : [describeHostReleaseState(release)]),
  ].join("\n");
}
