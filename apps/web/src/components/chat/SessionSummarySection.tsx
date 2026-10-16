import type { SessionRateLimit, SessionRecord } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import type { LucideIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { formatRelativeTimeLabel, formatRelativeTimeUntil } from "../../timestampFormat";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadDetailsStatRow, ThreadDetailsStatusDot } from "./ThreadDetailsStatRow";

/**
 * The Session and Environment sections every details card shares: T3 threads,
 * Other Agents sessions, and unopened Hermes sessions each build a view and
 * render the same rows. Fork add-on.
 */

export interface SessionSummaryView {
  readonly icon: ReactNode;
  readonly name: string;
  readonly model: string | null;
  readonly traits: ReadonlyArray<string>;
  readonly statusLabel: string;
  readonly statusDotClassName: string;
  /** Every fact the rows show, already labeled; a row appears only when its field is present. */
  readonly record: SessionRecord;
  /** Drawn beside the Permissions label, for T3's runtime modes. */
  readonly permissionsIcon?: LucideIcon | undefined;
  /** Shown as "Updated" when the record has no last-active time. */
  readonly updatedAt?: string | null | undefined;
  /** Already formatted; shown when the record has no cost. */
  readonly fallbackCost?: string | null | undefined;
  /** The session's last error, under the rows. */
  readonly error?: string | null | undefined;
}

export const SessionSummarySection = memo(function SessionSummarySection(props: {
  readonly view: SessionSummaryView;
  readonly separated?: boolean;
}) {
  const { view } = props;
  const { record } = view;
  // The relative times read the clock while rendering; without this tick a
  // memoized card keeps saying "just now" until its record changes.
  useNowMinute();
  const PermissionsIcon = view.permissionsIcon;
  const count = (value: number) => value.toLocaleString();
  const cost =
    record.costUsd !== undefined
      ? `${record.costEstimated ? "~" : ""}${formatContextWindowCost({ amount: record.costUsd, currency: "USD" })}`
      : (view.fallbackCost ?? null);

  return (
    <ThreadDetailsSection
      headingId="thread-details-session-heading"
      title="Session"
      separated={props.separated ?? true}
      data-thread-session-summary
    >
      <SessionHeaderRow
        icon={view.icon}
        name={view.name}
        subtitle={[view.model, ...view.traits].filter((part) => part !== null).join(" · ")}
        statusLabel={view.statusLabel}
        statusDotClassName={view.statusDotClassName}
      />
      {record.permissionMode !== undefined ? (
        <ThreadDetailsStatRow
          label={
            PermissionsIcon ? (
              <>
                <PermissionsIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">Permissions</span>
              </>
            ) : (
              "Permissions"
            )
          }
        >
          {record.permissionMode}
        </ThreadDetailsStatRow>
      ) : null}
      {record.sandbox !== undefined ? (
        <ThreadDetailsStatRow label="Sandbox">{record.sandbox}</ThreadDetailsStatRow>
      ) : null}
      {record.remoteControl !== undefined ? (
        <ThreadDetailsStatRow label="Remote control">
          {record.remoteControl ? "On" : "Off"}
        </ThreadDetailsStatRow>
      ) : null}
      {record.source !== undefined ? (
        <ThreadDetailsStatRow label="Source">{record.source}</ThreadDetailsStatRow>
      ) : null}
      {record.startedAt !== undefined ? (
        <ThreadDetailsStatRow label="Started">
          {formatRelativeTimeLabel(record.startedAt)}
        </ThreadDetailsStatRow>
      ) : null}
      {record.lastActiveAt !== undefined ? (
        <ThreadDetailsStatRow label="Last active">
          {formatRelativeTimeLabel(record.lastActiveAt)}
        </ThreadDetailsStatRow>
      ) : view.updatedAt ? (
        <ThreadDetailsStatRow label="Updated">
          {formatRelativeTimeLabel(view.updatedAt)}
        </ThreadDetailsStatRow>
      ) : null}
      {record.endedAt !== undefined ? (
        <ThreadDetailsStatRow label="Ended">
          {formatRelativeTimeLabel(record.endedAt)}
          {record.endReason !== undefined ? ` · ${record.endReason}` : null}
        </ThreadDetailsStatRow>
      ) : null}
      {record.version !== undefined ? (
        <ThreadDetailsStatRow label="Version">{record.version}</ThreadDetailsStatRow>
      ) : null}
      {record.turnCount !== undefined ? (
        <ThreadDetailsStatRow label="Turns">{count(record.turnCount)}</ThreadDetailsStatRow>
      ) : null}
      {record.messageCount !== undefined ? (
        <ThreadDetailsStatRow label="Messages">{count(record.messageCount)}</ThreadDetailsStatRow>
      ) : null}
      {record.stepCount !== undefined ? (
        <ThreadDetailsStatRow label="Steps">{count(record.stepCount)}</ThreadDetailsStatRow>
      ) : null}
      {record.toolCallCount !== undefined ? (
        <ThreadDetailsStatRow label="Tool uses">
          {count(record.toolCallCount)}
          {record.toolFailureCount ? ` · ${count(record.toolFailureCount)} failed` : null}
        </ThreadDetailsStatRow>
      ) : null}
      {record.apiCallCount !== undefined ? (
        <ThreadDetailsStatRow label="API calls">{count(record.apiCallCount)}</ThreadDetailsStatRow>
      ) : null}
      {record.durationMs !== undefined ? (
        <ThreadDetailsStatRow label="Duration">
          {formatDuration(record.durationMs)}
        </ThreadDetailsStatRow>
      ) : null}
      <SessionRecordTokenRows record={record} />
      {cost !== null ? <ThreadDetailsStatRow label="Cost">{cost}</ThreadDetailsStatRow> : null}
      {record.serviceTier !== undefined ? (
        <ThreadDetailsStatRow label="Speed">{record.serviceTier}</ThreadDetailsStatRow>
      ) : null}
      {record.rateLimits?.map((limit, index) => {
        const row = formatRateLimit(limit);
        return (
          <ThreadDetailsStatRow key={`${index}:${limit.name}`} label={row.label}>
            {row.value}
          </ThreadDetailsStatRow>
        );
      })}
      {view.error ? (
        <p className="px-2.5 pt-1 text-2xs text-pretty text-destructive">{view.error}</p>
      ) : null}
    </ThreadDetailsSection>
  );
});

/** "5-hour limit" / "37% · resets in 2h"; the reset drops once it has passed. */
function formatRateLimit(limit: SessionRateLimit): {
  readonly label: string;
  readonly value: string;
} {
  const label = /limit/i.test(limit.name) ? limit.name : `${limit.name} limit`;
  const percent = `${Math.round(limit.usedPercent)}%`;
  const until = limit.resetsAt === undefined ? null : formatRelativeTimeUntil(limit.resetsAt);
  const reset =
    until === null || until.value === "Expired"
      ? null
      : until.value === "Soon"
        ? "resets soon"
        : `resets in ${until.value}`;
  return { label, value: reset === null ? percent : `${percent} · ${reset}` };
}

/** Token totals for the whole session, measured by the provider. */
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

/** The Session section's first row: the agent, its model and traits, and the session's state. */
function SessionHeaderRow(props: {
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
