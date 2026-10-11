/**
 * What the Agents settings enforce on `delegate_task`, beyond the instructions
 * agents read: the worker target for the task's role when the agent leaves it
 * out, the read-only line for review and research workers, the parallel worker
 * limit, and whether workers may delegate. Applies only while the project's
 * Delegation setting is not Off, so Off keeps upstream behavior.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import {
  AGENT_READ_ONLY_WORKER_LINE,
  agentWorkerIsReadOnly,
  agentWorkerModelForRole,
  type AgentSettings,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";

const ACTIVE_WORKER_STATUSES = new Set(["pending", "running", "waiting"]);

/**
 * The target and task `delegate_task` dispatches. A retry of an accepted
 * delegation (`isRetry`) skips the limits: its dispatch only replays the
 * recorded result.
 */
export function applyDelegationPolicy(input: {
  readonly settings: AgentSettings;
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">;
  readonly request: OrchestratorMcpDelegateTaskInput;
  readonly isRetry: boolean;
}): Effect.Effect<
  Pick<OrchestratorMcpDelegateTaskInput, "target" | "task">,
  OrchestratorMcpFailure
> {
  const { settings, parent, request } = input;
  if (settings.agentDelegationMode === "off") {
    return Effect.succeed({ target: request.target, task: request.task });
  }
  if (!input.isRetry) {
    if (
      !settings.agentWorkersCanDelegate &&
      parent.thread.lineage.relationshipToParent === "subagent"
    ) {
      return Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Workers may not delegate (Settings, Agents, Workers can delegate is off). Do this task yourself.",
        }),
      );
    }
    const limit = settings.agentMaxParallelWorkers;
    const active = parent.subagents.filter(
      (task) => task.origin === "app_owned" && ACTIVE_WORKER_STATUSES.has(task.status),
    ).length;
    if (limit !== null && active >= limit) {
      return Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Worker limit reached: ${active} of ${limit} workers are still running (Settings, Agents, Parallel workers). End your turn; a finishing worker wakes you, then delegate the rest.`,
        }),
      );
    }
  }
  const requested = request.target;
  const roleModel =
    requested?.providerInstanceId === undefined &&
    requested?.driverKind === undefined &&
    requested?.model === undefined
      ? agentWorkerModelForRole(settings, request.role)
      : null;
  const options = requested?.options ?? roleModel?.options;
  return Effect.succeed({
    target:
      roleModel === null
        ? requested
        : {
            providerInstanceId: roleModel.instanceId,
            model: roleModel.model,
            ...(options === undefined ? {} : { options }),
          },
    task: agentWorkerIsReadOnly(settings, request.role)
      ? `${AGENT_READ_ONLY_WORKER_LINE}\n\n${request.task}`
      : request.task,
  });
}

/** `applyDelegationPolicy` with the settings resolved for the parent's project. */
export function loadDelegationPolicy<E>(
  settings: Effect.Effect<ServerSettings, E>,
  input: Omit<Parameters<typeof applyDelegationPolicy>[0], "settings">,
) {
  return settings.pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Unable to read server settings.",
        }),
    ),
    Effect.flatMap((value) =>
      applyDelegationPolicy({
        ...input,
        settings: resolveProjectSettings(value, input.parent.thread.projectId).settings,
      }),
    ),
  );
}
