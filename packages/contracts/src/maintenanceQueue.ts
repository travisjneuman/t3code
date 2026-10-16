/**
 * Maintenance queue: updates wait until whatever they would restart has no
 * active sessions. `status` reports whether the environment's Hermes Agents
 * are mid-run, since Hermes's T3 tools call this server; `releaseProviderSessions`
 * closes a provider's idle sessions so an update can replace its executables.
 * Fork add-on; see docs/user/fork-updating.md.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt } from "./baseSchemas.ts";
import type { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MAINTENANCE_QUEUE_WS_METHODS = {
  status: "maintenanceQueue.status",
  releaseProviderSessions: "maintenanceQueue.releaseProviderSessions",
} as const;

/** How long a target must stay without active sessions before a queued update runs. */
export const MAINTENANCE_QUEUE_IDLE_MS = 2 * 60 * 1000;

const BUSY_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * True while a thread is running, queued, or waiting on an approval or user
 * input. Paused and stopped threads are idle. A background shell command
 * alone does not count: those are mostly dev servers that never finish.
 */
export function isMaintenanceBusyThread(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "activeRunId" | "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks" | "deletedAt"
  >,
): boolean {
  if (thread.deletedAt !== null) return false;
  return (
    thread.activeRunId !== null ||
    BUSY_RUN_STATUSES.has(thread.status) ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks ?? []).some((task) => task.kind !== "command")
  );
}

/** `unknown` when Hermes could not be reached or did not report; callers treat it as idle. */
export const MaintenanceHermesState = Schema.Literals(["busy", "idle", "unknown"]);
export type MaintenanceHermesState = typeof MaintenanceHermesState.Type;

export const MaintenanceHermesStatus = Schema.Struct({
  instanceId: ProviderInstanceId,
  state: MaintenanceHermesState,
  activeAgents: Schema.NullOr(NonNegativeInt),
});
export type MaintenanceHermesStatus = typeof MaintenanceHermesStatus.Type;

export const MaintenanceQueueStatusResult = Schema.Struct({
  hermes: Schema.Array(MaintenanceHermesStatus),
});
export type MaintenanceQueueStatusResult = typeof MaintenanceQueueStatusResult.Type;

export const MaintenanceReleaseProviderSessionsInput = Schema.Struct({
  instanceIds: Schema.Array(ProviderInstanceId),
});
export type MaintenanceReleaseProviderSessionsInput =
  typeof MaintenanceReleaseProviderSessionsInput.Type;

/** `busy` lists instances left alone because a thread on them is still active. */
export const MaintenanceReleaseProviderSessionsResult = Schema.Struct({
  released: Schema.Array(ProviderInstanceId),
  busy: Schema.Array(ProviderInstanceId),
});
export type MaintenanceReleaseProviderSessionsResult =
  typeof MaintenanceReleaseProviderSessionsResult.Type;

export class MaintenanceQueueError extends Schema.TaggedError<MaintenanceQueueError>()(
  "MaintenanceQueueError",
  { message: Schema.String },
) {}

const MaintenanceQueueRpcError = Schema.Union([
  MaintenanceQueueError,
  EnvironmentAuthorizationError,
]);

export const MaintenanceQueueStatusRpc = Rpc.make(MAINTENANCE_QUEUE_WS_METHODS.status, {
  payload: Schema.Struct({}),
  success: MaintenanceQueueStatusResult,
  error: MaintenanceQueueRpcError,
});

export const MaintenanceReleaseProviderSessionsRpc = Rpc.make(
  MAINTENANCE_QUEUE_WS_METHODS.releaseProviderSessions,
  {
    payload: MaintenanceReleaseProviderSessionsInput,
    success: MaintenanceReleaseProviderSessionsResult,
    error: MaintenanceQueueRpcError,
  },
);

export const MaintenanceQueueRpcs = [
  MaintenanceQueueStatusRpc,
  MaintenanceReleaseProviderSessionsRpc,
] as const;

/** The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. */
export const MAINTENANCE_QUEUE_RPC_SCOPES = {
  [MAINTENANCE_QUEUE_WS_METHODS.status]: AuthOrchestrationReadScope,
  // The same scope as `server.updateProvider`, whose update this prepares.
  [MAINTENANCE_QUEUE_WS_METHODS.releaseProviderSessions]: AuthProvidersManageScope,
} as const;
