/**
 * Fork add-on: session details. The live session's insights that
 * CodexAdapterV2 hooks in for the details card, read over the app-server
 * client. The pure conversions are in codexSessionInsights.ts.
 *
 * @module orchestration-v2/Adapters/codexInsightsHooks
 */
import type { OrchestrationV2ProviderThread, SessionMcpServer } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  sessionInsightText,
  sessionMcpServer,
} from "@t3tools/provider-core/server/sessionInsights";
import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import * as CodexSessionInsights from "./codexSessionInsights.ts";

type CodexMcpServerStatus = CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus;

function codexMcpServerStatus(server: CodexMcpServerStatus): SessionMcpServer["status"] {
  switch (server.runtimeStatus) {
    case "connected":
      return "connected";
    case "notStarted":
    case "starting":
      return "pending";
    case "authenticationRequired":
      return "needs-auth";
    case "failed":
    case "cancelled":
      return "failed";
    case "disabled":
      return "disabled";
    case null:
    case undefined:
      // Older app servers report no runtime status; infer it from what the
      // listing did include.
      if (server.authStatus === "notLoggedIn") return "needs-auth";
      if (sessionInsightText(server.toolsError) !== undefined) return "failed";
      return Object.keys(server.tools).length > 0 ? "connected" : "pending";
  }
}

function codexSessionMcpServer(server: CodexMcpServerStatus): SessionMcpServer | undefined {
  const toolsError = sessionInsightText(server.toolsError);
  return sessionMcpServer({
    name: server.name,
    status: codexMcpServerStatus(server),
    error: toolsError,
    version: server.serverInfo?.version,
    ...(toolsError === undefined ? { toolCount: Object.keys(server.tools).length } : {}),
  });
}

/** Pages a session's MCP server listing may span before the rest is dropped. */
const CODEX_MCP_SERVER_STATUS_MAX_PAGES = 10;

/** One app-server session's insights. */
export const makeSessionInsights = (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly ensureInitialized: Effect.Effect<void, unknown>;
  readonly getNativeThreadId: (
    providerThread: OrchestrationV2ProviderThread,
  ) => Effect.Effect<string, ProviderAdapter.ProviderAdapterProtocolError>;
  readonly cwd: string | null;
  /** The last `thread/tokenUsage/updated` report per native thread. */
  readonly tokenUsage: ReadonlyMap<string, CodexSessionInsights.CodexTokenUsage>;
  readonly mcpServersError: (cause: unknown) => ProviderAdapter.ProviderAdapterProtocolError;
}): ProviderAdapter.ProviderAdapterV2SessionInsights => {
  const { client, ensureInitialized, getNativeThreadId } = input;
  return {
    // Totals against the model window, with the session folder's skills.
    contextBreakdown: ({ providerThread }) =>
      Effect.gen(function* () {
        const threadId = yield* getNativeThreadId(providerThread);
        const cwd = input.cwd ?? undefined;
        const skills =
          cwd === undefined
            ? []
            : yield* ensureInitialized.pipe(
                Effect.andThen(client.request("skills/list", { cwds: [cwd] })),
                Effect.map((response) =>
                  CodexSessionInsights.codexSkillContributors(response, cwd),
                ),
                // Skills are an enrichment; the totals stand without them.
                Effect.orElseSucceed(() => []),
              );
        return CodexSessionInsights.codexContextBreakdown({
          tokenUsage: input.tokenUsage.get(threadId),
          providerThread,
          skills,
        });
      }),
    mcpServers: ({ providerThread }) =>
      Effect.gen(function* () {
        const threadId = yield* getNativeThreadId(providerThread);
        yield* ensureInitialized;
        const servers: Array<SessionMcpServer> = [];
        let cursor: string | undefined;
        for (let page = 0; page < CODEX_MCP_SERVER_STATUS_MAX_PAGES; page++) {
          const response = yield* client.request("mcpServerStatus/list", {
            threadId,
            detail: "toolsAndAuthOnly",
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const entry of response.data) {
            const server = codexSessionMcpServer(entry);
            if (server !== undefined) servers.push(server);
          }
          cursor = response.nextCursor ?? undefined;
          if (cursor === undefined) break;
        }
        // Installed connectors run behind Codex's apps runtime, so each enabled
        // one gets its own row; they are an enrichment.
        const apps = yield* client.request("app/installed", { threadId }).pipe(
          Effect.map((response) => response.apps),
          Effect.orElseSucceed(() => []),
        );
        for (const app of apps) {
          if (!app.enabled) continue;
          const server = sessionMcpServer({
            name: app.runtimeName ?? app.id,
            status: app.callable ? "connected" : "configured",
          });
          if (server !== undefined) servers.push(server);
        }
        return servers;
      }).pipe(Effect.mapError(input.mcpServersError)),
  };
};
