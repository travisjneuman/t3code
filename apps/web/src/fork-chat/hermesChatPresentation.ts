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
