/**
 * Fork add-on: session details. What ClaudeAdapterV2 hooks in for the details
 * card: the context usage request the query runner exposes and the live
 * session's insights. The SDK responses are converted in claudeSessionInsights.ts.
 *
 * @module orchestration-v2/Adapters/claudeInsightsHooks
 */
import type {
  Query as ClaudeQuery,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2ProviderThread, ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAgentSdkQuerySession,
} from "./ClaudeAdapterV2.ts";
import { claudeContextBreakdown, claudeMcpServers } from "./claudeSessionInsights.ts";

/**
 * The /context breakdown of the live session. Optional on the query session so
 * test fakes can omit it.
 */
export type ContextUsageRequest = Effect.Effect<
  SDKControlGetContextUsageResponse,
  ClaudeAgentSdkQueryRunnerError
>;

export type ProtocolLogEvent = {
  readonly direction: "outgoing";
  readonly stage: "decoded";
  readonly payload: {
    readonly type: "query.get_context_usage";
    readonly detail: "summary";
  };
};

/** The query runner's insight requests against one SDK query. */
export const queryRequests = (
  queryRuntime: Pick<ClaudeQuery, "getContextUsage">,
  queryRunnerError: (cause: unknown, method: string) => ClaudeAgentSdkQueryRunnerError,
  logProtocolEvent: (event: ProtocolLogEvent) => Effect.Effect<void>,
): {
  readonly getContextUsage: ContextUsageRequest;
} => ({
  getContextUsage: Effect.tryPromise({
    try: () => queryRuntime.getContextUsage({ detail: "summary" }),
    catch: (cause) => queryRunnerError(cause, "getContextUsage"),
  }).pipe(
    Effect.tap(() =>
      logProtocolEvent({
        direction: "outgoing",
        stage: "decoded",
        payload: { type: "query.get_context_usage", detail: "summary" },
      }),
    ),
  ),
});

interface LiveQuery {
  readonly nativeThreadId: string;
  readonly query: ClaudeAgentSdkQuerySession;
  readonly stopping: boolean;
}

/** One session's insights, read from the query `queryContext` holds when asked. */
export const makeSessionInsights = <Q extends LiveQuery>(
  driver: ProviderDriverKind,
  queryContext: Ref.Ref<Q | null>,
): ProviderAdapter.ProviderAdapterV2SessionInsights => {
  // Session insights read only the query running this provider thread. Without
  // one (a reopened session before its first turn, or a stopped or replaced
  // query) there is nothing current to report, which is not a failure:
  // SessionInsights then shows the last stored report.
  const liveInsightsQuery = (providerThread: OrchestrationV2ProviderThread) =>
    Ref.get(queryContext).pipe(
      Effect.map((liveQuery: LiveQuery | null) =>
        liveQuery === null ||
        liveQuery.stopping ||
        liveQuery.nativeThreadId !== providerThread.nativeThreadRef?.nativeId
          ? null
          : liveQuery.query,
      ),
    );
  const insightsRequestError = (detail: string) => (cause: ClaudeAgentSdkQueryRunnerError) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail,
      cause,
    });

  return {
    contextBreakdown: ({ providerThread }) =>
      Effect.gen(function* () {
        const liveQuery = yield* liveInsightsQuery(providerThread);
        if (liveQuery === null || liveQuery.getContextUsage === undefined) {
          return null;
        }
        const usage = yield* liveQuery.getContextUsage.pipe(
          Effect.mapError(insightsRequestError("Context usage request failed")),
        );
        return claudeContextBreakdown(usage);
      }),
    mcpServers: ({ providerThread }) =>
      Effect.gen(function* () {
        const liveQuery = yield* liveInsightsQuery(providerThread);
        if (liveQuery === null) {
          return null;
        }
        const servers = yield* liveQuery.mcpServerStatus.pipe(
          Effect.mapError(insightsRequestError("MCP server status request failed")),
        );
        return claudeMcpServers(servers);
      }),
  };
};
