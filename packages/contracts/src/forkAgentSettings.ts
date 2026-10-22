// Fork add-on: agent instructions. The Settings, General, Agents rows: their
// schemas, defaults, and the instruction text the server gives every provider.
// contracts/settings.ts spreads the field groups and key lists below, so a new
// Agents setting is added here only. See docs/user/agent-instructions.md.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * How the thread's agent hands out work through `delegate_task`. `off` adds no
 * delegation rules, `auto` delegates independent pieces and keeps small work,
 * `always` keeps the agent to planning, review and integration.
 */
export const AgentDelegationMode = Schema.Literals(["off", "auto", "always"]);
export type AgentDelegationMode = typeof AgentDelegationMode.Type;

export const MIN_AGENT_PARALLEL_WORKERS = 1;
export const MAX_AGENT_PARALLEL_WORKERS = 30;
export const DEFAULT_AGENT_PARALLEL_WORKERS = 12;
/** Workers running at once under one thread's agent, counting every level. */
export const AgentMaxParallelWorkers = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AGENT_PARALLEL_WORKERS,
    maximum: MAX_AGENT_PARALLEL_WORKERS,
  }),
);
export type AgentMaxParallelWorkers = typeof AgentMaxParallelWorkers.Type;

// The retired "No limit" was a stored null; it reads as the default so one old
// value never resets the rest of the settings.
const PersistedParallelWorkers = Schema.NullOr(AgentMaxParallelWorkers).pipe(
  Schema.decodeTo(
    AgentMaxParallelWorkers,
    SchemaTransformation.transform({
      decode: (value) => value ?? DEFAULT_AGENT_PARALLEL_WORKERS,
      encode: (value) => value,
    }),
  ),
);

export const MIN_AGENT_DELEGATION_DEPTH = 1;
export const MAX_AGENT_DELEGATION_DEPTH = 6;
export const DEFAULT_AGENT_DELEGATION_DEPTH = 2;
/**
 * Levels of workers below the thread's agent. Its workers are level 1; at
 * depth 1 they cannot delegate, at depth 2 they may start workers that cannot.
 */
export const AgentMaxDelegationDepth = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AGENT_DELEGATION_DEPTH,
    maximum: MAX_AGENT_DELEGATION_DEPTH,
  }),
);
export type AgentMaxDelegationDepth = typeof AgentMaxDelegationDepth.Type;

/** Review passes over the workers' combined result. `agent` leaves it to the agent. */
export const AgentReviewRounds = Schema.Literals(["agent", "once", "until-clean"]);
export type AgentReviewRounds = typeof AgentReviewRounds.Type;

/** How agents check their work. `project` defers to the project's own rules. */
export const AgentVerification = Schema.Literals(["project", "review", "targeted", "full"]);
export type AgentVerification = typeof AgentVerification.Type;

/** When agents commit and push. `project` defers to the project's own rules. */
export const AgentPushPolicy = Schema.Literals(["project", "never", "after-change"]);
export type AgentPushPolicy = typeof AgentPushPolicy.Type;

/** Where workers run: the parent's checkout, or a new git worktree and branch each. */
export const AgentWorkerWorkspace = Schema.Literals(["shared", "worktree"]);
export type AgentWorkerWorkspace = typeof AgentWorkerWorkspace.Type;

export const MAX_AGENT_WORKER_TIME_LIMIT_MINUTES = 480;
/** Minutes a worker may run before T3 stops it. */
export const AgentWorkerTimeLimitMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_AGENT_WORKER_TIME_LIMIT_MINUTES }),
);
export type AgentWorkerTimeLimitMinutes = typeof AgentWorkerTimeLimitMinutes.Type;

/** What agents check with the user about first. `project` defers to the project's own rules. */
export const AgentAutonomy = Schema.Literals(["project", "autonomous", "ask-risky", "ask-changes"]);
export type AgentAutonomy = typeof AgentAutonomy.Type;

/** How much agents write when they finish. `project` defers to the project's own rules. */
export const AgentReportStyle = Schema.Literals(["project", "terse", "standard", "detailed"]);
export type AgentReportStyle = typeof AgentReportStyle.Type;

/**
 * Extra text for one provider driver kind (`claudeAgent`, `codex`, `pi`...).
 * Records merge on save, so an empty string is how an entry is cleared.
 */
export const AgentProviderInstructions = Schema.Record(Schema.String, TrimmedString);
export type AgentProviderInstructions = typeof AgentProviderInstructions.Type;

