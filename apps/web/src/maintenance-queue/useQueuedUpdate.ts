/**
 * Hooks for the upstream update entry points. A provider or server update
 * whose target has active sessions is queued instead of run, and the caller
 * gets an interrupted result, which every entry point already treats as
 * skipped. The desktop app's own restart is held in the main process instead;
 * see ./desktopGate. Fork add-on: maintenance queue.
 *
 * @module maintenance-queue/useQueuedUpdate
 */
import {
  type AtomCommand,
  type AtomCommandResult,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  MAINTENANCE_QUEUE_IDLE_MS,
  type ServerProviderUpdateInput,
  type ServerSelfUpdateInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { useAtomCommand } from "../state/use-atom-command";
import {
  idleForMs,
  isThisMachine,
  jobInstanceIds,
  jobWatchesHermes,
  maintenanceReleaseProviderSessions,
  refreshHermesActivity,
  withRpcTimeout,
} from "./activity";
import { enqueueUpdate, getQueuedUpdates, type QueuedUpdate } from "./queueStore";

interface ProviderUpdateRequest {
  readonly environmentId: EnvironmentId;
  readonly input: ServerProviderUpdateInput;
}

interface ServerUpdateRequest {
  readonly environmentId: EnvironmentId;
  readonly input: ServerSelfUpdateInput;
}

const queuedResults = new WeakSet<object>();

function queuedResult<A, E>(): AtomCommandResult<A, E> {
  const result = AsyncResult.failure<A, E>(Cause.interrupt());
  queuedResults.add(result);
  return result;
}

/** True for the result an entry point gets when its update was queued. */
export function isQueuedUpdateResult(result: AtomCommandResult<unknown, unknown>): boolean {
  return queuedResults.has(result);
}

/**
 * Closes the provider's idle sessions on this machine so the update can
 * replace its executables. True when a session there turned busy since the
 * client last looked, so the update has to wait after all.
 */
async function releaseLocalProviderSessions(job: QueuedUpdate): Promise<boolean> {
  if (job.kind !== "provider") return false;
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(job.environmentId),
  );
  if (presentation === null || !isThisMachine(presentation.entry.target)) return false;
  const instanceIds = jobInstanceIds(job, presentation.serverConfig) ?? [];
  // A server without this RPC, or one that fails or never answers, closes
  // nothing and holds nothing: unknown is treated as idle.
  return withRpcTimeout(
    runAtomCommand(
      appAtomRegistry,
      maintenanceReleaseProviderSessions,
      { environmentId: job.environmentId, input: { instanceIds } },
      { reportFailure: false },
    ).then((result) => result._tag === "Success" && result.value.busy.length > 0),
    false,
  );
}

/**
 * True when the job's target has had active sessions within
 * MAINTENANCE_QUEUE_IDLE_MS, in which case the job is now queued. Otherwise
 * the caller runs the update.
 */
export async function holdUpdateIfBusy(job: QueuedUpdate): Promise<boolean> {
  const config =
    appAtomRegistry.get(environmentPresentations.presentationAtom(job.environmentId))
      ?.serverConfig ?? null;
  if (jobWatchesHermes(job, config)) await refreshHermesActivity(job.environmentId);
  const idle =
    idleForMs(job.environmentId, jobInstanceIds(job, config), Date.now()) >=
    MAINTENANCE_QUEUE_IDLE_MS;
  if (!idle || (await releaseLocalProviderSessions(job))) {
    enqueueUpdate(job);
    return true;
  }
  return false;
}

function useQueuedCommand<W extends ProviderUpdateRequest | ServerUpdateRequest, A, E>(
  command: AtomCommand<W, A, E>,
  toJob: (value: W, now: number) => QueuedUpdate,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const run = useAtomCommand(command, { reportFailure: false });
  return useCallback(
    async (value: W) =>
      (await holdUpdateIfBusy(toJob(value, Date.now()))) ? queuedResult<A, E>() : run(value),
    [run, toJob],
  );
}

const toProviderJob = (value: ProviderUpdateRequest, now: number): QueuedUpdate => ({
  kind: "provider",
  environmentId: value.environmentId,
  input: value.input,
  queuedAt: now,
  notifiedAt: null,
});

const toServerJob = (value: ServerUpdateRequest, now: number): QueuedUpdate => ({
  kind: "server",
  environmentId: value.environmentId,
  input: value.input,
  queuedAt: now,
  notifiedAt: null,
});

/**
 * `useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false })`
 * that queues the update while the provider is busy.
 */
export function useQueuedProviderUpdate<W extends ProviderUpdateRequest, A, E>(
  command: AtomCommand<W, A, E>,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  return useQueuedCommand(command, toProviderJob);
}

/**
 * `useAtomCommand(serverEnvironment.updateServer, { reportFailure: false })`
 * that queues the update while the server is busy.
 */
export function useQueuedServerUpdate<W extends ServerUpdateRequest, A, E>(
  command: AtomCommand<W, A, E>,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  return useQueuedCommand(command, toServerJob);
}

/** The Update everything line for a machine whose provider updates did not run. */
export function interruptedProviderUpdateLine(environmentId: EnvironmentId): string {
  return getQueuedUpdates().some(
    (job) => job.kind === "provider" && job.environmentId === environmentId,
  )
    ? "Provider update waits for active sessions"
    : "Provider update interrupted";
}
