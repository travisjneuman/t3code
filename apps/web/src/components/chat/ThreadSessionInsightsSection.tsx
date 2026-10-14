import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import {
  type EnvironmentId,
  type RunId,
  type ScopedThreadRef,
  SessionInsightsError,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { memo, useMemo } from "react";

import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useServerConfigs } from "../../state/entities";
import { useSessionInsights, useThreadSessionSummary } from "../../state/sessionInsights";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { runtimeModeConfig } from "./runtimeModeConfig";
import { SESSION_STATUS_PRESENTATION } from "./sessionInsights.logic";
import { ThreadConnectorsSection } from "./ThreadConnectorsSection";
import { ThreadContextBreakdown } from "./ThreadContextBreakdown";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadDetailsStatRow, ThreadDetailsStatusDot } from "./ThreadDetailsStatRow";
import { ThreadOutputsSection } from "./ThreadOutputsSection";

/**
 * Session, Context, Connectors, and Outputs for a server thread in the full
 * thread details card. Mount it only while the card is open at full density:
 * mounting is what fetches the provider's session details. Fork add-on.
 */
export const ThreadSessionDetails = memo(function ThreadSessionDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | undefined;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly onCompactContext: (() => void) | undefined;
  readonly compactDisabled: boolean;
  readonly compactDisabledReason: string | null;
  readonly onOpenTurnDiff: ((runId: RunId, filePath?: string) => void) | undefined;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const insightsQuery = useSessionInsights(threadRef);
  // A thread that has not started a provider session has nothing to report
  // yet; that is a state, not an error.
  const notStarted =
    insightsQuery.failure instanceof SessionInsightsError &&
    insightsQuery.failure.reason === "no-provider-thread";
  const insights = notStarted ? null : insightsQuery.data;

  return (
    <div data-thread-session-details>
      <ThreadSessionSummarySection threadRef={threadRef} contextWindow={props.contextWindow} />
      <ThreadContextBreakdown
        insights={insights}
        error={notStarted ? null : insightsQuery.error}
        contextWindow={props.contextWindow}
        onCompactContext={props.onCompactContext}
        compactDisabled={props.compactDisabled}
        compactDisabledReason={props.compactDisabledReason}
      />
      {insights?.mcpServers ? <ThreadConnectorsSection servers={insights.mcpServers} /> : null}
      <ThreadOutputsSection
        threadRef={threadRef}
        workspaceRoot={props.workspaceRoot}
        onOpenTurnDiff={props.onOpenTurnDiff}
      />
    </div>
  );
});

function ThreadSessionSummarySection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly contextWindow: ContextWindowSnapshot | null;
}) {
  const summary = useThreadSessionSummary(props.threadRef);
  const providers = useServerConfigs().get(props.threadRef.environmentId)?.providers;
  if (summary === null) return null;

  const entry = providers
    ? getProviderInstanceEntry(providers, summary.providerInstanceId)
    : undefined;
  const driverKind = entry?.driverKind ?? summary.driver;
  const providerName =
    entry?.displayName ??
    (summary.driver === null
      ? summary.providerInstanceId
      : formatProviderDriverKindLabel(summary.driver));
  const modelLabel = resolveSubagentMetadata({
    model: summary.modelSelection.model,
    provider: entry?.snapshot,
  }).modelLabel;
  const traits = [
    formatModelSelectionEffort(
      summary.modelSelection,
      entry?.models ?? [],
      summary.reportedModelSelection,
    ),
    getModelSelectionBooleanOptionValue(summary.modelSelection, "fastMode") === true
      ? "Fast"
      : null,
  ].filter((trait) => trait !== null);
  const status = SESSION_STATUS_PRESENTATION[summary.sessionStatus ?? "none"];
  const runtimeMode = runtimeModeConfig[summary.runtimeMode];
  const RuntimeModeIcon = runtimeMode.icon;
  // Provider-reported totals for the whole session, when the provider sends them.
  const toolUses = props.contextWindow?.toolUses ?? null;
  const durationMs = props.contextWindow?.durationMs ?? null;
  const cost = props.contextWindow?.cost ?? null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-session-heading"
      title="Session"
      data-thread-session-summary
    >
      <div className="flex min-w-0 items-center gap-2.5 px-2.5 py-1.5">
        {driverKind === null ? null : (
          <ProviderInstanceIcon
            driverKind={driverKind}
            displayName={providerName}
            accentColor={entry?.accentColor}
            acpRegistryAgentId={entry?.acpRegistryAgentId}
            acpRegistryIconUrl={entry?.acpRegistryIconUrl}
            iconClassName="size-4"
          />
        )}
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground/80">
            {providerName}
          </span>
          <p className="truncate text-2xs text-muted-foreground">
            {[modelLabel, ...traits].join(" · ")}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <ThreadDetailsStatusDot className={status.dotClassName} />
          {status.label}
        </span>
      </div>
      <ThreadDetailsStatRow
        label={
          <>
            <RuntimeModeIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">Permissions</span>
          </>
        }
      >
        {runtimeMode.label}
      </ThreadDetailsStatRow>
      <ThreadDetailsStatRow label="Started">
        {formatRelativeTimeLabel(summary.startedAt)}
      </ThreadDetailsStatRow>
      <ThreadDetailsStatRow label="Updated">
        {formatRelativeTimeLabel(summary.updatedAt)}
      </ThreadDetailsStatRow>
      <ThreadDetailsStatRow label="Turns">{summary.turnCount}</ThreadDetailsStatRow>
      {toolUses !== null ? (
        <ThreadDetailsStatRow label="Tool uses">{toolUses}</ThreadDetailsStatRow>
      ) : null}
      {durationMs !== null ? (
        <ThreadDetailsStatRow label="Duration">{formatDuration(durationMs)}</ThreadDetailsStatRow>
      ) : null}
      {cost !== null ? (
        <ThreadDetailsStatRow label="Cost">{formatContextWindowCost(cost)}</ThreadDetailsStatRow>
      ) : null}
      {summary.lastError !== null && summary.sessionStatus === "error" ? (
        <p className="px-2.5 pt-1 text-2xs text-pretty text-destructive">{summary.lastError}</p>
      ) : null}
    </ThreadDetailsSection>
  );
}
