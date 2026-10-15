import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import {
  type EnvironmentId,
  type RunId,
  type ScopedThreadRef,
  SessionInsightsError,
  type SessionRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { memo, type ReactNode, useMemo } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "../../lib/contextWindow";
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useServerConfigs } from "../../state/entities";
import { useSessionInsights, useThreadSessionSummary } from "../../state/sessionInsights";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { StartTruncatedPath } from "../StartTruncatedPath";
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
 * Session, Environment, Context, Connectors, and Outputs for a server thread
 * in the full thread details card. Mount it only while the card is open at
 * full density: mounting is what fetches the provider's session details.
 * Fork add-on.
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
      <ThreadSessionSummarySection
        threadRef={threadRef}
        contextWindow={props.contextWindow}
        record={insights?.session ?? null}
      />
      <ThreadEnvironmentSection
        threadRef={threadRef}
        host={insights?.host ?? null}
        // An agent with its own session store (Hermes) works in its own folders,
        // not the T3 project's.
        workspaceRoot={insights?.session === undefined ? props.workspaceRoot : undefined}
      />
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

/** Machine, folder, and branch the thread runs in. */
function ThreadEnvironmentSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly host: string | null;
  readonly workspaceRoot: string | undefined;
}) {
  const summary = useThreadSessionSummary(props.threadRef);
  if (summary === null) return null;
  return (
    <SessionEnvironmentSection
      host={props.host}
      folder={props.workspaceRoot ?? summary.worktreePath}
      branch={summary.branch}
    />
  );
}

function ThreadSessionSummarySection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly contextWindow: ContextWindowSnapshot | null;
  /** The agent's own record of the session, for agents that keep one (Hermes). */
  readonly record: SessionRecord | null;
}) {
  const { record } = props;
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
  // With no T3 session running, the agent's own record says whether it is active.
  const status =
    record?.status !== undefined &&
    (summary.sessionStatus === null || summary.sessionStatus === "stopped")
      ? RECORD_STATUS_PRESENTATION[record.status]
      : SESSION_STATUS_PRESENTATION[summary.sessionStatus ?? "none"];
  const runtimeMode = runtimeModeConfig[summary.runtimeMode];
  const RuntimeModeIcon = runtimeMode.icon;
  // Provider-reported totals for the whole session, when the provider sends them.
  const toolUses = record?.toolCallCount ?? props.contextWindow?.toolUses ?? null;
  const durationMs = props.contextWindow?.durationMs ?? null;
  const cost =
    record?.costUsd !== undefined
      ? `${record.costEstimated ? "~" : ""}${formatContextWindowCost({ amount: record.costUsd, currency: "USD" })}`
      : props.contextWindow?.cost
        ? formatContextWindowCost(props.contextWindow.cost)
        : null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-session-heading"
      title="Session"
      data-thread-session-summary
    >
      <SessionHeaderRow
        icon={
          driverKind === null ? null : (
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={providerName}
              accentColor={entry?.accentColor}
              acpRegistryAgentId={entry?.acpRegistryAgentId}
              acpRegistryIconUrl={entry?.acpRegistryIconUrl}
              iconClassName="size-4"
            />
          )
        }
        name={providerName}
        subtitle={[modelLabel, ...traits].join(" · ")}
        statusLabel={status.label}
        statusDotClassName={status.dotClassName}
      />
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
      {record?.source !== undefined ? (
        <ThreadDetailsStatRow label="Source">{record.source}</ThreadDetailsStatRow>
      ) : null}
      <ThreadDetailsStatRow label="Started">
        {formatRelativeTimeLabel(record?.startedAt ?? summary.startedAt)}
      </ThreadDetailsStatRow>
      <ThreadDetailsStatRow label={record?.lastActiveAt !== undefined ? "Last active" : "Updated"}>
        {formatRelativeTimeLabel(record?.lastActiveAt ?? summary.updatedAt)}
      </ThreadDetailsStatRow>
      {record?.endedAt !== undefined ? (
        <ThreadDetailsStatRow label="Ended">
          {formatRelativeTimeLabel(record.endedAt)}
          {record.endReason !== undefined ? ` · ${record.endReason}` : null}
        </ThreadDetailsStatRow>
      ) : null}
      <ThreadDetailsStatRow label="Turns">{summary.turnCount}</ThreadDetailsStatRow>
      {record?.messageCount !== undefined ? (
        <ThreadDetailsStatRow label="Messages">{record.messageCount}</ThreadDetailsStatRow>
      ) : null}
      {toolUses !== null ? (
        <ThreadDetailsStatRow label="Tool uses">{toolUses}</ThreadDetailsStatRow>
      ) : null}
      {durationMs !== null ? (
        <ThreadDetailsStatRow label="Duration">{formatDuration(durationMs)}</ThreadDetailsStatRow>
      ) : null}
      {record?.apiCallCount !== undefined ? (
        <ThreadDetailsStatRow label="API calls">{record.apiCallCount}</ThreadDetailsStatRow>
      ) : null}
      {record !== null ? <SessionRecordTokenRows record={record} /> : null}
      {cost !== null ? <ThreadDetailsStatRow label="Cost">{cost}</ThreadDetailsStatRow> : null}
      {summary.lastError !== null && summary.sessionStatus === "error" ? (
        <p className="px-2.5 pt-1 text-2xs text-pretty text-destructive">{summary.lastError}</p>
      ) : null}
    </ThreadDetailsSection>
  );
}

