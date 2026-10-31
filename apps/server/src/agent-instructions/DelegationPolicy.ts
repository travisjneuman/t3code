/**
 * What the Agents settings enforce on `delegate_task`, beyond the instructions
 * agents read: the worker target for the task's role when the agent leaves it
 * out, the read-only line for review and research workers, the parallel worker
 * limit across every level, the delegation depth, upstream's worktree isolation
 * as the default for workers, and the worker time limit. Applies only while the
 * parent's Delegation setting (after project overrides and the thread's preset)
 * is not Off, so Off keeps upstream behavior.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import {
  AGENT_READ_ONLY_WORKER_LINE,
  agentWorkerIsReadOnly,
  agentWorkerModelForRole,
  type AgentSettings,
  defaultInstanceIdForDriver,
  MAX_AGENT_DELEGATION_DEPTH,
  CommandId,
  type NodeId,
  type OrchestratorMcpTarget,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveThreadAgentSettings } from "./AgentInstructionsSync.ts";

const ACTIVE_WORKER_STATUSES = new Set(["pending", "running", "waiting"]);

type DelegationSubagents = OrchestrationV2ThreadProjection["subagents"];

function activeWorkerCount(subagents: DelegationSubagents): number {
  return subagents.filter(
    (task) => task.origin === "app_owned" && ACTIVE_WORKER_STATUSES.has(task.status),
  ).length;
}

/** Where the delegating agent sits under the thread's agent. */
export interface DelegationLevel {
  /** Subagent levels above the delegating agent: 0 for the thread's agent. */
  readonly depth: number;
  /** Workers running anywhere under the thread's agent. */
  readonly activeWorkers: number;
}

function levelLabel(count: number): string {
  return count === 1 ? "level" : "levels";
}

function optionSelectionsKey(
  options: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined,
): string {
  return JSON.stringify(
    [...(options ?? [])]
      .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(({ id, value }) => [id, value]),
  );
}

function fixedTargetMatches(
  requested: OrchestratorMcpTarget | undefined,
  selection: NonNullable<ReturnType<typeof agentWorkerModelForRole>>,
  providers: ReadonlyArray<ServerProvider> | undefined,
): boolean {
  if (requested === undefined) return true;
  if (
    requested.providerInstanceId !== undefined &&
    requested.providerInstanceId !== selection.instanceId
  ) {
    return false;
  }
  if (requested.driverKind !== undefined) {
    const selectedProvider = providers?.find(
      (provider) => provider.instanceId === selection.instanceId,
    );
    const selectedDriver =
      selectedProvider?.driver ??
      (defaultInstanceIdForDriver(requested.driverKind) === selection.instanceId
        ? requested.driverKind
        : undefined);
    if (selectedDriver !== requested.driverKind) return false;
  }
  if (requested.model !== undefined && requested.model !== selection.model) return false;
  if (
    requested.options !== undefined &&
    optionSelectionsKey(requested.options) !== optionSelectionsKey(selection.options)
  ) {
    return false;
  }
  return true;
}

function fixedTargetFailure(role: string | undefined, configured: boolean): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    message: configured
      ? `Worker targets are fixed in Settings > Agents. The requested target conflicts with the configured ${role ? `${role} ` : ""}worker target; leave target out or use its configured provider, model, and options.`
      : `Worker targets are fixed in Settings > Agents, but no target is configured for the ${role ? `${role} ` : ""}worker. Configure a worker model before delegating.`,
  });
}

const WORKTREE_WORKER_LINE =
  "You work in your own git worktree and branch, made from the orchestrator's current commit. Commit your work to this branch; do not push or switch branches.";

/** The line T3 puts at the top of a worker's task about delegating further. */
export function workerDepthLine(settings: AgentSettings, workerDepth: number): string {
  const remaining = settings.agentMaxDelegationDepth - workerDepth;
  return remaining <= 0
    ? "Do not delegate: you are at the deepest worker level allowed. Do this task yourself."
    : `You may delegate pieces of this task that clearly split off, up to ${remaining} more ${levelLabel(remaining)} of workers below you.`;
}

/**
 * The target, task and isolation `delegate_task` dispatches. A retry of an
 * accepted delegation (`isRetry`) skips the limits: its dispatch only replays
 * the recorded result.
 */
