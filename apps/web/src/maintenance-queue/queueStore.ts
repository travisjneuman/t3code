/**
 * Updates waiting for their target to go idle, kept per client in
 * localStorage so a reload or relaunch keeps them. Storage can be missing or
 * blocked; the queue then lives for this session only. Fork add-on:
 * maintenance queue.
 *
 * @module maintenance-queue/queueStore
 */
import {
  EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ServerProviderUpdateInput,
  ServerSelfUpdateInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "t3code:maintenance-queue:v1";

const QueuedUpdateSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("provider"),
    environmentId: EnvironmentId,
    input: ServerProviderUpdateInput,
    queuedAt: Schema.Number,
    notifiedAt: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("server"),
    environmentId: EnvironmentId,
    input: ServerSelfUpdateInput,
    queuedAt: Schema.Number,
    notifiedAt: Schema.NullOr(Schema.Number),
  }),
]);
export type QueuedUpdate = typeof QueuedUpdateSchema.Type;

const decodeQueuedUpdate = Schema.decodeUnknownOption(QueuedUpdateSchema);

/** One job per provider instance or server; queuing it again keeps the first wait. */
export function queuedUpdateKey(job: QueuedUpdate): string {
  return job.kind === "provider"
    ? `${job.environmentId}:provider:${job.input.instanceId ?? job.input.provider}`
    : `${job.environmentId}:server`;
}

/** What the job updates, for the sidebar and toasts. */
export function queuedUpdateTitle(job: QueuedUpdate): string {
  return job.kind === "provider"
    ? `${PROVIDER_DISPLAY_NAMES[job.input.provider] ?? job.input.provider} update`
    : `T3 server update to ${job.input.targetVersion}`;
}

/** Null when storage is unavailable, as opposed to holding no jobs. */
function readStorage(): ReadonlyArray<QueuedUpdate> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.flatMap((item) => Option.toArray(decodeQueuedUpdate(item)))
      : [];
  } catch {
    return null;
  }
}

function writeStorage(next: ReadonlyArray<QueuedUpdate>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage only loses the queue on reload.
  }
}

let jobs: ReadonlyArray<QueuedUpdate> = typeof window === "undefined" ? [] : (readStorage() ?? []);
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function commit(next: ReadonlyArray<QueuedUpdate>): void {
  jobs = next;
  writeStorage(next);
  notify();
}

if (typeof window !== "undefined") {
  // Another tab of this client changed the queue.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    jobs = readStorage() ?? jobs;
    notify();
  });
}

export function getQueuedUpdates(): ReadonlyArray<QueuedUpdate> {
  return jobs;
}

export function subscribeQueuedUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useQueuedUpdates(): ReadonlyArray<QueuedUpdate> {
  return useSyncExternalStore(subscribeQueuedUpdates, getQueuedUpdates, getQueuedUpdates);
}

export function enqueueUpdate(job: QueuedUpdate): void {
  const key = queuedUpdateKey(job);
  const existing = jobs.find((queued) => queuedUpdateKey(queued) === key);
  const next: QueuedUpdate = existing
    ? { ...job, queuedAt: existing.queuedAt, notifiedAt: existing.notifiedAt }
    : job;
  commit([...jobs.filter((queued) => queuedUpdateKey(queued) !== key), next]);
}

export function removeQueuedUpdate(key: string): void {
  if (!jobs.some((job) => queuedUpdateKey(job) === key)) return;
  commit(jobs.filter((job) => queuedUpdateKey(job) !== key));
}

/**
 * Takes a job off the queue to run it. Rereads storage first, so a tab that
 * already took it wins and this one gets null.
 */
export function claimQueuedUpdate(key: string): QueuedUpdate | null {
  const current = readStorage() ?? jobs;
  const job = current.find((queued) => queuedUpdateKey(queued) === key) ?? null;
  commit(current.filter((queued) => queuedUpdateKey(queued) !== key));
  return job;
}

export function markQueuedUpdateNotified(key: string, now: number): void {
  commit(jobs.map((job) => (queuedUpdateKey(job) === key ? { ...job, notifiedAt: now } : job)));
}