const NullableModelSelection = Schema.NullOr(ModelSelection);
const NullableWorkerTimeLimit = Schema.NullOr(AgentWorkerTimeLimitMinutes);

/**
 * `ServerSettings` fields with their defaults. Delegation defaults to When
 * useful; every other default adds no instructions of its own.
 */
export const AgentSettingsFields = {
  agentDelegationMode: AgentDelegationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("auto" as const)),
  ),
  agentWorkerModelSelection: NullableModelSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentWorkerModelSelectionFixed: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  agentReviewWorkerModelSelection: NullableModelSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentResearchWorkerModelSelection: NullableModelSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentMaxParallelWorkers: PersistedParallelWorkers.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_PARALLEL_WORKERS)),
  ),
  agentMaxDelegationDepth: AgentMaxDelegationDepth.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_DELEGATION_DEPTH)),
  ),
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
  agentWorkerWorkspace: AgentWorkerWorkspace.pipe(
    Schema.withDecodingDefault(Effect.succeed("shared" as const)),
  ),
  agentWorkerTimeLimitMinutes: NullableWorkerTimeLimit.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentBlockNativeSubagents: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  agentAutonomy: AgentAutonomy.pipe(Schema.withDecodingDefault(Effect.succeed("project" as const))),
  agentReportStyle: AgentReportStyle.pipe(
    Schema.withDecodingDefault(Effect.succeed("project" as const)),
  ),
  agentInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  agentProviderInstructions: AgentProviderInstructions.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
};

/** `ServerSettingsPatch` and `ProjectSettingsOverrides` fields. */
export const AgentSettingsOptionalFields = {
  agentDelegationMode: Schema.optionalKey(AgentDelegationMode),
  agentWorkerModelSelection: Schema.optionalKey(NullableModelSelection),
  agentWorkerModelSelectionFixed: Schema.optionalKey(Schema.Boolean),
  agentReviewWorkerModelSelection: Schema.optionalKey(NullableModelSelection),
  agentResearchWorkerModelSelection: Schema.optionalKey(NullableModelSelection),
  agentMaxParallelWorkers: Schema.optionalKey(PersistedParallelWorkers),
  agentMaxDelegationDepth: Schema.optionalKey(AgentMaxDelegationDepth),
  agentReadOnlyReviewers: Schema.optionalKey(Schema.Boolean),
  agentReviewRounds: Schema.optionalKey(AgentReviewRounds),
  agentOrchestratorOwnsGit: Schema.optionalKey(Schema.Boolean),
  agentVerification: Schema.optionalKey(AgentVerification),
  agentPushPolicy: Schema.optionalKey(AgentPushPolicy),
  agentWorkerWorkspace: Schema.optionalKey(AgentWorkerWorkspace),
  agentWorkerTimeLimitMinutes: Schema.optionalKey(NullableWorkerTimeLimit),
  agentBlockNativeSubagents: Schema.optionalKey(Schema.Boolean),
  agentAutonomy: Schema.optionalKey(AgentAutonomy),
  agentReportStyle: Schema.optionalKey(AgentReportStyle),
  agentInstructions: Schema.optionalKey(TrimmedString),
  agentProviderInstructions: Schema.optionalKey(AgentProviderInstructions),
};

/** A named set of Agents values. Applying one copies them into the picked scope. */
export const AgentPreset = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  settings: Schema.Struct(AgentSettingsOptionalFields),
});
export type AgentPreset = typeof AgentPreset.Type;

/** A thread's stored choice of the project's settings, so the default preset doesn't apply. */
export const AGENT_PROJECT_PRESET_ID = "project";

/**
 * Environment-only Agents settings: saved presets, the preset each thread
 * runs under keyed by thread id, and the preset a thread without a choice runs
 * under. A thread entry of `AGENT_PROJECT_PRESET_ID` means the project's
 * settings; an empty string means no choice (records merge on save, so a key
 * is cleared that way). An empty default means the project's settings.
 */
export const AgentEnvironmentSettingsFields = {
  agentPresets: Schema.Array(AgentPreset).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  agentThreadPresets: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  agentDefaultPresetId: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
};

/** `ServerSettings` fields: the project-scoped ones plus the environment-only ones. */
export const AgentServerSettingsFields = {
  ...AgentSettingsFields,
  ...AgentEnvironmentSettingsFields,
};

