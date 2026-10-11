/**
 * Settings, General, Agents: how agents T3 Code runs delegate work, how they
 * verify and publish, plus free-form additional instructions. The server builds
 * the instructions every provider receives from these rows and enforces the
 * worker target, worker limit and nested delegation on delegate_task; each row
 * takes project overrides through the settings scope picker.
 * Fork add-on: agent instructions.
 */
import {
  type AgentDelegationMode,
  type AgentPushPolicy,
  type AgentReviewRounds,
  type AgentVerification,
  MAX_AGENT_PARALLEL_WORKERS,
  MIN_AGENT_PARALLEL_WORKERS,
} from "@t3tools/contracts";
import { useRef } from "react";

import {
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
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { AgentInstructionsPreview } from "./AgentInstructionsPreview";
import { ChoiceSelect } from "./ChoiceSelect";
import { WorkerModelControl } from "./WorkerModelControl";

const DELEGATION_OPTIONS: ReadonlyArray<readonly [AgentDelegationMode, string]> = [
  ["off", "Off"],
  ["auto", "When useful"],
  ["always", "Always"],
];

const NO_LIMIT = "none";
const PARALLEL_WORKER_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  [NO_LIMIT, "No limit"],
  ...Array.from(
    { length: MAX_AGENT_PARALLEL_WORKERS - MIN_AGENT_PARALLEL_WORKERS + 1 },
    (_, index) => {
      const value = String(MIN_AGENT_PARALLEL_WORKERS + index);
      return [value, value] as const;
    },
  ),
];

const REVIEW_ROUND_OPTIONS: ReadonlyArray<readonly [AgentReviewRounds, string]> = [
  ["agent", "Agent decides"],
  ["once", "One round"],
  ["until-clean", "Until clean"],
];

const VERIFICATION_OPTIONS: ReadonlyArray<readonly [AgentVerification, string]> = [
  ["project", "Project rules"],
  ["review", "Review only"],
  ["targeted", "Targeted checks"],
  ["full", "Full checks"],
];

const PUSH_POLICY_OPTIONS: ReadonlyArray<readonly [AgentPushPolicy, string]> = [
  ["project", "Project rules"],
  ["never", "Never"],
  ["after-change", "After each change"],
];

