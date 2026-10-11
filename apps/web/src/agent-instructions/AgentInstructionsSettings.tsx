/**
 * Settings, General, Agents: how agents T3 Code runs delegate work, plus
 * free-form additional instructions. The server builds the instructions every
 * provider receives from these rows; each row takes project overrides through
 * the settings scope picker.
 * Fork add-on: agent instructions.
 */
import {
  type AgentDelegationMode,
  MAX_AGENT_PARALLEL_WORKERS,
  MIN_AGENT_PARALLEL_WORKERS,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { searchableSetting } from "../components/settings/settingsSearch";
import { useScopedModelDisabledReason } from "../components/settings/useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";

const DELEGATION_LABELS: Record<AgentDelegationMode, string> = {
  off: "Off",
  auto: "When useful",
  always: "Always",
};

const PARALLEL_WORKER_OPTIONS = Array.from(
  { length: MAX_AGENT_PARALLEL_WORKERS - MIN_AGENT_PARALLEL_WORKERS + 1 },
  (_, index) => String(MIN_AGENT_PARALLEL_WORKERS + index),
);
const NO_LIMIT = "none";

function isDelegationMode(value: string | null): value is AgentDelegationMode {
  return value !== null && value in DELEGATION_LABELS;
}

export function AgentInstructionsSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments, targets, target } = useSettingsScope();
  const mixedDelegation = useScopedSettingsMixed(["agentDelegationMode"]);
  const mixedWorkerModel = useScopedSettingsMixed(["agentWorkerModelSelection"]);
  const mixedParallel = useScopedSettingsMixed(["agentMaxParallelWorkers"]);
  const mixedGit = useScopedSettingsMixed(["agentOrchestratorOwnsGit"]);
  const mixedInstructions = useScopedSettingsMixed(["agentInstructions"]);
  const scopeKey = targets.map((entry) => `${entry.environmentId}:${entry.projectId}`).join(",");
  const instructionsEdited = useRef(false);

  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      target?.projectId ?? null,
    ),
  );
  const workerSelection = resolveDefaultProviderModelSelection(
    providers,
    settings.agentWorkerModelSelection,
  );
  const workerEntry = entries.find((entry) => entry.instanceId === workerSelection?.instanceId);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    workerSelection?.instanceId,
    workerSelection?.model,
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const usesWorkerModel = settings.agentWorkerModelSelection !== null;
  const delegating = mixedDelegation || settings.agentDelegationMode !== "off";

  const setWorkerModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Worker model not saved", description: reason });
      return;
    }
    updateSettings({ agentWorkerModelSelection: value });
  };

  return (
    <SettingsSection id="agents" title="Agents">
      <SettingsRow
        serverScoped
        settingKeys={["agentDelegationMode"]}
        {...searchableSetting("agent-delegation")}
        description="How the thread's agent hands work to other agents with delegate_task. These rules win over conflicting CLAUDE.md or AGENTS.md rules."
        resetAction={
          settings.agentDelegationMode !== "off" ? (
            <SettingResetButton
              label="delegation"
              onClick={() => updateSettings({ agentDelegationMode: "off" })}
            />
          ) : null
        }
        control={
          <Select
            value={mixedDelegation ? null : settings.agentDelegationMode}
            onValueChange={(value) => {
              if (isDelegationMode(value)) updateSettings({ agentDelegationMode: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Delegation">
              <SelectValue>
                {(value: string | null) =>
                  isDelegationMode(value) ? DELEGATION_LABELS[value] : "Mixed"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(DELEGATION_LABELS).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      {delegating ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["agentWorkerModelSelection"]}
            {...searchableSetting("agent-worker-model")}
            description="Provider and model for delegated workers. Off runs workers on the thread's model."
            control={
              connectedEnvironments.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  Connect an environment to choose its worker model.
                </span>
              ) : (
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  {(usesWorkerModel || mixedWorkerModel) && workerSelection && workerEntry ? (
                    <>
                      <ProviderModelPicker
                        environmentId={environment?.environmentId ?? null}
                        activeInstanceId={workerSelection.instanceId}
                        model={workerSelection.model}
                        lockedProvider={null}
                        instanceEntries={entries}
                        modelOptionsByInstance={modelOptions}
                        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                        triggerAriaLabel="Worker model"
                        {...(mixedWorkerModel ? { triggerLabel: "Mixed" } : {})}
                        getModelDisabledReason={modelDisabledReason}
                        onOpenProviderSetup={(instanceId) => {
                          if (environment)
                            void navigate({
                              to: "/settings/providers",
                              search: { environmentId: environment.environmentId, instanceId },
                            });
                        }}
                        onInstanceModelChange={(instanceId, model) =>
                          setWorkerModel(createModelSelection(instanceId, model))
                        }
                      />
                      {!mixedWorkerModel ? (
                        <TraitsPicker
                          provider={workerEntry.driverKind}
                          models={workerEntry.models}
                          model={workerSelection.model}
                          prompt=""
                          onPromptChange={() => {}}
                          modelOptions={workerSelection.options ?? []}
                          allowPromptInjectedEffort={false}
                          planModeEnabled={settings.planModeEnabled}
                          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                          onModelOptionsChange={(options) =>
                            setWorkerModel(
                              createModelSelection(
                                workerSelection.instanceId,
                                workerSelection.model,
                                options,
                              ),
                            )
                          }
                        />
                      ) : null}
                    </>
                  ) : null}
                  <Switch
                    mixed={mixedWorkerModel}
                    checked={mixedWorkerModel ? false : usesWorkerModel}
                    disabled={!usesWorkerModel && workerSelection === null}
                    onCheckedChange={(checked) => {
                      if (!checked) {
                        setWorkerModel(null);
                        return;
                      }
                      const seed = resolveDefaultProviderModelSelection(
                        providers,
                        settings.defaultModelSelection,
                      );
                      if (seed) setWorkerModel(seed);
                    }}
                    aria-label="Use a separate worker model"
                  />
                </div>
              )
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentMaxParallelWorkers"]}
            {...searchableSetting("agent-parallel-workers")}
            description="Most workers one agent runs at once."
            resetAction={
              settings.agentMaxParallelWorkers !== null ? (
                <SettingResetButton
                  label="parallel workers"
                  onClick={() => updateSettings({ agentMaxParallelWorkers: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedParallel ? null : String(settings.agentMaxParallelWorkers ?? NO_LIMIT)}
                onValueChange={(value) => {
                  if (value === null) return;
                  updateSettings({
                    agentMaxParallelWorkers: value === NO_LIMIT ? null : Number(value),
                  });
                }}
              >
                <SelectTrigger size="sm" aria-label="Parallel workers">
                  <SelectValue>
                    {(value: string | null) =>
                      value === null ? "Mixed" : value === NO_LIMIT ? "No limit" : value
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={NO_LIMIT}>
                    No limit
                  </SelectItem>
                  {PARALLEL_WORKER_OPTIONS.map((value) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentOrchestratorOwnsGit"]}
            {...searchableSetting("agent-git-owner")}
            description="The delegating agent commits and publishes; workers never commit or push."
            resetAction={
              !settings.agentOrchestratorOwnsGit ? (
                <SettingResetButton
                  label="git ownership"
                  onClick={() => updateSettings({ agentOrchestratorOwnsGit: true })}
                />
              ) : null
            }
            control={
              <Switch
                mixed={mixedGit}
                checked={mixedGit ? false : settings.agentOrchestratorOwnsGit}
                onCheckedChange={(checked) =>
                  updateSettings({ agentOrchestratorOwnsGit: Boolean(checked) })
                }
                aria-label="Orchestrator handles git"
              />
            }
          />
        </>
      ) : null}

      <SettingsRow
        serverScoped
        settingKeys={["agentInstructions"]}
        {...searchableSetting("agent-instructions")}
        description="Anything else every agent should follow, added after the rules above. Running Claude and Pi sessions keep the instructions they started with."
        resetAction={
          mixedInstructions || settings.agentInstructions !== "" ? (
            <SettingResetButton
              label="additional instructions"
              onClick={() => updateSettings({ agentInstructions: "" })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={`${scopeKey}:${mixedInstructions}:${settings.agentInstructions}`}
            aria-label="Additional instructions"
            onChange={() => {
              instructionsEdited.current = true;
            }}
            rows={4}
            defaultValue={mixedInstructions ? "" : settings.agentInstructions}
            placeholder={
              mixedInstructions
                ? "Mixed. Enter instructions to apply to all selected targets."
                : "Run the project's formatter before reporting back."
            }
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (
                instructionsEdited.current &&
                (mixedInstructions || next !== settings.agentInstructions)
              ) {
                updateSettings({ agentInstructions: next });
              }
              instructionsEdited.current = false;
            }}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
