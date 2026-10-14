import type {
  McpServerStatus,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type SessionContextBreakdown,
  type SessionContextCategory,
  SessionContextCategoryKind,
  type SessionContextContributor,
  type SessionMcpServer,
} from "@t3tools/contracts";
import {
  sessionInsightText,
  sessionInsightTokens,
  sessionMcpServer,
} from "@t3tools/provider-core/server/sessionInsights";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const isCategoryKind = Schema.is(SessionContextCategoryKind);

/** CLIs that predate `kind` mark only deferred rows; everything else used the window. */
const categoryKind = (
  category: SDKControlGetContextUsageResponse["categories"][number],
): SessionContextCategoryKind => {
  if (isCategoryKind(category.kind)) return category.kind;
  return category.isDeferred === true ? "deferred" : "used";
};

const contributor = (
  name: string,
  source: string | undefined,
  tokens: number,
): SessionContextContributor | undefined => {
  const trimmedName = sessionInsightText(name);
  if (trimmedName === undefined) {
    return undefined;
  }
  const trimmedSource = sessionInsightText(source);
  return {
    name: trimmedName,
    ...(trimmedSource === undefined ? {} : { source: trimmedSource }),
    tokens: sessionInsightTokens(tokens),
  };
};

const contributors = <A>(
  rows: ReadonlyArray<A> | undefined,
  map: (row: A) => SessionContextContributor | undefined,
): ReadonlyArray<SessionContextContributor> =>
  (rows ?? []).flatMap((row) => {
    const mapped = map(row);
    return mapped === undefined ? [] : [mapped];
  });

/**
 * MCP tools are listed by their wire name, `mcp__<server>__<tool>`, where the
 * server part has the CLI's name normalization applied. The server is shown as
 * the source, so the prefix is dropped when it matches.
 */
const mcpToolName = (name: string, serverName: string): string => {
  const prefix = `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
};

/**
 * Skill rows name the plugin that ships them at runtime, a field the SDK's
 * types do not declare yet.
 */
const skillPluginName = (skill: object): string | undefined =>
  Predicate.hasProperty(skill, "pluginName") && typeof skill.pluginName === "string"
    ? skill.pluginName
    : undefined;

/**
 * Maps the CLI's `/context` report. `rawMaxTokens` is the window the CLI
 * measures usage against, which is the autocompact window when that is on.
 * Deferred MCP tools are already counted in their own category, so only the
 * loaded ones are listed as contributors.
 */
export const claudeContextBreakdown = (
  usage: SDKControlGetContextUsageResponse,
): SessionContextBreakdown => {
  const model = sessionInsightText(usage.model);
  const categories = usage.categories.flatMap((category): Array<SessionContextCategory> => {
    const name = sessionInsightText(category.name);
    return name === undefined
      ? []
      : [{ name, tokens: sessionInsightTokens(category.tokens), kind: categoryKind(category) }];
  });
  return {
    ...(model === undefined ? {} : { model }),
    totalTokens: sessionInsightTokens(usage.totalTokens),
    maxTokens: sessionInsightTokens(usage.rawMaxTokens),
    categories,
    mcpTools: contributors(usage.mcpTools, (tool) =>
      tool.isLoaded === false
        ? undefined
        : contributor(mcpToolName(tool.name, tool.serverName), tool.serverName, tool.tokens),
    ),
    memoryFiles: contributors(usage.memoryFiles, (file) =>
      contributor(file.path, file.type, file.tokens),
    ),
    agents: contributors(usage.agents, (agent) =>
      contributor(agent.agentType, agent.source, agent.tokens),
    ),
    skills: contributors(usage.skills?.skillFrontmatter, (skill) =>
      contributor(skill.name, skillPluginName(skill) ?? skill.source, skill.tokens),
    ),
  };
};

/** Claude's server statuses match the contract's one for one. */
export const claudeMcpServers = (
  servers: ReadonlyArray<McpServerStatus>,
): ReadonlyArray<SessionMcpServer> =>
  servers.flatMap((server) => {
    const mapped = sessionMcpServer({
      name: server.name,
      status: server.status,
      error: server.error,
      version: server.serverInfo?.version,
      toolCount: server.tools?.length,
    });
    return mapped === undefined ? [] : [mapped];
  });
