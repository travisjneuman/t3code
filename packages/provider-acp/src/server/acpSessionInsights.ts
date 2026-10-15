/**
 * Fork add-on: session details. The details card's insights for every agent
 * the shared ACP adapter runs (Grok, Antigravity and the ACP registry agents).
 * ACP has no context or MCP status request, so this reports what the adapter
 * already holds: the MCP servers T3 hands the session, the last
 * `usage_update` totals, and the commands from `available_commands_update`.
 * See docs/internals/session-insights.md.
 *
 * @module provider-acp/acpSessionInsights
 */
import type {
  OrchestrationV2ProviderThread,
  ThreadId,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  sessionConfiguredMcpServers,
  sessionNamedContributors,
  sessionUsageBreakdown,
} from "@t3tools/provider-core/server/sessionInsights";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/compat";

/**
 * One session's insights. `remember` keeps the names of the commands an agent
 * advertises per native session, never their descriptions or inputs.
 */
export const makeAcpSessionInsights = (
  /** The servers T3 passes the thread's session; read by name only. */
  readMcpContext: (threadId: ThreadId | null) => Effect.Effect<{
    readonly servers: ReadonlyArray<EffectAcpSchema.McpServer>;
    readonly acpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  }>,
  contextUsageBySessionId: Ref.Ref<Map<string, ThreadTokenUsageSnapshot>>,
): {
  readonly remember: (notification: EffectAcpSchema.SessionNotification) => void;
  readonly insights: ProviderAdapter.ProviderAdapterV2SessionInsights;
} => {
  const commandNames = new Map<string, ReadonlyArray<string>>();
  const nativeId = (providerThread: OrchestrationV2ProviderThread) =>
    providerThread.nativeThreadRef?.nativeId ?? undefined;

  const remember = (notification: EffectAcpSchema.SessionNotification) => {
    if (notification.update.sessionUpdate !== "available_commands_update") return;
    commandNames.set(
      notification.sessionId,
      notification.update.availableCommands.map((command) => command.name),
    );
  };

  const insights: ProviderAdapter.ProviderAdapterV2SessionInsights = {
    // Without real usage there is nothing to measure, so no breakdown.
    contextBreakdown: ({ providerThread }) =>
      Effect.gen(function* () {
        const sessionId = nativeId(providerThread);
        const usage =
          (sessionId === undefined
            ? undefined
            : (yield* Ref.get(contextUsageBySessionId)).get(sessionId)) ??
          providerThread.contextUsage;
        const commands = sessionId === undefined ? undefined : commandNames.get(sessionId);
        return sessionUsageBreakdown(usage, {
          skills: commands === undefined ? undefined : sessionNamedContributors(commands),
        });
      }),
    // The agent reports no connection state, so every server is `configured`.
    mcpServers: ({ providerThread }) =>
      readMcpContext(providerThread.appThreadId).pipe(
        Effect.map((context) =>
          sessionConfiguredMcpServers(
            [...context.servers, ...context.acpServers].map((server) => server.name),
          ),
        ),
      ),
  };

  return { remember, insights };
};
