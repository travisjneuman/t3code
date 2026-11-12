import type { ProviderDriverKind, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import {
  HERMES_DRIVER,
  hermesAgentName,
  hermesMachineName,
  hermesRunLocation,
} from "../hermes/hermesSessions";

/** Hermes owns its workspace and host; the composer must not offer a different run location. */
export function resolveHermesChatPresentation(
  selectedProvider: ProviderDriverKind,
  instanceId: ProviderInstanceId | null,
  multipleModelsSelected: boolean,
  settings: Pick<ServerSettings, "providerInstances">,
  environments: Parameters<typeof hermesRunLocation>[1],
) {
  const hermesAgent =
    selectedProvider === HERMES_DRIVER && instanceId !== null && !multipleModelsSelected
      ? {
          name: hermesAgentName(settings, instanceId),
          machine: hermesMachineName(settings, instanceId),
        }
      : null;
  return {
    hermesAgent,
    hermesFixedRunLocation: hermesRunLocation(hermesAgent, environments),
  };
}

/** Hermes threads run on Hermes's own machine, so no local workspace control applies to them. */
export function applyHermesWorkspaceVisibility(
  show: Record<"environment" | "openIn" | "scripts" | "branch" | "pullRequests" | "git", boolean>,
  localWorkspace: boolean,
): void {
  if (localWorkspace) return;
  for (const key of Object.keys(show) as Array<keyof typeof show>) show[key] = false;
}
