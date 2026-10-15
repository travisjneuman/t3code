import type { EnvironmentId, ExternalSessionSummary } from "@t3tools/contracts";
import { memo, type RefObject } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { ThreadContextBreakdown } from "../components/chat/ThreadContextBreakdown";
import { ThreadDetailsCard } from "../components/chat/ThreadDetailsCard";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { ThreadDetailsStatRow } from "../components/chat/ThreadDetailsStatRow";
import { ThreadOutputsList } from "../components/chat/ThreadOutputsSection";
import {
  SessionEnvironmentSection,
  SessionHeaderRow,
} from "../components/chat/ThreadSessionInsightsSection";
import type { ContextWindowSnapshot } from "../lib/contextWindow";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  externalSessionOriginLabel,
  externalSessionSettingLabel,
  LIVENESS_LABEL,
  shortModelLabel,
  useExternalSessionInsights,
} from "./atoms";
import {
  EXTERNAL_SESSIONS_PANEL_REF,
  type ExternalSessionDetailsCardState,
} from "./ExternalSessionPanel";

/**
 * The thread details card for an Other Agents session: the same card, toggle,
 * and sections a T3 thread has, filled from the agent's own store. Fork
 * add-on; see docs/internals/session-insights.md.
 */

const LIVENESS_DOT_CLASS = {
  running: "bg-info",
  idle: "bg-success",
  recent: "bg-muted-foreground/45",
} as const satisfies Record<ExternalSessionSummary["liveness"], string>;

const TRUNCATED_OUTPUTS_NOTE = "Changes from earlier in this session were not read.";

/** The session's latest context reading, in the thread card's usage shape. */
function contextSnapshot(summary: ExternalSessionSummary): ContextWindowSnapshot | null {
  const details = summary.details;
  if (details?.contextTokens === undefined) return null;
  const usedTokens = details.contextTokens;
  const maxTokens =
    details.contextWindow !== undefined && details.contextWindow > 0 ? details.contextWindow : null;
  const usedPercentage = maxTokens === null ? null : (usedTokens / maxTokens) * 100;
  return {
    usedTokens,
    maxTokens,
    totalProcessedTokens: details.totalTokens ?? null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: null,
    autoCompactThreshold: null,
    cost: null,
    remainingTokens: maxTokens === null ? null : Math.max(0, maxTokens - usedTokens),
    usedPercentage,
    remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
    updatedAt: summary.updatedAt,
  };
}

export const ExternalSessionDetailsCard = memo(function ExternalSessionDetailsCard(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionKey: string;
  readonly summary: ExternalSessionSummary;
  readonly anchor: RefObject<Element | null>;
  readonly card: ExternalSessionDetailsCardState;
}) {
  return (
    <ThreadDetailsCard
      threadRef={EXTERNAL_SESSIONS_PANEL_REF}
      anchor={props.anchor}
      handle={props.card.handle}
      onPresentationChange={props.card.onPresentationChange}
    >
      {() => (
        <ExternalSessionDetailsContent
          environmentId={props.environmentId}
          sessionKey={props.sessionKey}
          summary={props.summary}
        />
      )}
    </ThreadDetailsCard>
  );
});

/** Rendered only while the card is open, which is what reads the insights. */
function ExternalSessionDetailsContent(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionKey: string;
  readonly summary: ExternalSessionSummary;
}) {
  const { summary } = props;
  const insights = useExternalSessionInsights(props.environmentId, props.sessionKey).data;
  const details = summary.details;
  const cwd = summary.cwd ?? undefined;
  return (
    // Excluded from the card's density measurement, like a thread's session details.
    <div data-thread-session-details>
      <ExternalSessionSummarySection summary={summary} />
      <SessionEnvironmentSection
        host={insights?.host ?? null}
        folder={summary.cwd}
        branch={details?.gitBranches?.[0] ?? null}
      />
      <ThreadContextBreakdown
        insights={null}
        error={null}
        contextWindow={contextSnapshot(summary)}
        onCompactContext={undefined}
        compactDisabled
        compactDisabledReason={null}
      />
      {insights?.outputs ? (
        <ThreadOutputsList
          outputs={insights.outputs}
          workspaceRoot={cwd}
          onOpenTurnDiff={undefined}
          note={insights.truncated ? TRUNCATED_OUTPUTS_NOTE : null}
        />
      ) : null}
    </div>
  );
}

function ExternalSessionSummarySection(props: { readonly summary: ExternalSessionSummary }) {
  const { summary } = props;
  const details = summary.details;
  const setting = (value: string | undefined) =>
    value === undefined ? null : externalSessionSettingLabel(value);
  const effort = setting(details?.effort);
  const approval = setting(details?.approval);
  const sandbox = setting(details?.sandbox);
  const origin = externalSessionOriginLabel(summary);
  const model = shortModelLabel(summary.model);
  return (
    <ThreadDetailsSection
      headingId="thread-details-session-heading"
      title="Session"
      separated={false}
      data-thread-session-summary
    >
      <SessionHeaderRow
        icon={
          <ProviderInstanceIcon
            driverKind={summary.driver}
            displayName={origin}
            iconClassName="size-4"
          />
        }
        name={origin}
        subtitle={[model, effort].filter((part) => part !== null).join(" · ")}
        statusLabel={LIVENESS_LABEL[summary.liveness]}
        statusDotClassName={LIVENESS_DOT_CLASS[summary.liveness]}
      />
      {approval !== null ? (
        <ThreadDetailsStatRow label="Permissions">{approval}</ThreadDetailsStatRow>
      ) : null}
      {sandbox !== null ? (
        <ThreadDetailsStatRow label="Sandbox">{sandbox}</ThreadDetailsStatRow>
      ) : null}
      {details?.createdAt !== undefined ? (
        <ThreadDetailsStatRow label="Started">
          {formatRelativeTimeLabel(details.createdAt)}
        </ThreadDetailsStatRow>
      ) : null}
      <ThreadDetailsStatRow label="Last active">
        {formatRelativeTimeLabel(summary.updatedAt)}
      </ThreadDetailsStatRow>
      {details?.messageCount !== undefined ? (
        <ThreadDetailsStatRow label="Messages">
          {details.messageCount.toLocaleString()}
        </ThreadDetailsStatRow>
      ) : null}
      {details?.stepCount !== undefined ? (
        <ThreadDetailsStatRow label="Steps">
          {details.stepCount.toLocaleString()}
        </ThreadDetailsStatRow>
      ) : null}
      {details?.version !== undefined ? (
        <ThreadDetailsStatRow label="Version">{details.version}</ThreadDetailsStatRow>
      ) : null}
    </ThreadDetailsSection>
  );
}
