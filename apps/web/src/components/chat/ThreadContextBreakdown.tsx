import type { SessionContextBreakdown } from "@t3tools/contracts";
import { Minimize2Icon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import {
  compareByTokensThenName,
  type ContextBreakdownView,
  deriveContextBreakdownView,
  formatContextPercent,
  groupContributorsBySource,
  tokensUntilAutoCompact,
} from "./sessionInsights.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadDetailsStatRow, ThreadDetailsStatusDot } from "./ThreadDetailsStatRow";

/**
 * The context window: the provider's per-category breakdown when it reports
 * one, else the token totals from the thread's usage reports. Fork add-on.
 */
export const ThreadContextBreakdown = memo(function ThreadContextBreakdown(props: {
  /** A thread's session insights, or any reading with the same parts. */
  readonly insights: {
    readonly context?: SessionContextBreakdown | null | undefined;
    /** The numbers are current; otherwise `capturedAt` dates them. */
    readonly live?: boolean | undefined;
    readonly capturedAt?: string | null | undefined;
  } | null;
  readonly error: string | null;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly onCompactContext: (() => void) | undefined;
  readonly compactDisabled: boolean;
  readonly compactDisabledReason: string | null;
}) {
  const { insights, contextWindow } = props;
  const context = insights?.context ?? null;
  const view = useMemo(
    () => (context === null ? null : deriveContextBreakdownView(context)),
    [context],
  );
  if (context === null && contextWindow === null && props.error === null) return null;

  // Counted by the app from stored text rather than reported by the provider.
  const estimated = context?.estimated === true;
  const approx = estimated ? "~" : "";
  const usedTokens = context?.totalTokens ?? contextWindow?.usedTokens ?? null;
  const maxTokens = context ? context.maxTokens || null : (contextWindow?.maxTokens ?? null);
  const usedPercent = view ? view.usedPercent : (contextWindow?.usedPercentage ?? null);
  const usedPercentLabel = formatContextPercent(usedPercent);
  // Live usage reports carry no threshold, so the breakdown's fills in; either
  // source saying the agent does not compact on its own wins.
  const autoCompactThreshold =
    contextWindow?.autoCompactThreshold ?? context?.autoCompactThreshold ?? null;
  const untilAutoCompact =
    contextWindow?.compactsAutomatically === false || context?.autoCompactEnabled === false
      ? null
      : tokensUntilAutoCompact(autoCompactThreshold, usedTokens);
  const autoCompactsSoon =
    untilAutoCompact !== null &&
    autoCompactThreshold !== null &&
    untilAutoCompact < autoCompactThreshold * 0.1;
  const compactionCount = context?.compactionCount ?? 0;
  // A live session reports the current window; anything else is a snapshot,
  // dated by whichever source the numbers above came from.
  const asOf =
    insights?.live === true
      ? null
      : context !== null
        ? (insights?.capturedAt ?? null)
        : (contextWindow?.updatedAt ?? null);

  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context"
      actions={
        estimated ? (
          <span className="text-2xs text-muted-foreground" title={context?.note}>
            Estimated
          </span>
        ) : undefined
      }
      data-thread-context-breakdown
    >
      {usedTokens !== null ? (
        <div className="flex flex-col gap-1.5 px-2.5 pb-1">
          <div className="flex items-baseline justify-between gap-3 text-2xs tabular-nums">
            <span className="font-medium text-foreground/80">
              {approx}
              {/* With no known window (Hermes), the used tokens stand alone. */}
              {usedPercentLabel ?? formatContextWindowTokens(usedTokens)} used
            </span>
            {usedPercentLabel !== null ? (
              <span className="text-muted-foreground">
                {approx}
                {formatContextWindowTokens(usedTokens)}
                {maxTokens !== null ? ` / ${formatContextWindowTokens(maxTokens)}` : null}
              </span>
            ) : null}
          </div>
          {usedPercentLabel === null ? null : view ? (
            <ContextSegmentBar view={view} />
          ) : (
            <ContextAggregateBar usedPercent={usedPercent} />
          )}
        </div>
      ) : null}
      {view && context ? (
        <ContextCategoryRows view={view} estimated={estimated} />
      ) : contextWindow ? (
        <ContextUsageTotals usage={contextWindow} />
      ) : null}
      {compactionCount > 0 ? (
        <ThreadDetailsStatRow label="Compactions">
          {compactionCount.toLocaleString()}
        </ThreadDetailsStatRow>
      ) : null}
      {untilAutoCompact !== null ? (
        <p
          className={cn(
            "px-2.5 pt-1 text-2xs tabular-nums",
            autoCompactsSoon ? "text-warning" : "text-muted-foreground",
          )}
        >
          {autoCompactsSoon
            ? `Auto-compacts soon (${formatContextWindowTokens(untilAutoCompact)} left)`
            : `${formatContextWindowTokens(untilAutoCompact)} until auto-compact`}
        </p>
      ) : null}
      {context ? <ContextContributorLists context={context} /> : null}
      {context?.note ? (
        <p className="px-2.5 pt-1 text-2xs text-pretty text-muted-foreground">{context.note}</p>
      ) : null}
      {props.onCompactContext ? (
        <div className="grid gap-1 px-2.5 pt-2">
          <Button
            size="xs"
            variant="outline"
            disabled={props.compactDisabled}
            onClick={props.onCompactContext}
          >
            <Minimize2Icon aria-hidden="true" />
            Compact context
          </Button>
          {props.compactDisabled && props.compactDisabledReason ? (
            <p className="text-2xs text-pretty text-muted-foreground">
              {props.compactDisabledReason}
            </p>
          ) : null}
        </div>
      ) : null}
      {asOf ? (
        <p className="px-2.5 pt-1.5 text-2xs text-muted-foreground">
          As of {formatRelativeTimeLabel(asOf)}
        </p>
      ) : null}
      {props.error !== null ? (
        <p className="px-2.5 pt-1.5 text-2xs text-pretty text-destructive">
          Couldn't read session details: {props.error}
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
});

function ContextSegmentBar(props: { readonly view: ContextBreakdownView }) {
  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
      role="img"
      aria-label={props.view.segments
        .map((segment) => `${segment.name} ${formatContextPercent(segment.percent)}`)
        .join(", ")}
    >
      {props.view.segments.map((segment, index) => (
        <span
          key={`${index}:${segment.name}`}
          className={cn("h-full", segment.colorClassName)}
          style={{ width: `${segment.percent}%` }}
        />
      ))}
    </div>
  );
}

function ContextAggregateBar(props: { readonly usedPercent: number | null }) {
  const percent = Math.max(0, Math.min(100, props.usedPercent ?? 0));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <div
        className={cn(
          "h-full rounded-full",
          percent > 90 ? "bg-destructive" : "bg-muted-foreground/70",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function ContextCategoryRows(props: {
  readonly view: ContextBreakdownView;
  readonly estimated: boolean;
}) {
  return (
    <div className="flex flex-col">
      {props.view.rows.map((row, index) => {
        const percent = formatContextPercent(row.percent);
        return (
          <ThreadDetailsStatRow
            key={`${index}:${row.name}`}
            dimmed={row.kind === "deferred"}
            label={
              <>
                <ThreadDetailsStatusDot className={row.colorClassName ?? "bg-transparent"} />
                <span className="truncate">
                  {row.kind === "deferred" && !/\(deferred\)/i.test(row.name)
                    ? `${row.name} (deferred)`
                    : row.name}
                </span>
              </>
            }
          >
            {props.estimated ? "~" : null}
            {formatContextWindowTokens(row.tokens)}
            {percent !== null ? (
              <span className="ms-1.5 font-normal text-muted-foreground">{percent}</span>
            ) : null}
          </ThreadDetailsStatRow>
        );
      })}
    </div>
  );
}

function ContextUsageTotals(props: { readonly usage: ContextWindowSnapshot }) {
  const { usage } = props;
  const rows = [
    ["Input", usage.inputTokens],
    ["Cached", usage.cachedInputTokens],
    ["Output", usage.outputTokens],
    ["Reasoning", usage.reasoningOutputTokens],
    ["Total processed", usage.totalProcessedTokens],
    ["Last turn", usage.lastUsedTokens],
  ] as const;
  return (
    <div className="flex flex-col">
      {rows.map(([label, tokens]) =>
        tokens === null ? null : (
          <ThreadDetailsStatRow key={label} label={label}>
            {formatContextWindowTokens(tokens)}
          </ThreadDetailsStatRow>
        ),
      )}
    </div>
  );
}

interface ContributorListItem {
  readonly key: string;
  readonly label: string;
  readonly detail: string | undefined;
  /** Absent when the source names the contributor without sizing it. */
  readonly tokens: number | undefined;
}

function ContextContributorLists(props: { readonly context: SessionContextBreakdown }) {
  const { context } = props;
  const lists = useMemo(
    () => [
      {
        title: "MCP tools",
        items: groupContributorsBySource(context.mcpTools).map((group) => ({
          key: group.source ?? "",
          label: group.source ?? "Other",
          detail: `${group.count} ${group.count === 1 ? "tool" : "tools"}`,
          tokens: group.tokens,
        })),
      },
      { title: "Memory files", items: contributorItems(context.memoryFiles) },
      { title: "Skills", items: contributorItems(context.skills) },
      { title: "Custom agents", items: contributorItems(context.agents) },
    ],
    [context],
  );
  return (
    <div className="flex flex-col pt-1">
      {lists.map((list) =>
        list.items.length === 0 ? null : (
          <ContributorList key={list.title} title={list.title} items={list.items} />
        ),
      )}
    </div>
  );
}

function contributorItems(
  contributors: SessionContextBreakdown["memoryFiles"],
): ReadonlyArray<ContributorListItem> {
  return contributors.toSorted(compareByTokensThenName).map((contributor, index) => ({
    key: `${contributor.source ?? ""}:${contributor.name}:${index}`,
    label: contributor.name,
    detail: contributor.source,
    tokens: contributor.tokens,
  }));
}

function ContributorList(props: {
  readonly title: string;
  readonly items: ReadonlyArray<ContributorListItem>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <CollapsibleSectionHeader
        variant="panel"
        expanded={expanded}
        accessory={
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {props.items.length}
          </span>
        }
        onClick={() => setExpanded((value) => !value)}
      >
        {props.title}
      </CollapsibleSectionHeader>
      {expanded ? (
        <ul className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0">
          {props.items.map((item) => (
            <li key={item.key}>
              <ThreadDetailsStatRow
                label={
                  <span className="min-w-0 truncate" title={item.label}>
                    {item.label}
                    {item.detail ? (
                      <span className="ms-1.5 text-muted-foreground/70">{item.detail}</span>
                    ) : null}
                  </span>
                }
              >
                {item.tokens === undefined ? null : formatContextWindowTokens(item.tokens)}
              </ThreadDetailsStatRow>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
