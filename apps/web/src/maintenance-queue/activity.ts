/**
 * Which update targets are in use. Busy means a thread is running, queued, or
 * waiting on an approval or user input, or a Hermes Agent is mid-run; paused
 * and stopped threads are idle. Each environment keeps when each provider
 * instance was last seen busy, so a target counts as idle only after
 * MAINTENANCE_QUEUE_IDLE_MS without activity. Fork add-on: maintenance queue.
 *
 * @module maintenance-queue/activity
 */
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  isMaintenanceBusyThread,
  MAINTENANCE_QUEUE_WS_METHODS,
  type MaintenanceHermesStatus,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { connectionAtomRuntime } from "../connection/runtime";
import { isElectron } from "../env";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import type { QueuedUpdate } from "./queueStore";

const HERMES_DRIVER = ProviderDriverKind.make("hermes");
const ANY_INSTANCE = "*";
// Longer than the server's own 5 second Hermes timeout; an answer that never
// comes is unknown, like a failed one.
const RPC_TIMEOUT_MS = 8_000;

/** Settles to `fallback` when `promise` takes longer than RPC_TIMEOUT_MS. */
export function withRpcTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), RPC_TIMEOUT_MS);
    void promise.then((value) => {
      window.clearTimeout(timer);
      resolve(value);
    });
  });
}

export const maintenanceQueueStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:maintenance-queue:status",
  tag: MAINTENANCE_QUEUE_WS_METHODS.status,
});

export const maintenanceReleaseProviderSessions = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  {
    label: "environment-data:maintenance-queue:release-provider-sessions",
    tag: MAINTENANCE_QUEUE_WS_METHODS.releaseProviderSessions,
  },
);

/** The provider instance of each busy thread, sorted; the same array while that set holds. */
export const busyThreadInstancesAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous: ReadonlyArray<string> = [];
  return Atom.make((get) => {
    const next = get(environmentThreadShells.environmentThreadsAtom(environmentId))
      .flatMap((thread) => (isMaintenanceBusyThread(thread) ? [thread.providerInstanceId] : []))
      .sort();
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`maintenance-queue-busy-threads:${environmentId}`));
});

interface EnvironmentActivity {
  readonly threads: ReadonlyArray<string>;
  readonly hermes: ReadonlyArray<MaintenanceHermesStatus>;
  /** Per provider instance, and ANY_INSTANCE, when it was last seen busy. */
  readonly lastBusyAt: ReadonlyMap<string, number>;
  readonly connectedAt: number | null;
}

const EMPTY_ACTIVITY: EnvironmentActivity = {
  threads: [],
  hermes: [],
  lastBusyAt: new Map(),
  connectedAt: null,
};

const activity = new Map<EnvironmentId, EnvironmentActivity>();
const activityListeners = new Set<() => void>();
let activityVersion = 0;

export function subscribeActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

export function getActivityVersion(): number {
  return activityVersion;
}

function busyCounts(entry: EnvironmentActivity): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const instanceId of entry.threads) counts.set(instanceId, (counts.get(instanceId) ?? 0) + 1);
  for (const status of entry.hermes) {
    if (status.state !== "busy") continue;
    // A Hermes Agent driven from a T3 thread is counted once, not twice.
    const agents = Math.max(status.activeAgents ?? 0, 1);
    counts.set(status.instanceId, Math.max(counts.get(status.instanceId) ?? 0, agents));
  }
  return counts;
}

function update(environmentId: EnvironmentId, patch: Partial<EnvironmentActivity>): void {
  const previous = activity.get(environmentId) ?? EMPTY_ACTIVITY;
  const next = { ...previous, ...patch };
  const now = Date.now();
  const lastBusyAt = new Map(next.lastBusyAt);
  // Instances busy before or after this change were busy until now.
  for (const instanceId of new Set([...busyCounts(previous).keys(), ...busyCounts(next).keys()])) {
    lastBusyAt.set(instanceId, now);
    lastBusyAt.set(ANY_INSTANCE, now);
  }
  activity.set(environmentId, { ...next, lastBusyAt });
  activityVersion += 1;
  for (const listener of activityListeners) listener();
}

export function recordBusyThreads(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<string>,
): void {
  if ((activity.get(environmentId) ?? EMPTY_ACTIVITY).threads === threads) return;
  update(environmentId, { threads });
}

/**
 * Starts the idle clock over on every (re)connect: until the environment's
 * threads arrive again, what this client last saw of them may be stale.
 */
