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
import { memo, useMemo } from "react";

import { labelSessionRecordSettings } from "../../external-sessions/atoms";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useServerConfigs } from "../../state/entities";
import { useSessionInsights, useThreadSessionSummary } from "../../state/sessionInsights";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { runtimeModeConfig } from "./runtimeModeConfig";
import {
  mergeSessionRecord,
  RECORD_STATUS_PRESENTATION,
  SESSION_STATUS_PRESENTATION,
  sessionRecordFrom,
} from "./sessionInsights.logic";
import {
  SessionEnvironmentSection,
  SessionSummarySection,
  type SessionSummaryView,
} from "./SessionSummarySection";
import { ThreadConnectorsSection } from "./ThreadConnectorsSection";
import { ThreadContextBreakdown } from "./ThreadContextBreakdown";
import { SessionOutputsList, ThreadOutputsSection } from "./ThreadOutputsSection";

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
  // An agent with its own session store (Hermes) works in its own folders,
  // not the T3 project's.
  const ownsWorkspace = insights?.session !== undefined;
  const sessionFolder = ownsWorkspace ? undefined : props.workspaceRoot;

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
        workspaceRoot={sessionFolder}
        ownsWorkspace={ownsWorkspace}
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
      {insights?.outputs && insights.outputs.length > 0 ? (
        // Edits the agent made outside T3's turns, which have no turn diff.
        <SessionOutputsList
          environmentId={props.environmentId}
          outputs={insights.outputs}
          cwd={sessionFolder}
          note={null}
        />
      ) : (
        <ThreadOutputsSection
          threadRef={threadRef}
          workspaceRoot={props.workspaceRoot}
          onOpenTurnDiff={props.onOpenTurnDiff}
        />
      )}
    </div>
  );
});

/** Machine, folder, and branch the thread runs in. */
function ThreadEnvironmentSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly host: string | null;
  readonly workspaceRoot: string | undefined;
  /** The agent works in its own folders, so T3's checkout would mislabel it. */
  readonly ownsWorkspace: boolean;
}) {
  const summary = useThreadSessionSummary(props.threadRef);
  if (summary === null) return null;
  return (
    <SessionEnvironmentSection
      host={props.host}
      folder={props.ownsWorkspace ? null : (props.workspaceRoot ?? summary.worktreePath)}
      branch={props.ownsWorkspace ? null : summary.branch}
    />
  );
}

function ThreadSessionSummarySection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly contextWindow: ContextWindowSnapshot | null;
  /** The provider's own record of the session, when it reports one. */
  readonly record: SessionRecord | null;
}) {
  const { record, contextWindow } = props;
  const summary = useThreadSessionSummary(props.threadRef);
  const providers = useServerConfigs().get(props.threadRef.environmentId)?.providers;
  const view = useMemo((): SessionSummaryView | null => {
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
    // With no T3 session running, the provider's own record says whether it is active.
    const status =
      record?.status !== undefined &&
      (summary.sessionStatus === null || summary.sessionStatus === "stopped")
        ? RECORD_STATUS_PRESENTATION[record.status]
        : SESSION_STATUS_PRESENTATION[summary.sessionStatus ?? "none"];
    const runtimeMode = runtimeModeConfig[summary.runtimeMode];
    // The provider's record wins; T3's own readings fill in what it leaves out.
    const facts = mergeSessionRecord(
      record === null ? null : labelSessionRecordSettings(record),
      sessionRecordFrom({
        startedAt: summary.startedAt,
        version: entry?.snapshot.version,
        toolCallCount: contextWindow?.toolUses,
        durationMs: contextWindow?.durationMs,
      }),
    );
    return {
      icon:
        driverKind === null ? null : (
          <ProviderInstanceIcon
            driverKind={driverKind}
            displayName={providerName}
            accentColor={entry?.accentColor}
            acpRegistryAgentId={entry?.acpRegistryAgentId}
            acpRegistryIconUrl={entry?.acpRegistryIconUrl}
            iconClassName="size-4"
          />
        ),
      name: providerName,
      model: resolveSubagentMetadata({
        model: summary.modelSelection.model,
        provider: entry?.snapshot,
      }).modelLabel,
      traits,
      statusLabel: status.label,
      statusDotClassName: status.dotClassName,
      // T3 runs the thread, so its runtime mode and run count are the thread's own.
      record: { ...facts, permissionMode: runtimeMode.label, turnCount: summary.turnCount },
      permissionsIcon: runtimeMode.icon,
      updatedAt: summary.updatedAt,
      fallbackCost: contextWindow?.cost ? formatContextWindowCost(contextWindow.cost) : null,
      error: summary.sessionStatus === "error" ? summary.lastError : null,
    };
  }, [summary, providers, record, contextWindow]);
  if (view === null) return null;
  return <SessionSummarySection view={view} />;
}
