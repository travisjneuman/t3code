/**
 * Builds the instructions from the Agents settings (delegation, worker model,
 * parallel workers, git ownership, additional instructions) and keeps the
 * provider-core copy in step: one text for the environment and one for each
 * project that overrides a setting. Every provider session started after a
 * save carries the new text.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import type { ServerSettings as ServerSettingsValues } from "@t3tools/contracts";
import { setForkAgentInstructions } from "@t3tools/provider-core/server/forkAgentInstructions";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";

type AgentSettings = Pick<
  ServerSettingsValues,
  | "agentDelegationMode"
  | "agentWorkerModelSelection"
  | "agentMaxParallelWorkers"
  | "agentOrchestratorOwnsGit"
  | "agentInstructions"
>;

/** The instruction text for one resolved set of Agents settings; empty when nothing is set. */
export function buildAgentInstructionsText(settings: AgentSettings): string {
  const sections: string[] = [];
  if (settings.agentDelegationMode !== "off") {
    const worker = settings.agentWorkerModelSelection;
    const target =
      worker === null
        ? null
        : JSON.stringify({
            providerInstanceId: worker.instanceId,
            model: worker.model,
            ...(worker.options === undefined || worker.options.length === 0
              ? {}
              : { options: worker.options }),
          });
    const lines = [
      "Inside T3 Code, these delegation rules replace conflicting ones in CLAUDE.md or AGENTS.md.",
      settings.agentDelegationMode === "always"
        ? "- You orchestrate: plan, brief workers, review their results, and integrate. Hand all implementation, research, and review work to workers; do only small fixes yourself."
        : "- Delegate work that splits into independent pieces; do small or sequential work yourself. Review every worker's result.",
      "- Delegate with the t3-code delegate_task tool, not native subagents.",
      target === null
        ? "- Workers run on your own model unless a task needs another."
        : `- Default worker target: ${target}.`,
      settings.agentMaxParallelWorkers === null
        ? null
        : `- Run at most ${settings.agentMaxParallelWorkers} ${settings.agentMaxParallelWorkers === 1 ? "worker" : "workers"} at once.`,
      "- Give each worker one short, scoped task with the files it owns, the files it must not touch, and what done means. Ask for a short report: changed files, what was verified, open questions.",
      "- Workers are single-use. Each review round is a new delegate_task with the original brief, your findings, and any open objections, plus a new clientRequestId. Never message a child thread to continue it.",
      '- Use mode "async", then end your turn; finished workers wake you. Do not poll.',
      "- Workers share one checkout: give every brief non-overlapping file ownership.",
      settings.agentOrchestratorOwnsGit
        ? "- You handle git and publishing; workers never commit or push."
        : null,
      "- If your task came from delegate_task, do it yourself and never delegate.",
    ];
    sections.push(lines.filter((line) => line !== null).join("\n"));
  }
  if (settings.agentInstructions !== "") sections.push(settings.agentInstructions);
  return sections.join("\n\n");
}

function applySettings(settings: ServerSettingsValues): void {
  const environment = buildAgentInstructionsText(settings);
  const projects = new Map<string, string>();
  for (const projectId of Object.keys(settings.projectSettingsOverrides) as Array<
    keyof ServerSettingsValues["projectSettingsOverrides"]
  >) {
    const text = buildAgentInstructionsText(resolveProjectSettings(settings, projectId).settings);
    if (text !== environment) projects.set(projectId, text);
  }
  setForkAgentInstructions({ environment, projects });
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    applySettings(yield* settings.getSettings.pipe(Effect.orDie));
    yield* changes.pipe(
      Stream.runForEach((value) => Effect.sync(() => applySettings(value))),
      Effect.forkScoped,
    );
  }),
);