export function AgentInstructionsSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, targets, target } = useSettingsScope();
  const mixedDelegation = useScopedSettingsMixed(["agentDelegationMode"]);
  const mixedParallel = useScopedSettingsMixed(["agentMaxParallelWorkers"]);
  const mixedReviewRounds = useScopedSettingsMixed(["agentReviewRounds"]);
  const mixedReadOnly = useScopedSettingsMixed(["agentReadOnlyReviewers"]);
  const mixedNested = useScopedSettingsMixed(["agentWorkersCanDelegate"]);
  const mixedGit = useScopedSettingsMixed(["agentOrchestratorOwnsGit"]);
  const mixedVerification = useScopedSettingsMixed(["agentVerification"]);
  const mixedPushPolicy = useScopedSettingsMixed(["agentPushPolicy"]);
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
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const delegating = mixedDelegation || settings.agentDelegationMode !== "off";
  const workerSeed = resolveDefaultProviderModelSelection(
    providers,
    settings.agentWorkerModelSelection ?? settings.defaultModelSelection,
  );
  const modelControl = { providers, entries, modelDisabledReason };

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
          <ChoiceSelect
            value={mixedDelegation ? null : settings.agentDelegationMode}
            options={DELEGATION_OPTIONS}
            ariaLabel="Delegation"
            onChange={(value) => updateSettings({ agentDelegationMode: value })}
          />
        }
      />

      {delegating ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["agentWorkerModelSelection"]}
            {...searchableSetting("agent-worker-model")}
            description="Provider and model for delegated workers. Off runs workers on the thread's model. T3 uses it whenever the agent leaves out a target."
            control={
              <WorkerModelControl
                settingKey="agentWorkerModelSelection"
                label="Worker model"
                seed={resolveDefaultProviderModelSelection(
                  providers,
                  settings.defaultModelSelection,
                )}
                {...modelControl}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentReviewWorkerModelSelection"]}
            {...searchableSetting("agent-review-worker-model")}
            description="Model for review workers. Off uses the worker model."
            control={
              <WorkerModelControl
                settingKey="agentReviewWorkerModelSelection"
                label="Review worker model"
                seed={workerSeed}
                {...modelControl}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentResearchWorkerModelSelection"]}
            {...searchableSetting("agent-research-worker-model")}
            description="Model for research workers. Off uses the worker model."
            control={
              <WorkerModelControl
                settingKey="agentResearchWorkerModelSelection"
                label="Research worker model"
                seed={workerSeed}
                {...modelControl}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentMaxParallelWorkers"]}
            {...searchableSetting("agent-parallel-workers")}
            description="Most workers one agent runs at once. T3 refuses a delegation past the limit."
            resetAction={
              settings.agentMaxParallelWorkers !== null ? (
                <SettingResetButton
                  label="parallel workers"
                  onClick={() => updateSettings({ agentMaxParallelWorkers: null })}
                />
              ) : null
            }
            control={
              <ChoiceSelect
                value={mixedParallel ? null : String(settings.agentMaxParallelWorkers ?? NO_LIMIT)}
                options={PARALLEL_WORKER_OPTIONS}
                ariaLabel="Parallel workers"
                onChange={(value) =>
                  updateSettings({
                    agentMaxParallelWorkers: value === NO_LIMIT ? null : Number(value),
                  })
                }
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentReviewRounds"]}
            {...searchableSetting("agent-review-rounds")}
            description="Review passes over the finished work, each by a fresh review worker."
            resetAction={
              settings.agentReviewRounds !== "agent" ? (
                <SettingResetButton
                  label="review rounds"
                  onClick={() => updateSettings({ agentReviewRounds: "agent" })}
                />
              ) : null
            }
            control={
              <ChoiceSelect
                value={mixedReviewRounds ? null : settings.agentReviewRounds}
                options={REVIEW_ROUND_OPTIONS}
                ariaLabel="Review rounds"
                onChange={(value) => updateSettings({ agentReviewRounds: value })}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentReadOnlyReviewers"]}
            {...searchableSetting("agent-read-only-reviewers")}
            description="Review and research workers are told not to edit files, commit, or push, in their instructions and at the top of their task. An instruction, not a sandbox."
            resetAction={
              settings.agentReadOnlyReviewers ? (
                <SettingResetButton
                  label="read-only reviewers"
                  onClick={() => updateSettings({ agentReadOnlyReviewers: false })}
                />
              ) : null
            }
            control={
              <Switch
                mixed={mixedReadOnly}
                checked={mixedReadOnly ? false : settings.agentReadOnlyReviewers}
                onCheckedChange={(checked) =>
                  updateSettings({ agentReadOnlyReviewers: Boolean(checked) })
                }
                aria-label="Read-only reviewers"
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentWorkersCanDelegate"]}
            {...searchableSetting("agent-workers-can-delegate")}
            description="Let workers hand off parts of their own task. Off, T3 refuses delegate_task from a worker."
            resetAction={
              settings.agentWorkersCanDelegate ? (
                <SettingResetButton
                  label="workers can delegate"
                  onClick={() => updateSettings({ agentWorkersCanDelegate: false })}
                />
              ) : null
            }
            control={
              <Switch
                mixed={mixedNested}
                checked={mixedNested ? false : settings.agentWorkersCanDelegate}
                onCheckedChange={(checked) =>
                  updateSettings({ agentWorkersCanDelegate: Boolean(checked) })
                }
                aria-label="Workers can delegate"
              />
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
        settingKeys={["agentVerification"]}
        {...searchableSetting("agent-verification")}
        description="How agents check their work. Project rules adds nothing, so CLAUDE.md or AGENTS.md decides."
        resetAction={
          settings.agentVerification !== "project" ? (
            <SettingResetButton
              label="verification"
              onClick={() => updateSettings({ agentVerification: "project" })}
            />
          ) : null
        }
        control={
          <ChoiceSelect
            value={mixedVerification ? null : settings.agentVerification}
            options={VERIFICATION_OPTIONS}
            ariaLabel="Verification"
            onChange={(value) => updateSettings({ agentVerification: value })}
          />
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["agentPushPolicy"]}
        {...searchableSetting("agent-push-policy")}
        description="When agents commit and push. Project rules adds nothing, so CLAUDE.md or AGENTS.md decides."
        resetAction={
          settings.agentPushPolicy !== "project" ? (
            <SettingResetButton
              label="commit and push"
              onClick={() => updateSettings({ agentPushPolicy: "project" })}
            />
          ) : null
        }
        control={
          <ChoiceSelect
            value={mixedPushPolicy ? null : settings.agentPushPolicy}
            options={PUSH_POLICY_OPTIONS}
            ariaLabel="Commit and push"
            onChange={(value) => updateSettings({ agentPushPolicy: value })}
          />
        }
      />

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

      <SettingsRow
        {...searchableSetting("agent-preview")}
        description="The instructions these settings give every agent, for the scope picked above."
        control={<AgentInstructionsPreview />}
      />
    </SettingsSection>
  );
}
