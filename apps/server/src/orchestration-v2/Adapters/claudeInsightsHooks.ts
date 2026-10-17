/**
 * Fork add-on: session details. What ClaudeAdapterV2 hooks in for the details
 * card: the two SDK control requests the query runner exposes and the live
 * session's insights. The SDK responses are converted in claudeSessionInsights.ts.
 *
 * @module orchestration-v2/Adapters/claudeInsightsHooks
 */
import type {
  McpServerStatus,
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

/**
 * The live session's MCP servers. Optional on the query session so test fakes
 * can omit it.
 */
export type McpServerStatusRequest = Effect.Effect<
  ReadonlyArray<McpServerStatus>,
  ClaudeAgentSdkQueryRunnerError
>;

export type ProtocolLogEvent =
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.get_context_usage";
        readonly detail: "summary";
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.mcp_server_status";
        readonly count: number;
      };
    };

/** The query runner's insight requests against one SDK query. */
export const queryRequests = (
  queryRuntime: Pick<ClaudeQuery, "getContextUsage" | "mcpServerStatus">,
  queryRunnerError: (cause: unknown, method: string) => ClaudeAgentSdkQueryRunnerError,
  logProtocolEvent: (event: ProtocolLogEvent) => Effect.Effect<void>,
): {
  readonly getContextUsage: ContextUsageRequest;
  readonly mcpServerStatus: McpServerStatusRequest;
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
  // The status rows carry each server's config, headers included, so only the
  // count is logged.
  mcpServerStatus: Effect.tryPromise({
    try: () => queryRuntime.mcpServerStatus(),
    catch: (cause) => queryRunnerError(cause, "mcpServerStatus"),
  }).pipe(
    Effect.tap((servers) =>
      logProtocolEvent({
        direction: "outgoing",
        stage: "decoded",
        payload: { type: "query.mcp_server_status", count: servers.length },
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
        if (liveQuery.mcpServerStatus === undefined) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver,
            detail: "Claude query does not report MCP server status",
          });
        }
        const servers = yield* liveQuery.mcpServerStatus.pipe(
          Effect.mapError(insightsRequestError("MCP server status request failed")),
        );
        return claudeMcpServers(servers);
      }),
  };
};
