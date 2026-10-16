/**
 * What the client's update queue needs from this server: whether its Hermes
 * Agents are mid-run, and closing a provider's idle sessions before an update
 * replaces that provider's executables. Fork add-on: maintenance queue.
 *
 * @module maintenance-queue/MaintenanceQueue
 */
import {
  isMaintenanceBusyThread,
  type MaintenanceHermesStatus,
  MaintenanceQueueError,
  type MaintenanceQueueStatusResult,
  type MaintenanceReleaseProviderSessionsInput,
  type MaintenanceReleaseProviderSessionsResult,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { HermesApi } from "@t3tools/provider-hermes/server";
import { HermesSettings } from "@t3tools/provider-hermes/settings";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const HERMES_DRIVER = ProviderDriverKind.make("hermes");
// The queue asks again on its next check, so a slow Hermes reads as unknown
// rather than holding the request for the API client's full 30 seconds.
const HERMES_HEALTH_TIMEOUT = Duration.seconds(5);

const decodeHermesSettings = Schema.decodeUnknownOption(HermesSettings);
const decodeHermesHealth = Schema.decodeUnknownOption(
  Schema.Struct({
    gateway_busy: Schema.optional(Schema.Boolean),
    active_agents: Schema.optional(Schema.Number),
  }),
);

export class MaintenanceQueue extends Context.Service<
  MaintenanceQueue,
  {
    readonly status: Effect.Effect<MaintenanceQueueStatusResult, MaintenanceQueueError>;
    readonly releaseProviderSessions: (
      input: MaintenanceReleaseProviderSessionsInput,
    ) => Effect.Effect<MaintenanceReleaseProviderSessionsResult, MaintenanceQueueError>;
  }
>()("t3/maintenance-queue/MaintenanceQueue") {}

const failed = (message: string) => () => new MaintenanceQueueError({ message });

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const hermesStatus = (instanceId: ProviderInstanceId, settings: HermesSettings) =>
    HermesApi.apiRequest(HermesApi.connectionOf(settings), "GET", "/health/detailed").pipe(
      Effect.timeoutOption(HERMES_HEALTH_TIMEOUT),
      Effect.map((response): MaintenanceHermesStatus => {
        const health = Option.flatMap(response, decodeHermesHealth);
        if (Option.isNone(health)) return { instanceId, state: "unknown", activeAgents: null };
        const { gateway_busy: gatewayBusy, active_agents: activeAgents } = health.value;
        if (gatewayBusy === undefined && activeAgents === undefined) {
          return { instanceId, state: "unknown", activeAgents: null };
        }
        const agents = activeAgents === undefined ? null : Math.max(0, Math.floor(activeAgents));
        return {
          instanceId,
          state: gatewayBusy === true || (agents ?? 0) > 0 ? "busy" : "idle",
          activeAgents: agents,
        };
      }),
      Effect.catch(() =>
        Effect.succeed<MaintenanceHermesStatus>({
          instanceId,
          state: "unknown",
          activeAgents: null,
        }),
      ),
    );

  const status = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failed("Could not read settings.")),
    );
    const instances = Object.entries(settings.providerInstances).flatMap(([id, instance]) => {
      if (instance.driver !== HERMES_DRIVER || instance.enabled === false) return [];
      const hermes = decodeHermesSettings(instance.config ?? {});
      return Option.isSome(hermes) && hermes.value.apiUrl !== ""
        ? [{ instanceId: id as ProviderInstanceId, settings: hermes.value }]
        : [];
    });
    const hermes = yield* Effect.forEach(
      instances,
      ({ instanceId, settings: hermesSettings }) => hermesStatus(instanceId, hermesSettings),
      { concurrency: "unbounded" },
    );
    return { hermes };
  }).pipe(Effect.withSpan("MaintenanceQueue.status"));

  const releaseProviderSessions = Effect.fn("MaintenanceQueue.releaseProviderSessions")(function* (
    input: MaintenanceReleaseProviderSessionsInput,
  ) {
    const snapshot = yield* threadManagement
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError(failed("Could not read the threads.")));
    // Rechecked here, after the client's idle wait, so a turn that started in
    // between keeps its session; closeInstance would release it mid-turn.
    const busyInstances = new Set<string>(
      snapshot.threads.filter(isMaintenanceBusyThread).map((thread) => thread.providerInstanceId),
    );
    const released: Array<ProviderInstanceId> = [];
    const busy: Array<ProviderInstanceId> = [];
    for (const instanceId of input.instanceIds) {
      if (busyInstances.has(instanceId)) {
        busy.push(instanceId);
        continue;
      }
      yield* providerSessions
        .closeInstance(instanceId)
        .pipe(Effect.mapError(failed("Could not close the provider's idle sessions.")));
      released.push(instanceId);
    }
    return { released, busy };
  });

  return MaintenanceQueue.of({ status, releaseProviderSessions });
});

export const layer = Layer.effect(MaintenanceQueue, make);
