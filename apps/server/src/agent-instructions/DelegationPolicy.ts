/**
 * What the Agents settings enforce on `delegate_task`, beyond the instructions
 * agents read: the worker target for the task's role when the agent leaves it
 * out, the read-only line for review and research workers, the parallel worker
 * limit across every level, the delegation depth, a git worktree per worker,
 * and the worker time limit. Applies only while the parent's Delegation setting (after
 * project overrides and the thread's preset) is not Off, so Off keeps upstream
 * behavior.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import {
  AGENT_READ_ONLY_WORKER_LINE,
  agentWorkerIsReadOnly,
  agentWorkerModelForRole,
  type AgentSettings,
  MAX_AGENT_DELEGATION_DEPTH,
  CommandId,
  type NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import { WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
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

/** The line T3 puts at the top of a worker's task about delegating further. */
export function workerDepthLine(settings: AgentSettings, workerDepth: number): string {
  const remaining = settings.agentMaxDelegationDepth - workerDepth;
  return remaining <= 0
    ? "Do not delegate: you are at the deepest worker level allowed. Do this task yourself."
    : `You may delegate pieces of this task that clearly split off, up to ${remaining} more ${levelLabel(remaining)} of workers below you.`;
}

/**
 * The target and task `delegate_task` dispatches. A retry of an accepted
 * delegation (`isRetry`) skips the limits: its dispatch only replays the
 * recorded result.
 */
export function applyDelegationPolicy(input: {
  readonly settings: AgentSettings;
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">;
  readonly level: DelegationLevel;
  readonly request: OrchestratorMcpDelegateTaskInput;
  readonly isRetry: boolean;
}): Effect.Effect<
  Pick<OrchestratorMcpDelegateTaskInput, "target" | "task">,
  OrchestratorMcpFailure
> {
  const { settings, parent, level, request } = input;
  if (settings.agentDelegationMode === "off") {
    return Effect.succeed({ target: request.target, task: request.task });
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
    task: [
      agentWorkerIsReadOnly(settings, request.role) ? AGENT_READ_ONLY_WORKER_LINE : null,
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
  "target" | "task"
> {
  readonly settings: AgentSettings;
  readonly isRetry: boolean;
}

/** A worker's own worktree, or nothing for a shared checkout. */
export interface WorkerWorkspace {
  readonly task: string;
  /** Spread into the `delegated_task.request` command. */
  readonly command: { readonly workerWorkspace?: { branch: string; worktreePath: string } };
  /** Removes the worktree when the dispatch fails. */
  readonly discard: Effect.Effect<void>;
}

const orchestrationFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

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
    readonly parent: DelegationParent;
    readonly request: OrchestratorMcpDelegateTaskInput;
    readonly isRetry: boolean;
  }): Effect.Effect<PreparedDelegation, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const chain = yield* subagentChain(input.parent);
      const top = chain[chain.length - 1] ?? input.parent;
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
        settings,
        level: { depth: chain.length - 1, activeWorkers },
      });
      return { ...policy, settings, isRetry: input.isRetry };
    });

  /**
   * Runs just before the dispatch. With Worker workspace set to Worktree, makes
   * a worktree and branch from the parent checkout's HEAD for the worker.
   */
  const provisionWorkspace = (
    prepared: PreparedDelegation,
    parent: DelegationParent,
  ): Effect.Effect<WorkerWorkspace, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const shared: WorkerWorkspace = { task: prepared.task, command: {}, discard: Effect.void };
      if (
        prepared.isRetry ||
        prepared.settings.agentDelegationMode === "off" ||
        prepared.settings.agentWorkerWorkspace !== "worktree"
      ) {
        return shared;
      }
      const project = yield* projects.getById(parent.thread.projectId).pipe(
        Effect.mapError(() => orchestrationFailure("Unable to read the thread's project.")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(orchestrationFailure("The thread's project was not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const cwd = parent.thread.worktreePath ?? project.workspaceRoot;
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const created = yield* git
        .createWorktree({
          cwd,
          refName: "HEAD",
          newRefName: `${WORKTREE_BRANCH_PREFIX}/worker-${uuid.replaceAll("-", "").slice(0, 8)}`,
          path: null,
        })
        .pipe(
          Effect.mapError((error) =>
            orchestrationFailure(
              `Unable to create the worker's worktree (Settings, Agents, Worker workspace): ${error.message}`,
            ),
          ),
        );
      const { path: worktreePath, refName: branch } = created.worktree;
      return {
        task: `You work in your own git worktree on branch ${branch}, made from the orchestrator's current commit. Commit your work to this branch; do not push or switch branches.\n\n${prepared.task}`,
        command: { workerWorkspace: { branch, worktreePath } },
        discard: git
          .removeWorktree({ cwd, path: worktreePath, force: true })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("agent-instructions.worker-worktree.discard-failed", { cause }),
            ),
          ),
      };
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

  return { prepare, provisionWorkspace, startTimeLimit } as const;
});