export function recordConnected(environmentId: EnvironmentId, connected: boolean): void {
  const connectedAt = connected ? Date.now() : null;
  const previous = activity.get(environmentId) ?? EMPTY_ACTIVITY;
  if ((previous.connectedAt === null) === (connectedAt === null)) return;
  update(environmentId, { connectedAt });
}

/**
 * Asks the environment whether its Hermes Agents are mid-run. A server too
 * old to have this RPC, or one that fails, reports nothing: unknown, which
 * counts as idle so a missing answer never holds an update forever.
 */
export async function refreshHermesActivity(environmentId: EnvironmentId): Promise<void> {
  const hermes = await withRpcTimeout(
    runAtomCommand(
      appAtomRegistry,
      maintenanceQueueStatus,
      { environmentId, input: {} },
      { reportFailure: false },
    ).then((result) => (result._tag === "Success" ? result.value.hermes : [])),
    [],
  );
  update(environmentId, { hermes });
}

function enabledHermesInstances(config: ServerConfig | null): ReadonlyArray<string> {
  return (config?.providers ?? []).flatMap((provider) =>
    provider.driver === HERMES_DRIVER && provider.enabled ? [provider.instanceId] : [],
  );
}

export function hasHermes(config: ServerConfig | null): boolean {
  return enabledHermesInstances(config).length > 0;
}

/** True when updating the job's target could interrupt a Hermes Agent. */
export function jobWatchesHermes(job: QueuedUpdate, config: ServerConfig | null): boolean {
  if (job.kind === "server") return hasHermes(config);
  return (
    job.input.provider === HERMES_DRIVER ||
    (job.input.instanceId !== undefined &&
      enabledHermesInstances(config).includes(job.input.instanceId))
  );
}

/** The provider instances an update replaces; null for a whole server. */
export function jobInstanceIds(
  job: QueuedUpdate,
  config: ServerConfig | null,
): ReadonlyArray<ProviderInstanceId> | null {
  if (job.kind === "server") return null;
  if (job.input.instanceId !== undefined) return [job.input.instanceId];
  const instances = (config?.providers ?? [])
    .filter((provider) => provider.driver === job.input.provider)
    .map((provider) => provider.instanceId);
  return instances.length > 0 ? instances : [defaultInstanceIdForDriver(job.input.provider)];
}

/** Active sessions on these instances of the environment, or on all of it for null. */
export function busySessionCount(
  environmentId: EnvironmentId,
  instanceIds: ReadonlyArray<string> | null,
): number {
  const counts = busyCounts(activity.get(environmentId) ?? EMPTY_ACTIVITY);
  let total = 0;
  for (const [instanceId, count] of counts) {
    if (instanceIds === null || instanceIds.includes(instanceId)) total += count;
  }
  return total;
}

/** How long the target has gone without activity; 0 while busy. */
export function idleForMs(
  environmentId: EnvironmentId,
  instanceIds: ReadonlyArray<string> | null,
  now: number,
): number {
  if (busySessionCount(environmentId, instanceIds) > 0) return 0;
  const entry = activity.get(environmentId) ?? EMPTY_ACTIVITY;
  const keys = instanceIds ?? [ANY_INSTANCE];
  const lastBusy = Math.max(...keys.map((key) => entry.lastBusyAt.get(key) ?? -Infinity));
  return now - lastBusy;
}

/** Milliseconds since the environment last (re)connected; null while it is not connected. */
export function connectedForMs(environmentId: EnvironmentId, now: number): number | null {
  const connectedAt = (activity.get(environmentId) ?? EMPTY_ACTIVITY).connectedAt;
  return connectedAt === null ? null : now - connectedAt;
}

/** Environments served from the machine this desktop app runs on. */
export function isThisMachine(target: ConnectionTarget): boolean {
  return (
    isElectron &&
    (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target))
  );
}

/** The environments a restart of this desktop app would stop, with their config. */
export function thisMachineEnvironments(): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig | null;
}> {
  return Array.from(appAtomRegistry.get(environmentPresentations.presentationsAtom)).flatMap(
    ([environmentId, presentation]) =>
      isThisMachine(presentation.entry.target)
        ? [
            {
              environmentId,
              config: appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
            },
          ]
        : [],
  );
}

/** Active sessions a restart of this desktop app would interrupt. */
export function thisMachineBusySessionCount(): number {
  return thisMachineEnvironments().reduce(
    (total, { environmentId }) => total + busySessionCount(environmentId, null),
    0,
  );
}