/** `ServerSettingsPatch` fields. */
export const AgentSettingsPatchFields = {
  ...AgentSettingsOptionalFields,
  agentPresets: Schema.optionalKey(Schema.Array(AgentPreset)),
  agentThreadPresets: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  agentDefaultPresetId: Schema.optionalKey(Schema.String),
};

/** Every Agents setting can be overridden per project. */
export const AGENT_PROJECT_SCOPED_SETTING_KEYS = [
  "agentDelegationMode",
  "agentWorkerModelSelection",
  "agentWorkerModelSelectionFixed",
  "agentReviewWorkerModelSelection",
  "agentResearchWorkerModelSelection",
  "agentMaxParallelWorkers",
  "agentMaxDelegationDepth",
  "agentReadOnlyReviewers",
  "agentReviewRounds",
  "agentOrchestratorOwnsGit",
  "agentVerification",
  "agentPushPolicy",
  "agentWorkerWorkspace",
  "agentWorkerTimeLimitMinutes",
  "agentBlockNativeSubagents",
  "agentAutonomy",
  "agentReportStyle",
  "agentInstructions",
  "agentProviderInstructions",
] as const satisfies ReadonlyArray<keyof typeof AgentSettingsFields>;

/** Keys whose project override may be `null` (meaning "use the thread's model" or "no limit"). */
export const AGENT_NULLABLE_PROJECT_SETTING_KEYS = [
  "agentWorkerModelSelection",
  "agentReviewWorkerModelSelection",
  "agentResearchWorkerModelSelection",
  "agentWorkerTimeLimitMinutes",
] as const satisfies ReadonlyArray<keyof typeof AgentSettingsFields>;

export const AgentSettings = Schema.Struct(AgentSettingsFields);
export type AgentSettings = typeof AgentSettings.Type;

export const AgentEnvironmentSettings = Schema.Struct(AgentEnvironmentSettingsFields);
export type AgentEnvironmentSettings = typeof AgentEnvironmentSettings.Type;

/** Presets every environment has. Their ids start with `builtin:`. */
export const BUILTIN_AGENT_PRESETS: ReadonlyArray<AgentPreset> = [
  { id: "builtin:solo", name: "Solo", settings: { agentDelegationMode: "off" } },
  {
    id: "builtin:orchestrator",
    name: "Orchestrator",
    settings: { agentDelegationMode: "always", agentReviewRounds: "once" },
  },
  {
    id: "builtin:review-heavy",
    name: "Review-heavy",
    settings: {
      agentDelegationMode: "auto",
      agentReviewRounds: "until-clean",
      agentReadOnlyReviewers: true,
    },
  },
];

export function isBuiltinAgentPreset(id: string): boolean {
  return id.startsWith("builtin:");
}

/** The built-in presets, then the user's. */
export function agentPresetList(
  settings: Pick<AgentEnvironmentSettings, "agentPresets">,
): ReadonlyArray<AgentPreset> {
  return [...BUILTIN_AGENT_PRESETS, ...settings.agentPresets];
}

/**
 * The preset a thread runs under: its own choice, else the first ancestor's
 * (a worker follows its parent's), else the default preset. Pass the thread id
 * first. Undefined means the project's settings.
 */
export function agentPresetForThread(
  settings: AgentEnvironmentSettings,
  threadIds: ReadonlyArray<string | undefined>,
): AgentPreset | undefined {
  const presets = agentPresetList(settings);
  for (const threadId of threadIds) {
    const presetId = threadId === undefined ? undefined : settings.agentThreadPresets[threadId];
    if (presetId === undefined || presetId === "") continue;
    if (presetId === AGENT_PROJECT_PRESET_ID) return undefined;
    return presets.find((preset) => preset.id === presetId);
  }
  return presets.find((preset) => preset.id === settings.agentDefaultPresetId);
}