export function applyDelegationPolicy(input: {
  readonly settings: AgentSettings;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">;
  readonly level: DelegationLevel;
  readonly request: OrchestratorMcpDelegateTaskInput;
  readonly isRetry: boolean;
}): Effect.Effect<
  Pick<OrchestratorMcpDelegateTaskInput, "target" | "task" | "isolation">,
  OrchestratorMcpFailure
> {
  const { settings, parent, level, request } = input;
  if (settings.agentDelegationMode === "off") {
    return Effect.succeed({
      target: request.target,
      task: request.task,
      isolation: request.isolation,
    });
  }
  const workerDepth = level.depth + 1;
  if (!input.isRetry) {
    const maxDepth = settings.agentMaxDelegationDepth;
    if (workerDepth > maxDepth) {
      return Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `Delegation depth reached: workers may go ${maxDepth} ${levelLabel(maxDepth)} deep and this would be level ${workerDepth} (Settings, Agents, Delegation depth). Do this task yourself.`,
        }),
      );
    }
    const limit = settings.agentMaxParallelWorkers;
    if (level.activeWorkers >= limit) {
      const own = activeWorkerCount(parent.subagents);
      return Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            own > 0
              ? `Worker limit reached: ${level.activeWorkers} of ${limit} workers are running under this thread, counting every level (Settings, Agents, Parallel workers). End your turn; a finishing worker wakes you, then delegate the rest.`
              : `Worker limit reached: ${level.activeWorkers} of ${limit} workers are running under this thread, counting every level (Settings, Agents, Parallel workers), and none of them are yours to wait for. Do this piece yourself.`,
        }),
      );
    }
  }
  const requested = request.target;
  let target = requested;
  if (settings.agentWorkerModelSelectionFixed && !input.isRetry) {
    const fixedSelection = agentWorkerModelForRole(settings, request.role);
    if (fixedSelection === null) {
      return Effect.fail(fixedTargetFailure(request.role, false));
    }
    if (!fixedTargetMatches(requested, fixedSelection, input.providers)) {
      return Effect.fail(fixedTargetFailure(request.role, true));
    }
    target = {
      providerInstanceId: fixedSelection.instanceId,
      model: fixedSelection.model,
      options: fixedSelection.options ?? [],
    };
  } else if (!settings.agentWorkerModelSelectionFixed) {
    const roleModel =
      requested?.providerInstanceId === undefined &&
      requested?.driverKind === undefined &&
      requested?.model === undefined
        ? agentWorkerModelForRole(settings, request.role)
        : null;
    const options = requested?.options ?? roleModel?.options;
    target =
      roleModel === null
        ? requested
        : {
            providerInstanceId: roleModel.instanceId,
            model: roleModel.model,
            ...(options === undefined ? {} : { options }),
          };
  }
  // An explicit isolation, "shared" included, wins over the Worker workspace setting.
  const isolation =
    request.isolation ?? (settings.agentWorkerWorkspace === "worktree" ? "worktree" : undefined);
  const readOnly = agentWorkerIsReadOnly(settings, request.role);
  return Effect.succeed({
    target,
    isolation,
    task: [
      isolation === "worktree" && !readOnly ? WORKTREE_WORKER_LINE : null,
      readOnly ? AGENT_READ_ONLY_WORKER_LINE : null,
      workerDepthLine(settings, workerDepth),
      request.task,
    ]
      .filter((part) => part !== null)
      .join("\n\n"),
  });
}

type DelegationParent = Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">;

/** The checked request plus what the later steps need. */
export interface PreparedDelegation extends Pick<
  OrchestratorMcpDelegateTaskInput,
  "target" | "task" | "isolation"
> {
  readonly settings: AgentSettings;
  readonly isRetry: boolean;
}

const orchestrationFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const readThread = (threadId: ThreadId) =>
    threadManagement
      .getThreadRecords(threadId, ["subagents"])
      .pipe(Effect.mapError(() => orchestrationFailure("Unable to read a related worker thread.")));

  /**
   * The workers above the delegating agent, nearest first, up to the thread's
   * agent (the first thread that is not a subagent), which comes last. Stops
   * past the deepest allowed level, which is enough to refuse.
   */
  const subagentChain = (parent: DelegationParent) =>
    Effect.gen(function* () {
      const chain: Array<DelegationParent> = [parent];
      let current = parent;
      while (
        current.thread.lineage.relationshipToParent === "subagent" &&
        current.thread.lineage.parentThreadId !== null &&
        chain.length <= MAX_AGENT_DELEGATION_DEPTH + 1
      ) {
        current = yield* readThread(current.thread.lineage.parentThreadId);
        chain.push(current);
      }
      return chain;
    });

  /** Running workers under `top`, at every level. Finished workers' threads are walked too. */
  const activeWorkersUnder = (top: DelegationParent) => {
    const count = (
      subagents: DelegationSubagents,
      level: number,
    ): Effect.Effect<number, OrchestratorMcpFailure> =>
      Effect.gen(function* () {
        let total = activeWorkerCount(subagents);
        if (level >= MAX_AGENT_DELEGATION_DEPTH) return total;
        for (const task of subagents) {
          if (task.origin !== "app_owned" || task.childThreadId === null) continue;
          const child = yield* readThread(task.childThreadId);
          total += yield* count(child.subagents, level + 1);
        }
        return total;
      });
    return count(top.subagents, 1);
  };

  /** Runs before the target is resolved; refuses what the settings forbid. */
  const prepare = (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly request: OrchestratorMcpDelegateTaskInput;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly isRetry: boolean;
  }): Effect.Effect<PreparedDelegation, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      // The caller's projection omits subagents (upstream loads them per task), so read them here.
      const parent: DelegationParent = {
        thread: input.parent.thread,
        subagents: (yield* readThread(input.parent.thread.id)).subagents,
      };
      const chain = yield* subagentChain(parent);
      const top = chain[chain.length - 1] ?? parent;
      const value = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => orchestrationFailure("Unable to read server settings.")),
      );
      // Every ancestor's preset counts, nearest first, then a fork's source and the root.
      const settings = resolveThreadAgentSettings(value, input.parent.thread.projectId, [
        ...chain.map((entry) => entry.thread.id),
        top.thread.lineage.parentThreadId ?? undefined,
        input.parent.thread.lineage.rootThreadId,
      ]);
      const activeWorkers =
        input.isRetry || settings.agentDelegationMode === "off"
          ? 0
          : yield* activeWorkersUnder(top);
      const policy = yield* applyDelegationPolicy({
        ...input,
        parent,
        providers: input.providers,
        settings,
        level: { depth: chain.length - 1, activeWorkers },
      });
      return { ...policy, settings, isRetry: input.isRetry };
    });

  /**
   * With a Worker time limit, stops the worker's thread once it has run that
   * long. The timer lives in this server process, so a restart drops it.
   */
  const startTimeLimit = (
    prepared: PreparedDelegation,
    input: {
      readonly parentThreadId: ThreadId;
      readonly taskId: NodeId;
      readonly commandId: CommandId;
    },
  ): Effect.Effect<void> => {
    const minutes = prepared.settings.agentWorkerTimeLimitMinutes;
    if (prepared.isRetry || prepared.settings.agentDelegationMode === "off" || minutes === null) {
      return Effect.void;
    }
    const stopIfRunning = Effect.gen(function* () {
      const { subagents } = yield* threadManagement.getThreadRecords(input.parentThreadId, [
        "subagents",
      ]);
      const task = subagents.find(
        (candidate) => candidate.id === input.taskId && candidate.origin === "app_owned",
      );
      if (
        task === undefined ||
        task.childThreadId === null ||
        !ACTIVE_WORKER_STATUSES.has(task.status)
      ) {
        return;
      }
      yield* threadManagement.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${input.commandId}:time-limit`),
        threadId: task.childThreadId,
        reason: `Worker time limit of ${minutes} minutes reached (Settings, Agents, Worker time limit).`,
      });
    });
    return Effect.sleep(Duration.minutes(minutes)).pipe(
      Effect.andThen(stopIfRunning),
      Effect.catchCause((cause) =>
        Effect.logWarning("agent-instructions.worker-time-limit.failed", {
          taskId: input.taskId,
          cause,
        }),
      ),
      Effect.forkDetach,
      Effect.asVoid,
    );
  };

  return { prepare, startTimeLimit } as const;
});
