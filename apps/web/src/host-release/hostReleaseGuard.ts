import type { EnvironmentId } from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { requestConfirmDialog } from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import {
  type HostReleaseSource,
  hostReleaseSourceOf,
  nonForkBulkSkipReason,
  nonForkUpdateWarning,
} from "./hostReleaseSource";

// Read at click time from the live config, so every update button follows the host's current
// source without each caller passing it through.
function currentReleaseSource(environmentId: EnvironmentId): HostReleaseSource {
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
  return config === null ? "unknown" : hostReleaseSourceOf(config.environment);
}

/** Resolves false when the user declines the warning a non-fork host shows first. */
export async function confirmHostReleaseSource(target: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly targetVersion: string;
}): Promise<boolean> {
  const warning = nonForkUpdateWarning(
    currentReleaseSource(target.environmentId),
    target.serverLabel,
    target.targetVersion,
  );
  if (warning === undefined) return true;
  // Without a themed dialog host, a native confirm still keeps the warning in front.
  return (await requestConfirmDialog(warning)) ?? window.confirm(warning);
}

/** Leaves non-fork hosts out of a bulk update and says which ones and why. */
export function forkHostsOnly<
  Target extends { readonly environmentId: EnvironmentId; readonly serverLabel: string },
>(targets: ReadonlyArray<Target>): Target[] {
  const skipped: string[] = [];
  const included = targets.filter((target) => {
    const reason = nonForkBulkSkipReason(currentReleaseSource(target.environmentId));
    if (reason !== undefined) skipped.push(`${target.serverLabel}: ${reason}`);
    return reason === undefined;
  });
  if (skipped.length > 0) {
    toastManager.add({
      type: "info",
      title: `Skipped ${skipped.length} ${skipped.length === 1 ? "server" : "servers"}`,
      description: skipped.join("\n"),
    });
  }
  return included;
}
