import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";

import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironment } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { environmentSession, readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

export const MODEL_PREFERENCES_SCOPE_NOTE =
  "Hiding or showing a model applies on every connected environment with this provider. Order, favorites and custom models are saved on the selected environment.";

type PrepareModelPreferencesPatch = (
  settings: ServerSettings,
  patch: ServerSettingsPatch,
) => Promise<ServerSettingsPatch>;

// A cold session has no grants yet; the server still authorizes the write.
function mayWriteSettings(environmentId: EnvironmentId): boolean {
  const session = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return session._tag === "Initial" || readEnvironmentScope(environmentId, AuthSettingsWriteScope);
}

/**
 * Hiding or showing a model applies on every connected environment that has the same provider
 * instance with the same driver. Reads environments at save time so callers don't re-render.
 */
export function useShareModelVisibility(
  sourceId: EnvironmentId | null,
  prepare: PrepareModelPreferencesPatch,
) {
  const save = useAtomCommand(serverEnvironment.updateSettings, {
    label: "shared model visibility update",
    reportFailure: false,
  });
  return (patch: ServerSettingsPatch) => {
    const changes = patch.setModelsHidden;
    if (sourceId === null || !changes?.length) return;
    const providersByEnvironment = appAtomRegistry.get(
      environmentPresentations.providersByEnvironmentAtom,
    );
    const driverOf = (environmentId: EnvironmentId, instanceId: ProviderInstanceId) =>
      providersByEnvironment.get(environmentId)?.find((p) => p.instanceId === instanceId)?.driver;
    const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
    const writes = [...presentations].flatMap(([targetId, presentation]) => {
      const settings = presentation.serverConfig?.settings;
      if (
        targetId === sourceId ||
        settings === undefined ||
        !supportsSharedSettingsSync(presentation) ||
        !mayWriteSettings(targetId)
      ) {
        return [];
      }
      const targetChanges = changes.filter((change) => {
        const driver = driverOf(sourceId, change.provider);
        return driver !== undefined && driverOf(targetId, change.provider) === driver;
      });
      return targetChanges.length > 0 ? [{ targetId, settings, targetChanges }] : [];
    });
    if (writes.length === 0) return;
    void Promise.all(
      writes.map(async ({ targetId, settings, targetChanges }) => {
        const result = await prepare(settings, { setModelsHidden: targetChanges })
          .then((prepared) => save({ environmentId: targetId, input: { patch: prepared } }))
          .catch(() => null);
        const failed =
          result === null || (result._tag === "Failure" && !isAtomCommandInterrupted(result));
        return failed ? [readEnvironment(targetId)?.label ?? targetId] : [];
      }),
    ).then((outcomes) => {
      const failed = outcomes.flat();
      if (failed.length === 0) return;
      toastManager.add({
        type: "warning",
        title: "Model visibility not saved everywhere",
        description: `Could not update ${failed.join(", ")}. Change it there from Settings → Providers.`,
      });
    });
  };
}