/** Project-resolved settings with the thread's preset applied on top. */
export function applyAgentThreadPreset<S extends AgentSettings & AgentEnvironmentSettings>(
  settings: S,
  threadIds: ReadonlyArray<string | undefined>,
): S {
  const preset = agentPresetForThread(settings, threadIds);
  return preset === undefined ? settings : { ...settings, ...preset.settings };
}

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
  const worktrees = settings.agentWorkerWorkspace === "worktree";
  return [
    settings.agentDelegationMode === "always"
      ? "- You orchestrate: plan, brief workers, review their results, and integrate. Hand all implementation, research, and review work to workers; do only small fixes yourself."
      : "- Delegate work that splits into independent pieces; do small or sequential work yourself. Review every worker's result.",
    "- Delegate with the t3-code delegate_task tool, not native subagents.",
    settings.agentWorkerModelSelection === null
      ? settings.agentWorkerModelSelectionFixed
        ? "- No general worker target is configured. Fixed mode refuses delegation for roles without a role-specific target."
        : "- Workers run on your own model unless a task needs another."
      : `- ${settings.agentWorkerModelSelectionFixed ? "Fixed worker target" : "Default worker target"}: ${workerTarget(settings.agentWorkerModelSelection)}.`,
    review === null
      ? null
      : `- ${settings.agentWorkerModelSelectionFixed ? "Fixed review worker target" : 'Review workers (role "review")'}: ${workerTarget(review)}.`,
    research === null
      ? null
      : `- ${settings.agentWorkerModelSelectionFixed ? "Fixed research worker target" : 'Research workers (role "research")'}: ${workerTarget(research)}.`,
    settings.agentWorkerModelSelectionFixed
      ? "- Fixed targets apply to T3 delegate_task only. Set a role on every delegation and leave target out; T3 uses its role-specific selection or the general worker selection, enforces the configured provider, model, and options, and refuses conflicting or unconfigured targets. Provider-native subagents are separate."
      : anyTarget
        ? "- Set role on every delegate_task. Leave out target and T3 uses the target for that role."
        : null,
    `- At most ${settings.agentMaxParallelWorkers} ${settings.agentMaxParallelWorkers === 1 ? "worker runs" : "workers run"} at once under the thread's agent, counting workers that workers start; T3 refuses more.`,
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
    settings.agentWorkerTimeLimitMinutes === null
      ? null
      : `- T3 stops a worker that runs longer than ${settings.agentWorkerTimeLimitMinutes} ${settings.agentWorkerTimeLimitMinutes === 1 ? "minute" : "minutes"}; size each task to finish well inside that.`,
    worktrees
      ? "- Each worker gets its own git worktree and branch, made from your current commit. Uncommitted changes are not in it, so commit what workers need first. Workers commit only to their own branch and never push; merge their branches when you review them."
      : "- Workers share one checkout: give every brief non-overlapping file ownership.",
    !ownsGit || worktrees
      ? null
      : settings.agentPushPolicy === "never"
        ? "- Workers never commit or push."
        : "- You handle git and publishing; workers never commit or push.",
    settings.agentMaxDelegationDepth === 1
      ? "- If your task came from delegate_task, do it yourself and never delegate."
      : `- If your task came from delegate_task, you may delegate pieces that clearly split off, under these same rules, up to ${settings.agentMaxDelegationDepth} levels of workers in all. The top of your task says whether you may.`,
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
    settings.agentBlockNativeSubagents
      ? "- Never use your harness's own subagent or task tools; T3 turns them off where it can."
      : null,
    settings.agentAutonomy === "autonomous"
      ? "- Work without stopping to ask. Make reasonable calls yourself and list them in your report."
      : settings.agentAutonomy === "ask-risky"
        ? "- Ask the user before you commit, push, delete files, or do anything that reaches outside this machine (deploys, messages, accounts, cloud resources)."
        : settings.agentAutonomy === "ask-changes"
          ? "- Ask the user before any change: say what you plan to edit and wait for a yes before editing files, committing, pushing, deleting, or reaching outside this machine."
          : null,
    settings.agentReportStyle === "terse"
      ? "- Finish with a terse report: a line or two on what changed and anything still open."
      : settings.agentReportStyle === "standard"
        ? "- Finish with a short report: what changed, how it was verified, and anything still open."
        : settings.agentReportStyle === "detailed"
          ? "- Finish with a detailed report: each change and why, the files touched, how it was verified, and any risks or open questions."
          : null,
  ];
}

/** The extra text for one provider driver kind, or empty. */
export function agentProviderInstructionsFor(
  settings: Pick<AgentSettings, "agentProviderInstructions">,
  provider: string | undefined,
): string {
  return provider === undefined ? "" : (settings.agentProviderInstructions[provider] ?? "");
}

/**
 * The instruction text for one resolved set of Agents settings; empty when
 * nothing is set. `provider` is the driver kind, which adds its own text.
 */
export function buildAgentInstructionsText(settings: AgentSettings, provider?: string): string {
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
  const providerText = agentProviderInstructionsFor(settings, provider);
  if (providerText !== "") sections.push(providerText);
  return sections.join("\n\n");
}
