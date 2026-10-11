/**
 * Provider, model and traits pickers plus an on/off switch for one Agents
 * worker model setting. Off stores null, which means the row's fallback: the
 * thread's model for the worker model, the worker model for a role model.
 * Fork add-on: agent instructions.
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  type ProviderInstanceEntry,
  resolveDefaultProviderModelSelection,
} from "../providerInstances";

export type WorkerModelSettingKey =
  | "agentWorkerModelSelection"
  | "agentReviewWorkerModelSelection"
  | "agentResearchWorkerModelSelection";

function workerModelPatch(key: WorkerModelSettingKey, value: ModelSelection | null) {
  switch (key) {
    case "agentWorkerModelSelection":
      return { agentWorkerModelSelection: value };
    case "agentReviewWorkerModelSelection":
      return { agentReviewWorkerModelSelection: value };
    case "agentResearchWorkerModelSelection":
      return { agentResearchWorkerModelSelection: value };
  }
}

export function WorkerModelControl({
  settingKey,
  label,
  seed,
  providers,
  entries,
  modelDisabledReason,
}: {
  readonly settingKey: WorkerModelSettingKey;
  /** Names the setting in the picker's label and in the not-saved toast. */
  readonly label: string;
  /** What the switch turns on with. */
  readonly seed: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelDisabledReason: (
    instanceId: ModelSelection["instanceId"],
    model: string,
  ) => string | null;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed([settingKey]);
  const stored = settings[settingKey];
  const selection = resolveDefaultProviderModelSelection(providers, stored);
  const entry = entries.find((candidate) => candidate.instanceId === selection?.instanceId);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const enabled = stored !== null;

  const save = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: `${label} not saved`, description: reason });
      return;
    }
    updateSettings(workerModelPatch(settingKey, value));
  };

  if (connectedEnvironments.length === 0) {
    return (
      <span className="text-sm text-muted-foreground">
        Connect an environment to choose this model.
      </span>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      {(enabled || mixed) && selection && entry ? (
        <>
          <ProviderModelPicker
            environmentId={environment?.environmentId ?? null}
            activeInstanceId={selection.instanceId}
            model={selection.model}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptions}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            triggerAriaLabel={label}
            {...(mixed ? { triggerLabel: "Mixed" } : {})}
            getModelDisabledReason={modelDisabledReason}
            onOpenProviderSetup={(instanceId) => {
              if (environment)
                void navigate({
                  to: "/settings/providers",
                  search: { environmentId: environment.environmentId, instanceId },
                });
            }}
            onInstanceModelChange={(instanceId, model) =>
              save(createModelSelection(instanceId, model))
            }
          />
          {!mixed ? (
            <TraitsPicker
              provider={entry.driverKind}
              models={entry.models}
              model={selection.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                save(createModelSelection(selection.instanceId, selection.model, options))
              }
            />
          ) : null}
        </>
      ) : null}
      <Switch
        mixed={mixed}
        checked={mixed ? false : enabled}
        disabled={!enabled && seed === null}
        onCheckedChange={(checked) => {
          if (!checked) save(null);
          else if (seed) save(seed);
        }}
        aria-label={`Use a separate ${label.toLowerCase()}`}
      />
    </div>
  );
}