const RECORD_STATUS_PRESENTATION: Record<
  NonNullable<SessionRecord["status"]>,
  { readonly label: string; readonly dotClassName: string }
> = {
  active: { label: "Active", dotClassName: "bg-success" },
  ended: { label: "Ended", dotClassName: "bg-muted-foreground/45" },
};

/** Token totals the agent keeps for the whole session, measured by its provider. */
function SessionRecordTokenRows(props: { readonly record: SessionRecord }) {
  const { record } = props;
  const pair = (left: string, a: number | undefined, right: string, b: number | undefined) =>
    [
      a === undefined ? null : `${left} ${formatContextWindowTokens(a)}`,
      b === undefined ? null : `${right} ${formatContextWindowTokens(b)}`,
    ]
      .filter((part) => part !== null)
      .join(" · ");
  const tokens = pair("in", record.inputTokens, "out", record.outputTokens);
  const cache =
    record.cacheReadTokens || record.cacheWriteTokens
      ? pair("read", record.cacheReadTokens, "write", record.cacheWriteTokens)
      : "";
  return (
    <>
      {tokens !== "" ? <ThreadDetailsStatRow label="Tokens">{tokens}</ThreadDetailsStatRow> : null}
      {cache !== "" ? <ThreadDetailsStatRow label="Cache">{cache}</ThreadDetailsStatRow> : null}
      {record.reasoningTokens ? (
        <ThreadDetailsStatRow label="Reasoning">
          {formatContextWindowTokens(record.reasoningTokens)}
        </ThreadDetailsStatRow>
      ) : null}
    </>
  );
}

/**
 * The Session section's first row: the agent's icon and name, the model and
 * its traits, and the session's state. Shared with Other Agents sessions.
 */
export function SessionHeaderRow(props: {
  readonly icon: ReactNode;
  readonly name: string;
  readonly subtitle: string;
  readonly statusLabel: string;
  readonly statusDotClassName: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-2.5 py-1.5">
      {props.icon}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground/80">{props.name}</span>
        {props.subtitle !== "" ? (
          <p className="truncate text-2xs text-muted-foreground">{props.subtitle}</p>
        ) : null}
      </div>
      <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <ThreadDetailsStatusDot className={props.statusDotClassName} />
        {props.statusLabel}
      </span>
    </div>
  );
}

/** Where a session runs: the machine, its folder, and its git branch. */
export const SessionEnvironmentSection = memo(function SessionEnvironmentSection(props: {
  readonly host: string | null;
  readonly folder: string | null;
  readonly branch: string | null;
}) {
  if (props.host === null && props.folder === null && props.branch === null) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-environment-heading"
      title="Environment"
      data-thread-session-environment
    >
      {props.host !== null ? (
        <ThreadDetailsStatRow label="Machine">{props.host}</ThreadDetailsStatRow>
      ) : null}
      {props.folder !== null ? (
        <ThreadDetailsStatRow label="Folder">
          <StartTruncatedPath path={props.folder} className="block" />
        </ThreadDetailsStatRow>
      ) : null}
      {props.branch !== null ? (
        <ThreadDetailsStatRow label="Branch">{props.branch}</ThreadDetailsStatRow>
      ) : null}
    </ThreadDetailsSection>
  );
});
