/**
 * The details card for a Hermes session T3 has not opened as a thread: the
 * Session, Environment, Context, Connectors, and Outputs sections a thread's
 * card has, read from Hermes without importing the session. Opened from the
 * row's "Details" menu item. Fork add-on: Hermes provider.
 */
import type {
  EnvironmentId,
  HermesSessionSummary,
  ProviderInstanceId,
  SessionRecord,
} from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import {
  mergeSessionRecord,
  RECORD_STATUS_PRESENTATION,
  SESSION_STATUS_PRESENTATION,
  sessionRecordFrom,
} from "../components/chat/sessionInsights.logic";
import {
  SessionEnvironmentSection,
  SessionSummarySection,
  type SessionSummaryView,
} from "../components/chat/SessionSummarySection";
import { ThreadConnectorsSection } from "../components/chat/ThreadConnectorsSection";
import { ThreadContextBreakdown } from "../components/chat/ThreadContextBreakdown";
import { SessionOutputsList } from "../components/chat/ThreadOutputsSection";
import { Popover, PopoverPopup } from "../components/ui/popover";
import { ScrollArea } from "../components/ui/scroll-area";
import { labelSessionRecordSettings, shortModelLabel } from "../external-sessions/atoms";
import { HERMES_DRIVER, useHermesSessionInsights } from "./hermesSessions";

export interface HermesSessionDetailsTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly session: HermesSessionSummary;
  /** The instance's agent name. */
  readonly agentName: string;
  /** The sidebar row the card opens beside. */
  readonly anchor: Element;
}

/** Mounted only while open; closing unmounts it, which stops the read. */
export const HermesSessionDetailsCard = memo(function HermesSessionDetailsCard(props: {
  readonly target: HermesSessionDetailsTarget;
  readonly onClose: () => void;
}) {
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <PopoverPopup
        anchor={props.target.anchor}
        side="right"
        align="start"
        sideOffset={8}
        padding="none"
        width="md"
        aria-label={`${props.target.session.title} details`}
      >
        <div className="grid max-h-[min(36rem,calc(var(--available-height,100dvh)-1rem))] grid-rows-[minmax(0,1fr)] overflow-hidden">
          <ScrollArea scrollFade className="min-h-0">
            <HermesSessionDetailsContent target={props.target} />
          </ScrollArea>
        </div>
      </PopoverPopup>
    </Popover>
  );
});

function HermesSessionDetailsContent(props: { readonly target: HermesSessionDetailsTarget }) {
  const { target } = props;
  const query = useHermesSessionInsights(
    target.environmentId,
    target.instanceId,
    target.session.id,
  );
  const insights = query.data;
  const record = insights?.session;
  const view = useMemo(
    () => hermesSessionView(target.session, target.agentName, record),
    [target.session, target.agentName, record],
  );
  return (
    <div data-thread-session-details>
      <SessionSummarySection view={view} separated={false} />
      <SessionEnvironmentSection host={insights?.host ?? null} folder={null} branch={null} />
      <ThreadContextBreakdown
        insights={insights}
        error={query.error}
        contextWindow={null}
        onCompactContext={undefined}
        compactDisabled
        compactDisabledReason={null}
      />
      {insights?.mcpServers ? <ThreadConnectorsSection servers={insights.mcpServers} /> : null}
      {insights?.outputs && insights.outputs.length > 0 ? (
        <SessionOutputsList
          environmentId={target.environmentId}
          outputs={insights.outputs}
          cwd={undefined}
          note={null}
        />
      ) : null}
    </div>
  );
}

/** Hermes's record of the session wins; the sidebar's listing fills in until it arrives. */
function hermesSessionView(
  session: HermesSessionSummary,
  agentName: string,
  sessionRecord: SessionRecord | undefined,
): SessionSummaryView {
  const record = labelSessionRecordSettings(
    mergeSessionRecord(
      sessionRecord,
      sessionRecordFrom({
        model: session.model,
        source: session.source,
        lastActiveAt: new Date(session.lastActiveAt).toISOString(),
        messageCount: session.messageCount,
      }),
    ),
  );
  const status =
    record.status === undefined
      ? SESSION_STATUS_PRESENTATION.stopped
      : RECORD_STATUS_PRESENTATION[record.status];
  return {
    icon: (
      <ProviderInstanceIcon
        driverKind={HERMES_DRIVER}
        displayName={agentName}
        iconClassName="size-4"
      />
    ),
    name: agentName,
    model: shortModelLabel(record.model ?? null),
    traits: record.effort === undefined ? [] : [record.effort],
    statusLabel: status.label,
    statusDotClassName: status.dotClassName,
    record,
  };
}
