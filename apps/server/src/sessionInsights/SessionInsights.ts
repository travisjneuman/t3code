import {
  type ProviderThreadId,
  SessionInsightsError,
  type SessionInsights as SessionInsightsResult,
  type SessionInsightsInput,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * The context breakdown and MCP servers a thread's provider session reports,
 * read on demand from the live session. A stopped session is never started:
 * it answers with the last report read while it ran, if this server kept one.
 */
export class SessionInsights extends Context.Service<
  SessionInsights,
  {
    readonly get: (
      input: SessionInsightsInput,
    ) => Effect.Effect<SessionInsightsResult, SessionInsightsError>;
  }
>()("t3/sessionInsights/SessionInsights") {}

/** Last reports kept for stopped sessions; the oldest is dropped past this. */
const MAX_REMEMBERED_REPORTS = 200;
/** A provider that does not answer leaves that part empty rather than the panel loading. */
const PART_TIMEOUT = "10 seconds";

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  // Insertion order is recency: a report is re-inserted whenever it is replaced.
  const lastReports = new Map<ProviderThreadId, SessionInsightsResult>();

  const remember = (report: SessionInsightsResult) => {
    lastReports.delete(report.providerThreadId);
    lastReports.set(report.providerThreadId, report);
    if (lastReports.size > MAX_REMEMBERED_REPORTS) {
      const oldest = lastReports.keys().next();
      if (oldest.done !== true) lastReports.delete(oldest.value);
    }
  };

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
      const remembered = lastReports.get(providerThread.id);
      return remembered === undefined
        ? {
            providerThreadId: providerThread.id,
            instanceId: providerThread.providerInstanceId,
            driver: providerThread.driver,
            live: false,
            capturedAt: null,
            context: null,
            mcpServers: null,
          }
        : { ...remembered, live: false };
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
      remember(report);
      return report;
    }
    // A reopened session answers nothing until its first turn (Claude opens its
    // query then), so the last report stands in, still dated when it was read.
    const remembered = lastReports.get(providerThread.id);
    return remembered === undefined ? report : { ...remembered, live: true };
  });

  return SessionInsights.of({ get });
});

export const layer = Layer.effect(SessionInsights, make);
