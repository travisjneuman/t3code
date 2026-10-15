import type {
  SessionContextBreakdown,
  SessionContextContributor,
  SessionMcpServer,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

/**
 * Normalizers adapters use when mapping a provider's own session report into
 * the session insights contract, whose names must be non-blank and trimmed
 * and whose token counts must be non-negative integers.
 */

/** The trimmed text, or undefined when the provider sent nothing usable. */
export const sessionInsightText = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/** Token counts arrive as estimates; negative or non-finite values count as zero. */
export const sessionInsightTokens = (value: number | null | undefined): number =>
  value === null || value === undefined || !Number.isFinite(value)
    ? 0
    : Math.max(0, Math.round(value));

/**
 * Builds one server row, or undefined when the provider gave it no name.
 * Optional fields are left off rather than set to undefined.
 */
export const sessionMcpServer = (input: {
  readonly name: string;
  readonly status: SessionMcpServer["status"];
  readonly error?: string | null | undefined;
  readonly version?: string | null | undefined;
  readonly toolCount?: number | undefined;
}): SessionMcpServer | undefined => {
  const name = sessionInsightText(input.name);
  if (name === undefined) {
    return undefined;
  }
  const error = sessionInsightText(input.error);
  const version = sessionInsightText(input.version);
  return {
    name,
    status: input.status,
    ...(error === undefined ? {} : { error }),
    ...(version === undefined ? {} : { version }),
    ...(input.toolCount === undefined ? {} : { toolCount: sessionInsightTokens(input.toolCount) }),
  };
};

/**
 * A breakdown for providers that report only totals: what the context holds
 * and the window it fills. It has no categories but Free space, so the card
 * shows the totals and never categories made up to fill the bar. Null when the
 * window is unknown, since a breakdown without one has nothing to measure.
 */
export const sessionTotalsBreakdown = (input: {
  readonly usedTokens: number | null | undefined;
  readonly maxTokens: number | null | undefined;
  readonly model?: string | null | undefined;
  readonly skills?: ReadonlyArray<SessionContextContributor> | undefined;
  readonly autoCompactEnabled?: boolean | undefined;
  readonly autoCompactThreshold?: number | null | undefined;
}): SessionContextBreakdown | null => {
  const maxTokens = sessionInsightTokens(input.maxTokens);
  if (maxTokens === 0) {
    return null;
  }
  const totalTokens = sessionInsightTokens(input.usedTokens);
  const free = Math.max(0, maxTokens - totalTokens);
  const model = sessionInsightText(input.model);
  const autoCompactThreshold = sessionInsightTokens(input.autoCompactThreshold);
  return {
    ...(model === undefined ? {} : { model }),
    totalTokens,
    maxTokens,
    categories: free === 0 ? [] : [{ name: "Free space", tokens: free, kind: "free" }],
    mcpTools: [],
    memoryFiles: [],
    agents: [],
    skills: input.skills ?? [],
    ...(input.autoCompactEnabled === undefined
      ? {}
      : { autoCompactEnabled: input.autoCompactEnabled }),
    ...(autoCompactThreshold === 0 ? {} : { autoCompactThreshold }),
  };
};

/**
 * The totals-only breakdown from the usage snapshot an adapter already keeps
 * for the thread, or null when it has none or it carries no window.
 */
export const sessionUsageBreakdown = (
  usage: ThreadTokenUsageSnapshot | null | undefined,
  extra: {
    readonly model?: string | null | undefined;
    readonly skills?: ReadonlyArray<SessionContextContributor> | undefined;
  } = {},
): SessionContextBreakdown | null =>
  usage === null || usage === undefined
    ? null
    : sessionTotalsBreakdown({
        usedTokens: usage.usedTokens,
        maxTokens: usage.maxTokens,
        model: extra.model,
        skills: extra.skills,
        autoCompactEnabled: usage.compactsAutomatically,
        autoCompactThreshold: usage.autoCompactThreshold,
      });

/** Contributor rows naming each entry without a size, such as a provider's skill list. */
export const sessionNamedContributors = (
  names: Iterable<string | null | undefined>,
): ReadonlyArray<SessionContextContributor> => {
  const seen = new Set<string>();
  const rows: Array<SessionContextContributor> = [];
  for (const raw of names) {
    const name = sessionInsightText(raw);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    rows.push({ name });
  }
  return rows;
};

/** Servers T3 hands the agent's session itself, by name only: no command, URL or environment. */
export const sessionConfiguredMcpServers = (
  names: Iterable<string | null | undefined>,
): ReadonlyArray<SessionMcpServer> =>
  sessionNamedContributors(names).flatMap((row) => {
    const server = sessionMcpServer({ name: row.name, status: "configured" });
    return server === undefined ? [] : [server];
  });
