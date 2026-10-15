import type { EnvironmentId, ExternalSessionSummary, SessionRecord } from "@t3tools/contracts";
import { memo, type RefObject, useMemo } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import {
  mergeSessionRecord,
  RECORD_STATUS_PRESENTATION,
  sessionRecordFrom,
} from "../components/chat/sessionInsights.logic";
import {
  SessionEnvironmentSection,
  SessionSummarySection,
  type SessionSummaryView,
} from "../components/chat/SessionSummarySection";
import { ThreadConnectorsSection } from "../components/chat/ThreadConnectorsSection";
import { ThreadContextBreakdown } from "../components/chat/ThreadContextBreakdown";
import { ThreadDetailsCard } from "../components/chat/ThreadDetailsCard";
import { SessionOutputsList } from "../components/chat/ThreadOutputsSection";
import type { ContextWindowSnapshot } from "../lib/contextWindow";
import {
  externalSessionOriginLabel,
  labelSessionRecordSettings,
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
  const record = insights?.session;
  const sessionView = useMemo(() => externalSessionView(summary, record), [summary, record]);
  const contextWindow = useMemo(() => contextSnapshot(summary), [summary]);
  const context = insights?.context ?? null;
  const contextReading = useMemo(
    () =>
      context === null
        ? null
        : // Read with the summary, so a running session's breakdown is current.
          { context, live: summary.liveness === "running", capturedAt: summary.updatedAt },
    [context, summary.liveness, summary.updatedAt],
  );
  return (
    // Excluded from the card's density measurement, like a thread's session details.
    <div data-thread-session-details>
      <SessionSummarySection view={sessionView} separated={false} />
      <SessionEnvironmentSection
        host={insights?.host ?? null}
        folder={summary.cwd}
        branch={details?.gitBranches?.[0] ?? null}
      />
      <ThreadContextBreakdown
        insights={contextReading}
        error={null}
        contextWindow={contextWindow}
        onCompactContext={undefined}
        compactDisabled
        compactDisabledReason={null}
      />
      {insights?.mcpServers ? <ThreadConnectorsSection servers={insights.mcpServers} /> : null}
      {insights?.outputs ? (
        <SessionOutputsList
          environmentId={props.environmentId}
          outputs={insights.outputs}
          cwd={cwd}
          note={insights.truncated ? TRUNCATED_OUTPUTS_NOTE : null}
        />
      ) : null}
    </div>
  );
}

/** The Session section's view: the agent's record wins, the scan's details fill in. */
function externalSessionView(
  summary: ExternalSessionSummary,
  sessionRecord: SessionRecord | undefined,
): SessionSummaryView {
  const details = summary.details;
  const record = labelSessionRecordSettings(
    mergeSessionRecord(
      sessionRecord,
      sessionRecordFrom({
        model: summary.model,
        effort: details?.effort,
        permissionMode: details?.approval,
        sandbox: details?.sandbox,
        startedAt: details?.createdAt,
        lastActiveAt: summary.updatedAt,
        version: details?.version,
        messageCount: details?.messageCount,
        stepCount: details?.stepCount,
      }),
    ),
  );
  // A running session reads as running; otherwise the agent's own status says more.
  const status =
    summary.liveness !== "running" && record.status !== undefined
      ? RECORD_STATUS_PRESENTATION[record.status]
      : {
          label: LIVENESS_LABEL[summary.liveness],
          dotClassName: LIVENESS_DOT_CLASS[summary.liveness],
        };
  const origin = externalSessionOriginLabel(summary);
  return {
    icon: (
      <ProviderInstanceIcon
        driverKind={summary.driver}
        displayName={origin}
        iconClassName="size-4"
      />
    ),
    name: origin,
    model: shortModelLabel(record.model ?? null),
    traits: record.effort === undefined ? [] : [record.effort],
    statusLabel: status.label,
    statusDotClassName: status.dotClassName,
    record,
  };
}
