// Fork add-on: agent instructions. The Settings, General, Agents rows: their
// schemas, defaults, and the instruction text the server gives every provider.
// contracts/settings.ts spreads the field groups and key lists below, so a new
// Agents setting is added here only. See docs/user/agent-instructions.md.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * How the thread's agent hands out work through `delegate_task`. `off` adds no
 * delegation rules, `auto` delegates independent pieces and keeps small work,
 * `always` keeps the agent to planning, review and integration.
 */
export const AgentDelegationMode = Schema.Literals(["off", "auto", "always"]);
export type AgentDelegationMode = typeof AgentDelegationMode.Type;

export const MIN_AGENT_PARALLEL_WORKERS = 1;
export const MAX_AGENT_PARALLEL_WORKERS = 12;
export const AgentMaxParallelWorkers = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AGENT_PARALLEL_WORKERS,
    maximum: MAX_AGENT_PARALLEL_WORKERS,
  }),
);
export type AgentMaxParallelWorkers = typeof AgentMaxParallelWorkers.Type;

/** Review passes over the workers' combined result. `agent` leaves it to the agent. */
export const AgentReviewRounds = Schema.Literals(["agent", "once", "until-clean"]);
export type AgentReviewRounds = typeof AgentReviewRounds.Type;

/** How agents check their work. `project` defers to the project's own rules. */
export const AgentVerification = Schema.Literals(["project", "review", "targeted", "full"]);
export type AgentVerification = typeof AgentVerification.Type;

/** When agents commit and push. `project` defers to the project's own rules. */
export const AgentPushPolicy = Schema.Literals(["project", "never", "after-change"]);
export type AgentPushPolicy = typeof AgentPushPolicy.Type;

const NullableModelSelection = Schema.NullOr(ModelSelection);
const NullableParallelWorkers = Schema.NullOr(AgentMaxParallelWorkers);

/** `ServerSettings` fields with their defaults; every default adds no instructions. */
export const AgentSettingsFields = {
  agentDelegationMode: AgentDelegationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  agentWorkerModelSelection: NullableModelSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentReviewWorkerModelSelection: NullableModelSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentResearchWorkerModelSelection: NullableModelSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentMaxParallelWorkers: NullableParallelWorkers.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentWorkersCanDelegate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  agentReadOnlyReviewers: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  agentReviewRounds: AgentReviewRounds.pipe(
    Schema.withDecodingDefault(Effect.succeed("agent" as const)),
  ),
  agentOrchestratorOwnsGit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  agentVerification: AgentVerification.pipe(
    Schema.withDecodingDefault(Effect.succeed("project" as const)),
  ),
  agentPushPolicy: AgentPushPolicy.pipe(
    Schema.withDecodingDefault(Effect.succeed("project" as const)),
  ),
  agentInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
};

/** `ServerSettingsPatch` and `ProjectSettingsOverrides` fields. */
export const AgentSettingsOptionalFields = {
  agentDelegationMode: Schema.optionalKey(AgentDelegationMode),
  agentWorkerModelSelection: Schema.optionalKey(NullableModelSelection),
  agentReviewWorkerModelSelection: Schema.optionalKey(NullableModelSelection),
  agentResearchWorkerModelSelection: Schema.optionalKey(NullableModelSelection),
  agentMaxParallelWorkers: Schema.optionalKey(NullableParallelWorkers),
  agentWorkersCanDelegate: Schema.optionalKey(Schema.Boolean),
  agentReadOnlyReviewers: Schema.optionalKey(Schema.Boolean),
  agentReviewRounds: Schema.optionalKey(AgentReviewRounds),
  agentOrchestratorOwnsGit: Schema.optionalKey(Schema.Boolean),
  agentVerification: Schema.optionalKey(AgentVerification),
  agentPushPolicy: Schema.optionalKey(AgentPushPolicy),
  agentInstructions: Schema.optionalKey(TrimmedString),
};

/** Every Agents setting can be overridden per project. */
export const AGENT_PROJECT_SCOPED_SETTING_KEYS = [
  "agentDelegationMode",
  "agentWorkerModelSelection",
  "agentReviewWorkerModelSelection",
  "agentResearchWorkerModelSelection",
  "agentMaxParallelWorkers",
  "agentWorkersCanDelegate",
  "agentReadOnlyReviewers",
  "agentReviewRounds",
  "agentOrchestratorOwnsGit",
  "agentVerification",
  "agentPushPolicy",
  "agentInstructions",
] as const satisfies ReadonlyArray<keyof typeof AgentSettingsFields>;

/** Keys whose project override may be `null` (meaning "use the thread's model" or "no limit"). */
export const AGENT_NULLABLE_PROJECT_SETTING_KEYS = [
  "agentWorkerModelSelection",
  "agentReviewWorkerModelSelection",
  "agentResearchWorkerModelSelection",
  "agentMaxParallelWorkers",
] as const satisfies ReadonlyArray<keyof typeof AgentSettingsFields>;

export const AgentSettings = Schema.Struct(AgentSettingsFields);
export type AgentSettings = typeof AgentSettings.Type;

/** The worker roles that can have their own model. Other roles use the worker model. */
export type AgentWorkerModelRole = "review" | "research";

