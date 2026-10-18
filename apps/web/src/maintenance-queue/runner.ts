/**
 * Runs queued updates: on its own once the target has stayed idle, or at
 * once when the user picks Update now. Fork add-on: maintenance queue.
 *
 * @module maintenance-queue/runner
 */
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MAINTENANCE_QUEUE_IDLE_MS } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import {
  busySessionCount,
  connectedForMs,
  idleForMs,
  jobInstanceIds,
  jobWatchesHermes,
  refreshHermesActivity,
} from "./activity";
import {
  claimQueuedUpdate,
  getQueuedUpdates,
  markQueuedUpdateNotified,
  type QueuedUpdate,
  queuedUpdateKey,
  queuedUpdateTitle,
} from "./queueStore";
import { holdUpdateIfBusy } from "./useQueuedUpdate";

/** One notification for a job still waiting after this long. */
export const LONG_WAIT_MS = 4 * 60 * 60 * 1000;

export function hostLabel(job: QueuedUpdate): string {
  return (
    appAtomRegistry.get(environmentPresentations.presentationAtom(job.environmentId))?.entry.target
      .label ?? "a disconnected host"
  );
}

export function waitingLine(count: number, host: string): string {
  return count > 0
    ? `Waiting for ${count} active ${count === 1 ? "session" : "sessions"} on ${host}`
    : `Waiting for ${host} to stay idle`;
}

function runUpdate(job: QueuedUpdate) {
  return job.kind === "provider"
    ? runAtomCommand(
        appAtomRegistry,
        serverEnvironment.updateProvider,
        { environmentId: job.environmentId, input: job.input },
        { reportFailure: false },
      )
    : runAtomCommand(
        appAtomRegistry,
        serverEnvironment.updateServer,
        { environmentId: job.environmentId, input: job.input },
        { reportFailure: false },
      );
}

/** Runs an update at once and reports how it ended. */
export async function runAndReport(job: QueuedUpdate): Promise<void> {
  const title = queuedUpdateTitle(job);
  const host = hostLabel(job);
  const result = await runUpdate(job);
  if (result._tag === "Success") {
    toastManager.add(
      stackedThreadToast({ type: "success", title: `${title} finished`, description: host }),
    );
    return;
  }
  if (isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: `${title} failed on ${host}`,
      description: error instanceof Error ? error.message : "The update could not run.",
    }),
  );
}

/** Update now: runs the job whatever its target is doing. */
export async function runQueuedUpdateNow(key: string): Promise<void> {
  const job = claimQueuedUpdate(key);
  if (job !== null) await runAndReport(job);
}

function notifyLongWait(job: QueuedUpdate, now: number): void {
  if (job.notifiedAt !== null || now - job.queuedAt < LONG_WAIT_MS) return;
  markQueuedUpdateNotified(queuedUpdateKey(job), now);
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(job.environmentId));
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: `${queuedUpdateTitle(job)} has waited 4 hours`,
      description: `${waitingLine(
        busySessionCount(job.environmentId, jobInstanceIds(job, config)),
        hostLabel(job),
      )}. Use Update now in the sidebar to run it anyway.`,
      timeout: 0,
    }),
  );
}

async function runIfIdle(job: QueuedUpdate): Promise<void> {
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(job.environmentId),
  );
  if (presentation === null) return;
  // A host that just (re)connected, or a Mac that just woke, may not have sent
  // its current threads yet; what this client last saw of them can be stale.
  const connectedFor = connectedForMs(job.environmentId, Date.now());
  if (connectedFor === null || connectedFor < MAINTENANCE_QUEUE_IDLE_MS) return;
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(job.environmentId));
  if (jobWatchesHermes(job, config)) await refreshHermesActivity(job.environmentId);
  const instanceIds = jobInstanceIds(job, config);
  if (idleForMs(job.environmentId, instanceIds, Date.now()) < MAINTENANCE_QUEUE_IDLE_MS) return;
  const claimed = claimQueuedUpdate(queuedUpdateKey(job));
  // Checked once more, which also closes a local provider's idle sessions;
  // a busy target puts the job back with its original wait.
  if (claimed === null || (await holdUpdateIfBusy(claimed))) return;
  // Not awaited: a server update waits for the host to come back, and the
  // other jobs need not wait with it.
  void runAndReport(claimed);
}

let processing = false;

/** Runs every queued job whose target has settled idle; one pass at a time. */
export async function processQueuedUpdates(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    for (const job of getQueuedUpdates()) {
      notifyLongWait(job, Date.now());
      await runIfIdle(job);
    }
  } finally {
    processing = false;
  }
}
