import * as NodeOS from "node:os";

import {
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  type ProviderThreadId,
  SessionInsightsError,
  type SessionInsights as SessionInsightsResult,
  type SessionInsightsInput,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { HermesInsights } from "@t3tools/provider-hermes/server";
import { HermesSettings } from "@t3tools/provider-hermes/settings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as SessionInsightsReports from "../persistence/SessionInsightsReports.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * The context breakdown and MCP servers a thread's provider session reports,
 * read on demand from the live session. A stopped session is never started:
 * it answers with the last report read while it ran. Every live report is
 * stored (SessionInsightsReports), so that survives a server restart; the
 * memory map is a read-through cache in front of the table.
 * Hermes keeps its own session store, so a Hermes thread is read from Hermes
 * over HTTP instead, running or not (provider-hermes insights.ts).
 */
export class SessionInsights extends Context.Service<
  SessionInsights,
  {
    readonly get: (
      input: SessionInsightsInput,
    ) => Effect.Effect<SessionInsightsResult, SessionInsightsError>;
  }
>()("t3/sessionInsights/SessionInsights") {}

/** Last reports cached in memory; the oldest is dropped past this, and stays stored. */
const MAX_REMEMBERED_REPORTS = 200;
/** A provider that does not answer leaves that part empty rather than the panel loading. */
const PART_TIMEOUT = "10 seconds";
const HERMES_DRIVER = ProviderDriverKind.make("hermes");
/** Hermes pages a long session's messages, so it gets longer than one live read. */
const HERMES_TIMEOUT = "30 seconds";
const decodeHermesSettings = Schema.decodeUnknownOption(HermesSettings);
// The server's machine: every report names it for the card's Environment rows.
const HOST = NodeOS.hostname() || undefined;
const withHost = (report: SessionInsightsResult): SessionInsightsResult =>
  HOST === undefined || report.host !== undefined ? report : { ...report, host: HOST };
const hostOfUrl = (url: string): string | undefined => {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
};

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const storedReports = yield* SessionInsightsReports.SessionInsightsReportRepository;
  // Insertion order is recency: a report is re-inserted whenever it is replaced.
  const lastReports = new Map<ProviderThreadId, SessionInsightsResult>();

  const cache = (report: SessionInsightsResult) => {
    lastReports.delete(report.providerThreadId);
    lastReports.set(report.providerThreadId, report);
    if (lastReports.size > MAX_REMEMBERED_REPORTS) {
      const oldest = lastReports.keys().next();
      if (oldest.done !== true) lastReports.delete(oldest.value);
    }
  };

  /** Caches and stores a live report; a failed write leaves it in memory only. */
  const remember = (threadId: ThreadId, report: SessionInsightsResult) => {
    cache(report);
    if (report.capturedAt === null) return Effect.void;
    return storedReports
      .put({
        providerThreadId: report.providerThreadId,
        threadId,
        capturedAt: report.capturedAt,
        context: report.context,
        mcpServers: report.mcpServers,
        ...(report.session === undefined ? {} : { session: report.session }),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("session-insights.store-failed", {
            providerThreadId: report.providerThreadId,
            error: error._tag,
          }),
        ),
      );
  };

  /**
   * The last report for a provider thread: memory first, then the table. A
   * stored report is cached as it was read, dated when it was captured.
   */
  const recall = Effect.fn("SessionInsights.recall")(function* (
    providerThread: OrchestrationV2ProviderThread,
  ) {
    const remembered = lastReports.get(providerThread.id);
    if (remembered !== undefined) return remembered;
    const stored = yield* storedReports.get(providerThread.id).pipe(
      Effect.catch((error) =>
        Effect.logWarning("session-insights.recall-failed", {
          providerThreadId: providerThread.id,
          error: error._tag,
        }).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(stored)) return undefined;
    const report: SessionInsightsResult = {
      providerThreadId: providerThread.id,
      instanceId: providerThread.providerInstanceId,
      driver: providerThread.driver,
      live: false,
      capturedAt: stored.value.capturedAt,
      context: stored.value.context,
      mcpServers: stored.value.mcpServers,
      ...(stored.value.session === undefined ? {} : { session: stored.value.session }),
    };
    cache(report);
    return report;
  });

  const fail = (threadId: ThreadId, reason: SessionInsightsError["reason"], cause?: unknown) =>
    new SessionInsightsError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  /** One part of the report; a failure empties that part and leaves the other. */
  const readPart = <A>(
    part: "context" | "mcpServers",
    providerThreadId: ProviderThreadId,
    read: Effect.Effect<A, ProviderAdapter.ProviderAdapterV2Error> | undefined,
  ): Effect.Effect<A | null> =>
    read === undefined
      ? Effect.succeed(null)
      : read.pipe(
          Effect.timeout(PART_TIMEOUT),
          Effect.catch((error) =>
            Effect.logWarning("session-insights.read-failed", {
              part,
              providerThreadId,
              error: error._tag,
              detail: error.message,
            }).pipe(Effect.as(null)),
          ),
        );

  /**
   * A Hermes thread's report from Hermes itself, or undefined when the
   * instance is gone, its settings do not decode, or Hermes answered nothing.
   */
  const readHermes = Effect.fn("SessionInsights.readHermes")(function* (
    providerThread: OrchestrationV2ProviderThread,
  ) {
    const sessionId = providerThread.nativeThreadRef?.nativeId ?? null;
    if (sessionId === null) return undefined;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    const instance = settings?.providerInstances[providerThread.providerInstanceId];
    if (instance === undefined || instance.driver !== HERMES_DRIVER) return undefined;
    const hermesSettings = Option.getOrUndefined(decodeHermesSettings(instance.config ?? {}));
    if (hermesSettings === undefined) return undefined;
    const read = yield* HermesInsights.read({ settings: hermesSettings, sessionId }).pipe(
      Effect.timeout(HERMES_TIMEOUT),
      Effect.catch(() =>
        Effect.logWarning("session-insights.hermes-timeout", {
          providerThreadId: providerThread.id,
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (
      read === undefined ||
      (read.session === null && read.context === null && read.mcpServers === null)
    ) {
      return undefined;
    }
    // The agent runs where Hermes runs, not on this server.
    const host = hostOfUrl(hermesSettings.apiUrl);
    const report: SessionInsightsResult = {
      providerThreadId: providerThread.id,
      instanceId: providerThread.providerInstanceId,
      driver: providerThread.driver,
      // Hermes answered for the session itself, whether or not T3 runs it now.
      live: true,
      capturedAt: DateTime.formatIso(yield* DateTime.now),
      context: read.context,
      mcpServers: read.mcpServers,
      ...(host === undefined ? {} : { host }),
      ...(read.session === null ? {} : { session: read.session }),
    };
    return report;
  });

  const get = Effect.fn("SessionInsights.get")(function* (input: SessionInsightsInput) {
    const projection = yield* threadManagement
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    // The thread's current provider thread, as provider feedback picks it.
    const providerThread =
      projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      ) ?? projection.providerThreads.at(-1);
    if (providerThread === undefined) {
      return yield* fail(input.threadId, "no-provider-thread");
    }

    if (providerThread.driver === HERMES_DRIVER) {
      const hermes = yield* readHermes(providerThread);
      if (hermes !== undefined) {
        yield* remember(input.threadId, hermes);
        return hermes;
      }
    }

    const runtime =
      providerThread.providerSessionId === null
        ? undefined
        : Option.getOrUndefined(
            yield* providerSessions
              .get(providerThread.providerSessionId)
              .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause))),
          );
    const insights: ProviderAdapter.ProviderAdapterV2SessionInsights | undefined =
      runtime?.sessionInsights;
    if (runtime === undefined || insights === undefined) {
      const remembered = yield* recall(providerThread);
      return withHost(
        remembered === undefined
          ? {
              providerThreadId: providerThread.id,
              instanceId: providerThread.providerInstanceId,
              driver: providerThread.driver,
              live: false,
              capturedAt: null,
              context: null,
              mcpServers: null,
            }
          : { ...remembered, live: false },
      );
    }

    const [context, mcpServers] = yield* Effect.all(
      [
        readPart("context", providerThread.id, insights.contextBreakdown?.({ providerThread })),
        readPart("mcpServers", providerThread.id, insights.mcpServers?.({ providerThread })),
      ],
      { concurrency: 2 },
    );
    const report: SessionInsightsResult = {
      providerThreadId: providerThread.id,
      instanceId: providerThread.providerInstanceId,
      driver: providerThread.driver,
      live: true,
      capturedAt: DateTime.formatIso(yield* DateTime.now),
      context,
      mcpServers,
    };
    if (context !== null || mcpServers !== null) {
      yield* remember(input.threadId, report);
      return withHost(report);
    }
    // A reopened session answers nothing until its first turn (Claude opens its
    // query then), so the last report stands in, still dated when it was read.
    const remembered = yield* recall(providerThread);
    return withHost(remembered === undefined ? report : { ...remembered, live: true });
  });

  return SessionInsights.of({ get });
});

export const layer = Layer.effect(SessionInsights, make).pipe(
  Layer.provide(SessionInsightsReports.layer),
);