/** The model a worker of `role` runs on: its role's model, else the worker model, else null (the thread's). */
export function agentWorkerModelForRole(
  settings: Pick<
    AgentSettings,
    | "agentWorkerModelSelection"
    | "agentReviewWorkerModelSelection"
    | "agentResearchWorkerModelSelection"
  >,
  role: string | undefined,
): ModelSelection | null {
  const roleModel =
    role === "review"
      ? settings.agentReviewWorkerModelSelection
      : role === "research"
        ? settings.agentResearchWorkerModelSelection
        : null;
  return roleModel ?? settings.agentWorkerModelSelection;
}

/** Whether a worker of `role` is held to read-only work. */
export function agentWorkerIsReadOnly(
  settings: Pick<AgentSettings, "agentReadOnlyReviewers">,
  role: string | undefined,
): boolean {
  return settings.agentReadOnlyReviewers && (role === "review" || role === "research");
}

/** The line T3 puts at the top of a read-only worker's task. */
export const AGENT_READ_ONLY_WORKER_LINE =
  "Read only: do not edit files, commit, or push. Report what you find and what should change.";

function workerTarget(selection: ModelSelection): string {
  return JSON.stringify({
    providerInstanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options === undefined || selection.options.length === 0
      ? {}
      : { options: selection.options }),
  });
}

function delegationLines(settings: AgentSettings): ReadonlyArray<string | null> {
  const review = settings.agentReviewWorkerModelSelection;
  const research = settings.agentResearchWorkerModelSelection;
  const anyTarget =
    settings.agentWorkerModelSelection !== null || review !== null || research !== null;
  const ownsGit = settings.agentOrchestratorOwnsGit;
  return [
    settings.agentDelegationMode === "always"
      ? "- You orchestrate: plan, brief workers, review their results, and integrate. Hand all implementation, research, and review work to workers; do only small fixes yourself."
      : "- Delegate work that splits into independent pieces; do small or sequential work yourself. Review every worker's result.",
    "- Delegate with the t3-code delegate_task tool, not native subagents.",
    settings.agentWorkerModelSelection === null
      ? "- Workers run on your own model unless a task needs another."
      : `- Default worker target: ${workerTarget(settings.agentWorkerModelSelection)}.`,
    review === null ? null : `- Review workers (role "review"): ${workerTarget(review)}.`,
    research === null ? null : `- Research workers (role "research"): ${workerTarget(research)}.`,
    anyTarget
      ? "- Set role on every delegate_task. Leave out target and T3 uses the target for that role."
      : null,
    settings.agentMaxParallelWorkers === null
      ? null
      : `- Run at most ${settings.agentMaxParallelWorkers} ${settings.agentMaxParallelWorkers === 1 ? "worker" : "workers"} at once; T3 refuses more.`,
    "- Give each worker one short, scoped task with the files it owns, the files it must not touch, and what done means. Ask for a short report: changed files, what was verified, open questions.",
    settings.agentReadOnlyReviewers
      ? "- Review and research workers only read: they never edit files, commit, or push. Hand their findings to an implementation worker or fix them yourself."
      : null,
    "- Workers are single-use. Each review round is a new delegate_task with the original brief, your findings, and any open objections, plus a new clientRequestId. Never message a child thread to continue it.",
    settings.agentReviewRounds === "once"
      ? "- When the work is done, have one review worker check the combined result, fix what it finds, then finish."
      : settings.agentReviewRounds === "until-clean"
        ? "- When the work is done, run review rounds with fresh review workers until a round finds nothing to fix."
        : null,
    '- Use mode "async", then end your turn; finished workers wake you. Do not poll.',
    "- Workers share one checkout: give every brief non-overlapping file ownership.",
    !ownsGit
      ? null
      : settings.agentPushPolicy === "never"
        ? "- Workers never commit or push."
        : "- You handle git and publishing; workers never commit or push.",
    settings.agentWorkersCanDelegate
      ? "- If your task came from delegate_task, delegate only pieces that clearly split off, under these same rules."
      : "- If your task came from delegate_task, do it yourself and never delegate.",
  ];
}

function policyLines(settings: AgentSettings): ReadonlyArray<string | null> {
  return [
    settings.agentVerification === "review"
      ? "- Verify by reviewing the diff and the code it touches. Do not run tests, lint, typecheck, or builds."
      : settings.agentVerification === "targeted"
        ? "- Verify with the smallest checks that prove the change: focused tests and targeted lint or typecheck for the files you touched. No repo-wide runs."
        : settings.agentVerification === "full"
          ? "- Before you finish, run the project's full test, lint, and typecheck commands and fix what fails."
          : null,
    settings.agentPushPolicy === "never"
      ? "- Never commit or push. Leave changes in the working tree for the user."
      : settings.agentPushPolicy === "after-change"
        ? "- Commit and push each completed change once it is verified."
        : null,
  ];
}

/** The instruction text for one resolved set of Agents settings; empty when nothing is set. */
export function buildAgentInstructionsText(settings: AgentSettings): string {
  const rules = [
    ...(settings.agentDelegationMode === "off" ? [] : delegationLines(settings)),
    ...policyLines(settings),
  ].filter((line) => line !== null);
  const sections: string[] = [];
  if (rules.length > 0) {
    sections.push(
      [
        "Inside T3 Code, these rules replace conflicting ones in CLAUDE.md or AGENTS.md.",
        ...rules,
      ].join("\n"),
    );
  }
  if (settings.agentInstructions !== "") sections.push(settings.agentInstructions);
  return sections.join("\n\n");
}
