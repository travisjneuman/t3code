/**
 * What the Agents settings enforce on `delegate_task`, beyond the instructions
 * agents read: the worker target for the task's role when the agent leaves it
 * out, the read-only line for review and research workers, the parallel worker
 * limit, whether workers may delegate, a git worktree per worker, and the
 * worker time limit. Applies only while the parent's Delegation setting (after
 * project overrides and the thread's preset) is not Off, so Off keeps upstream
 * behavior.
 * Fork add-on: agent instructions; see docs/user/agent-instructions.md.
 */
import {
  AGENT_READ_ONLY_WORKER_LINE,
  agentWorkerIsReadOnly,
  agentWorkerModelForRole,
  type AgentSettings,
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

  const settingsFor = (parent: DelegationParent) =>
    serverSettings.getSettings.pipe(
      Effect.mapError(() => orchestrationFailure("Unable to read server settings.")),
      Effect.map((value) =>
        resolveThreadAgentSettings(value, parent.thread.projectId, [
          parent.thread.id,
          parent.thread.lineage.parentThreadId ?? undefined,
          parent.thread.lineage.rootThreadId,
        ]),
      ),
    );

  /** Runs before the target is resolved; refuses what the settings forbid. */
  const prepare = (input: {
    readonly parent: DelegationParent;
    readonly request: OrchestratorMcpDelegateTaskInput;
    readonly isRetry: boolean;
  }): Effect.Effect<PreparedDelegation, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const settings = yield* settingsFor(input.parent);
      const policy = yield* applyDelegationPolicy({ ...input, settings });
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
