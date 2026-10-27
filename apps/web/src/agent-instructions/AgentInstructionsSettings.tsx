/**
 * Settings, General, Agents: how agents T3 Code runs delegate work, how they
 * verify, ask and report, plus free-form and per-provider instructions. The
 * server builds the instructions every provider receives from these rows and
 * enforces the worker target, worker limit, delegation depth, worker worktrees
 * and time limits on delegate_task; each row takes project overrides through
 * the settings scope picker. Presets copy a named set of these values in.
 * Fork add-on: agent instructions.
 */
import {
  type AgentAutonomy,
  type AgentDelegationMode,
  type AgentPushPolicy,
  type AgentReportStyle,
  type AgentReviewRounds,
  type AgentVerification,
  type AgentWorkerWorkspace,
  agentPresetForThread,
  agentPresetOverriddenKeys,
  AGENT_PROJECT_SCOPED_SETTING_KEYS,
  DEFAULT_AGENT_DELEGATION_DEPTH,
  DEFAULT_AGENT_PARALLEL_WORKERS,
  MAX_AGENT_DELEGATION_DEPTH,
  MIN_AGENT_DELEGATION_DEPTH,
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
import { useEnvironmentProviders } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { AgentInstructionsPreview } from "./AgentInstructionsPreview";
import { AgentPresetsControl } from "./AgentPresetsControl";
import { ChoiceSelect } from "./ChoiceSelect";
import { ParallelWorkersControl } from "./ParallelWorkersControl";
import { ProviderInstructionsControl } from "./ProviderInstructionsControl";
import { WorkerModelControl } from "./WorkerModelControl";

const SETTING_LABELS: Record<(typeof AGENT_PROJECT_SCOPED_SETTING_KEYS)[number], string> = {
  agentDelegationMode: "Delegation",
  agentWorkerModelSelection: "Worker model",
  agentWorkerModelSelectionFixed: "Fixed worker targets",
  agentReviewWorkerModelSelection: "Review worker model",
  agentResearchWorkerModelSelection: "Research worker model",
  agentMaxParallelWorkers: "Parallel workers",
  agentMaxDelegationDepth: "Delegation depth",
  agentReadOnlyReviewers: "Read-only reviewers",
  agentReviewRounds: "Review rounds",
  agentOrchestratorOwnsGit: "Orchestrator handles git",
  agentVerification: "Verification",
  agentPushPolicy: "Commit and push",
  agentWorkerWorkspace: "Worker workspace",
  agentWorkerTimeLimitMinutes: "Worker time limit",
  agentBlockNativeSubagents: "Block native subagents",
  agentAutonomy: "Autonomy",
  agentReportStyle: "Report style",
  agentInstructions: "Additional instructions",
  agentProviderInstructions: "Provider instructions",
};

const DELEGATION_OPTIONS: ReadonlyArray<readonly [AgentDelegationMode, string]> = [
  ["off", "Off"],
  ["auto", "When useful"],
  ["always", "Always"],
];

const NO_LIMIT = "none";

const DELEGATION_DEPTH_OPTIONS: ReadonlyArray<readonly [string, string]> = Array.from(
  { length: MAX_AGENT_DELEGATION_DEPTH - MIN_AGENT_DELEGATION_DEPTH + 1 },
  (_, index) => {
    const depth = MIN_AGENT_DELEGATION_DEPTH + index;
    return [String(depth), depth === 1 ? "1 level" : `${depth} levels`] as const;
  },
);

// Rough per-worker memory: each worker is a full provider CLI process.
const WORKER_MEMORY_GB = { low: 0.3, high: 0.5 };
// Past this many workers in one checkout, edits to the same file get likely.
const SHARED_CHECKOUT_COMFORT = 12;

function formatGb(value: number): string {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

/** The Parallel workers row's note: what the count means and what it costs. */
function parallelWorkersNote(count: number | null, sharedCheckout: boolean): string {
  const parts = [
    "Most workers running at once under one thread's agent, counting workers that workers start. T3 refuses a delegation past the limit.",
  ];
  if (count !== null) {
    parts.push(
      `${count} at once is roughly ${formatGb(count * WORKER_MEMORY_GB.low)}–${formatGb(count * WORKER_MEMORY_GB.high)} GB of memory, since each worker is a full agent process${count > 1 ? `, and can use your plan's limits up to ${count}× as fast as one agent` : ""}.`,
    );
    if (sharedCheckout && count > SHARED_CHECKOUT_COMFORT) {
      parts.push(
        "Workers share one checkout, so more of them means more chance two edit the same file.",
      );
    }
  }
  return parts.join(" ");
}

const WORKER_WORKSPACE_OPTIONS: ReadonlyArray<readonly [AgentWorkerWorkspace, string]> = [
  ["shared", "Shared checkout"],
  ["worktree", "Worktree per worker"],
];

const WORKER_TIME_LIMIT_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  [NO_LIMIT, "No limit"],
  ...[5, 10, 15, 30, 45].map((minutes) => [String(minutes), `${minutes} min`] as const),
  ...[60, 90, 120, 180, 240, 480].map((minutes) => [String(minutes), `${minutes / 60} h`] as const),
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

const AUTONOMY_OPTIONS: ReadonlyArray<readonly [AgentAutonomy, string]> = [
  ["project", "Project rules"],
  ["autonomous", "Work without asking"],
  ["ask-risky", "Ask before risky steps"],
  ["ask-changes", "Ask before any change"],
];

const REPORT_STYLE_OPTIONS: ReadonlyArray<readonly [AgentReportStyle, string]> = [
  ["project", "Project rules"],
  ["terse", "Terse"],
  ["standard", "Standard"],
  ["detailed", "Detailed"],
];

export function AgentInstructionsSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, targets, target } = useSettingsScope();
  const mixedDelegation = useScopedSettingsMixed(["agentDelegationMode"]);
  const mixedParallel = useScopedSettingsMixed(["agentMaxParallelWorkers"]);
  const mixedWorkspace = useScopedSettingsMixed(["agentWorkerWorkspace"]);
  const mixedTimeLimit = useScopedSettingsMixed(["agentWorkerTimeLimitMinutes"]);
  const mixedBlockNative = useScopedSettingsMixed(["agentBlockNativeSubagents"]);
  const mixedAutonomy = useScopedSettingsMixed(["agentAutonomy"]);
  const mixedReportStyle = useScopedSettingsMixed(["agentReportStyle"]);
  const mixedReviewRounds = useScopedSettingsMixed(["agentReviewRounds"]);
  const mixedReadOnly = useScopedSettingsMixed(["agentReadOnlyReviewers"]);
  const mixedDepth = useScopedSettingsMixed(["agentMaxDelegationDepth"]);
  const mixedGit = useScopedSettingsMixed(["agentOrchestratorOwnsGit"]);
  const mixedFixedWorkerTargets = useScopedSettingsMixed(["agentWorkerModelSelectionFixed"]);
  const mixedVerification = useScopedSettingsMixed(["agentVerification"]);
  const mixedPushPolicy = useScopedSettingsMixed(["agentPushPolicy"]);
  const mixedInstructions = useScopedSettingsMixed(["agentInstructions"]);
  const scopeKey = targets.map((entry) => `${entry.environmentId}:${entry.projectId}`).join(",");
  const instructionsEdited = useRef(false);

  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment ? providersByEnvironment.get(environment.environmentId) : undefined) ??
    EMPTY_SERVER_PROVIDERS;
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
  const defaultPreset = agentPresetForThread(settings, []);
  const defaultOverrides =
    defaultPreset === undefined ? [] : agentPresetOverriddenKeys(defaultPreset, settings);

  return (
    <SettingsSection id="agents" title="Agents">
      <SettingsRow
        {...searchableSetting("agent-presets")}
        description={
          <>
            Apply a named set of the values below to the scope picked above, or save the current
            values as one. Pick a preset for one thread from the composer. Running Claude and Pi
            sessions, and Block native subagents, pick up changes when a session starts.
            {defaultOverrides.length > 0 ? (
              <span className="mt-1 block text-warning-foreground">
                Threads without a preset choice run under the default preset, {defaultPreset?.name},
                which replaces: {defaultOverrides.map((key) => SETTING_LABELS[key]).join(", ")}.
              </span>
            ) : null}
          </>
        }
        control={<AgentPresetsControl />}
      />

      <SettingsRow
        serverScoped
        settingKeys={["agentDelegationMode"]}
        {...searchableSetting("agent-delegation")}
        description="How the thread's agent hands work to other agents with delegate_task. These rules win over conflicting CLAUDE.md or AGENTS.md rules."
        resetAction={
          settings.agentDelegationMode !== "auto" ? (
            <SettingResetButton
              label="delegation"
              onClick={() => updateSettings({ agentDelegationMode: "auto" })}
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
            settingKeys={["agentWorkerModelSelectionFixed"]}
            {...searchableSetting("agent-fixed-worker-targets")}
            description="When on, T3 uses the configured role model, falling back to Worker model, and rejects different targets. A role without a configured target is refused. This does not change the main model or provider-native subagents."
            resetAction={
              settings.agentWorkerModelSelectionFixed ? (
                <SettingResetButton
                  label="fixed worker targets"
                  onClick={() => updateSettings({ agentWorkerModelSelectionFixed: false })}
                />
              ) : null
            }
            control={
              <Switch
                mixed={mixedFixedWorkerTargets}
                checked={mixedFixedWorkerTargets ? false : settings.agentWorkerModelSelectionFixed}
                onCheckedChange={(checked) =>
                  updateSettings({ agentWorkerModelSelectionFixed: Boolean(checked) })
                }
                aria-label="Fixed worker targets"
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
            description={parallelWorkersNote(
              mixedParallel ? null : settings.agentMaxParallelWorkers,
              settings.agentWorkerWorkspace === "shared",
            )}
            resetAction={
              settings.agentMaxParallelWorkers !== DEFAULT_AGENT_PARALLEL_WORKERS ? (
                <SettingResetButton
                  label="parallel workers"
                  onClick={() =>
                    updateSettings({ agentMaxParallelWorkers: DEFAULT_AGENT_PARALLEL_WORKERS })
                  }
                />
              ) : null
            }
            control={
              <ParallelWorkersControl
                value={mixedParallel ? null : settings.agentMaxParallelWorkers}
                onChange={(value) => updateSettings({ agentMaxParallelWorkers: value })}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentMaxDelegationDepth"]}
            {...searchableSetting("agent-delegation-depth")}
            description="Levels of workers. 1: only the thread's agent starts workers. 2: its workers may start their own, which can't go further. Each step adds a level, and workers decide for themselves whether to delegate. Parallel workers counts every level."
            resetAction={
              settings.agentMaxDelegationDepth !== DEFAULT_AGENT_DELEGATION_DEPTH ? (
                <SettingResetButton
                  label="delegation depth"
                  onClick={() =>
                    updateSettings({ agentMaxDelegationDepth: DEFAULT_AGENT_DELEGATION_DEPTH })
                  }
                />
              ) : null
            }
            control={
              <ChoiceSelect
                value={mixedDepth ? null : String(settings.agentMaxDelegationDepth)}
                options={DELEGATION_DEPTH_OPTIONS}
                ariaLabel="Delegation depth"
                onChange={(value) => updateSettings({ agentMaxDelegationDepth: Number(value) })}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentWorkerWorkspace"]}
            {...searchableSetting("agent-worker-workspace")}
            description="Shared checkout runs workers in the agent's own checkout. Worktree per worker gives each its own git worktree and branch from the current commit; the agent merges them."
            resetAction={
              settings.agentWorkerWorkspace !== "shared" ? (
                <SettingResetButton
                  label="worker workspace"
                  onClick={() => updateSettings({ agentWorkerWorkspace: "shared" })}
                />
              ) : null
            }
            control={
              <ChoiceSelect
                value={mixedWorkspace ? null : settings.agentWorkerWorkspace}
                options={WORKER_WORKSPACE_OPTIONS}
                ariaLabel="Worker workspace"
                onChange={(value) => updateSettings({ agentWorkerWorkspace: value })}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["agentWorkerTimeLimitMinutes"]}
            {...searchableSetting("agent-worker-time-limit")}
            description="T3 stops a worker still running after this long. A server restart forgets running limits."
            resetAction={
              settings.agentWorkerTimeLimitMinutes !== null ? (
                <SettingResetButton
                  label="worker time limit"
                  onClick={() => updateSettings({ agentWorkerTimeLimitMinutes: null })}
                />
              ) : null
            }
            control={
              <ChoiceSelect
                value={
                  mixedTimeLimit ? null : String(settings.agentWorkerTimeLimitMinutes ?? NO_LIMIT)
                }
                options={WORKER_TIME_LIMIT_OPTIONS}
                ariaLabel="Worker time limit"
                onChange={(value) =>
                  updateSettings({
                    agentWorkerTimeLimitMinutes: value === NO_LIMIT ? null : Number(value),
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
        settingKeys={["agentBlockNativeSubagents"]}
        {...searchableSetting("agent-block-native-subagents")}
        description="Agents use only T3's delegate_task, never their harness's own subagents. T3 turns those tools off for Claude and Codex; other providers get the rule as an instruction."
        resetAction={
          settings.agentBlockNativeSubagents ? (
            <SettingResetButton
              label="block native subagents"
              onClick={() => updateSettings({ agentBlockNativeSubagents: false })}
            />
          ) : null
        }
        control={
          <Switch
            mixed={mixedBlockNative}
            checked={mixedBlockNative ? false : settings.agentBlockNativeSubagents}
            onCheckedChange={(checked) =>
              updateSettings({ agentBlockNativeSubagents: Boolean(checked) })
            }
            aria-label="Block native subagents"
          />
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["agentAutonomy"]}
        {...searchableSetting("agent-autonomy")}
        description="What agents check with you about first. An instruction; use the composer's access mode for hard approvals."
        resetAction={
          settings.agentAutonomy !== "project" ? (
            <SettingResetButton
              label="autonomy"
              onClick={() => updateSettings({ agentAutonomy: "project" })}
            />
          ) : null
        }
        control={
          <ChoiceSelect
            value={mixedAutonomy ? null : settings.agentAutonomy}
            options={AUTONOMY_OPTIONS}
            ariaLabel="Autonomy"
            onChange={(value) => updateSettings({ agentAutonomy: value })}
          />
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["agentReportStyle"]}
        {...searchableSetting("agent-report-style")}
        description="How much agents write when they finish."
        resetAction={
          settings.agentReportStyle !== "project" ? (
            <SettingResetButton
              label="report style"
              onClick={() => updateSettings({ agentReportStyle: "project" })}
            />
          ) : null
        }
        control={
          <ChoiceSelect
            value={mixedReportStyle ? null : settings.agentReportStyle}
            options={REPORT_STYLE_OPTIONS}
            ariaLabel="Report style"
            onChange={(value) => updateSettings({ agentReportStyle: value })}
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
        serverScoped
        settingKeys={["agentProviderInstructions"]}
        {...searchableSetting("agent-provider-instructions")}
        description="Text only one provider's agents receive, after the additional instructions. A dot marks providers that have some."
        resetAction={
          Object.values(settings.agentProviderInstructions).some((text) => text !== "") ? (
            <SettingResetButton
              label="provider instructions"
              onClick={() =>
                updateSettings({
                  agentProviderInstructions: Object.fromEntries(
                    Object.keys(settings.agentProviderInstructions).map((kind) => [kind, ""]),
                  ),
                })
              }
            />
          ) : null
        }
      >
        <ProviderInstructionsControl providers={providers} scopeKey={scopeKey} />
      </SettingsRow>

      <SettingsRow
        {...searchableSetting("agent-preview")}
        description="The instructions these settings give every agent, for the scope picked above."
        control={<AgentInstructionsPreview />}
      />
    </SettingsSection>
  );
}
