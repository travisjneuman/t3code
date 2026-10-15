/**
 * Fork add-on: session details. Codex reports context totals, not categories:
 * `thread/tokenUsage/updated` carries the last request's tokens and the model
 * window, and `skills/list` names the skills offered to the session.
 */
import type { OrchestrationV2ProviderThread, SessionContextContributor } from "@t3tools/contracts";
import {
  sessionInsightText,
  sessionTotalsBreakdown,
  sessionUsageBreakdown,
} from "@t3tools/provider-core/server/sessionInsights";
import type * as CodexSchema from "effect-codex-app-server/schema";

export type CodexTokenUsage = CodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"];

/** The enabled skills for the session's folder, by name with their scope as the source. */
export const codexSkillContributors = (
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<SessionContextContributor> => {
  const entry = response.data.find((candidate) => candidate.cwd === cwd);
  const skills = entry === undefined ? response.data.flatMap((each) => each.skills) : entry.skills;
  const seen = new Set<string>();
  return skills.flatMap((skill): Array<SessionContextContributor> => {
    const name = sessionInsightText(skill.name);
    if (!skill.enabled || name === undefined || seen.has(name)) return [];
    seen.add(name);
    const source = sessionInsightText(skill.scope);
    return [{ name, ...(source === undefined ? {} : { source }) }];
  });
};

/**
 * Totals against the model window: the session's last token report when this
 * process saw one, otherwise the usage the projection kept for the thread.
 * Null when neither knows the window.
 */
export const codexContextBreakdown = (input: {
  readonly tokenUsage: CodexTokenUsage | undefined;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly skills: ReadonlyArray<SessionContextContributor>;
}) =>
  input.tokenUsage?.modelContextWindow == null
    ? sessionUsageBreakdown(input.providerThread.contextUsage, { skills: input.skills })
    : sessionTotalsBreakdown({
        usedTokens: input.tokenUsage.last.totalTokens,
        maxTokens: input.tokenUsage.modelContextWindow,
        skills: input.skills,
      });
