import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { ThreadWorktreeIndicator } from "../components/ThreadStatusIndicators";
import { MiddleTruncate } from "../components/ui/middle-truncate";
import { ContinuedThreadMarker } from "../external-sessions/handBack";
import { SubagentToggle } from "../subagents/SidebarSubagentRows";
import type { SidebarThreadSummary } from "../types";

/** Fork add-on: compact cards keep the machine centered between branch and status. */
export function ThreadCardMeta(props: {
  thread: SidebarThreadSummary;
  threadKey: string;
  subagentCount: number;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  isRemote: boolean;
  terminalStatusIcon: ReactNode;
  prBadge: ReactNode;
  diff: { insertions: number; deletions: number } | null;
  providerStack: ReactNode;
}) {
  const showsMachine = props.environmentLabel !== null;
  return (
    <div
      data-fork-card-part="meta"
      // Equal side columns keep the machine centered in the card.
      className="mt-0.5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 text-secondary-label text-xs"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <SubagentToggle threadKey={props.threadKey} count={props.subagentCount} />
        {props.thread.branch ? (
          <>
            <ThreadWorktreeIndicator thread={props.thread} />
            <span className="flex min-w-0 flex-1 text-muted-foreground/40">
              <MiddleTruncate value={props.thread.branch} showTitle={false} />
            </span>
          </>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground/40">
        {showsMachine ? (
          <>
            <EnvironmentMachineIcon
              aria-hidden
              kind={props.environmentMachine}
              className="size-3 shrink-0"
            />
            <span className="min-w-0 truncate">{props.environmentLabel}</span>
          </>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1.5">
        {props.terminalStatusIcon}
        {props.prBadge}
        {props.diff ? (
          <span className="shrink-0 font-mono">
            <span className="text-diff-addition-foreground">
              +{formatDiffCount(props.diff.insertions)}
            </span>{" "}
            <span className="text-diff-deletion-foreground">
              −{formatDiffCount(props.diff.deletions)}
            </span>
          </span>
        ) : null}
        <span aria-hidden className="pointer-events-none inline-flex shrink-0 items-center gap-1">
          {props.isRemote && !showsMachine ? (
            <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
              <EnvironmentMachineIcon
                aria-hidden
                kind={props.environmentMachine}
                className="size-3.5"
              />
            </span>
          ) : null}
          <ContinuedThreadMarker threadId={props.thread.id} />
          {props.providerStack}
        </span>
      </span>
    </div>
  );
}
