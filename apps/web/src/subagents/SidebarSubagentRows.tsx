/**
 * Subagents (delegate_task children and provider-native subagents) nested
 * under their top-level thread's sidebar row, one line each, in whichever
 * section that row sits. They stay after they finish so they can be reviewed,
 * archived or deleted. A toggle on the parent's row shows all of them or only
 * the running ones; running only is the default. Fork add-on: nested subagents.
 */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeCanArchive,
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  ClockIcon,
  CpuIcon,
} from "lucide-react";
import { memo, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../components/ThreadHoverCard";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { shortModelLabel } from "../external-sessions/atoms";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import type { ProviderInstanceEntry } from "../providerInstances";
import {
  AGENT_LINE_ACTIVE_CLASS,
  AGENT_LINE_CLASS,
  AGENT_LINE_ICON_CLASS,
  AGENT_MORE_BUTTON_CLASS,
} from "../sidebar-compact/agentLines";
import { AgentMoreIcon } from "../sidebar-compact/AgentSectionParts";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";

/** Parents whose subagents are shown; every other parent hides them. */
const EXPANDED_STORAGE_KEY = "t3code:sidebar:subagents-expanded";
const ExpandedKeysSchema = Schema.Array(Schema.String);
const NO_KEYS: ReadonlyArray<string> = [];
/** Subagents listed before "Show more". */
const SHOWN_BEFORE_MORE = 3;
/** Deeper subagents than this indent no further. */
const MAX_INDENT_DEPTH = 3;

export interface SidebarSubagent {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  /** The top-level thread's key for a direct child. */
  readonly parentKey: string;
}

type MenuAction = "open" | "copy-thread-id" | "archive" | "delete";
type MenuPosition = { readonly x: number; readonly y: number };

const isSubagent = (thread: EnvironmentThreadShell) =>
  thread.lineage.relationshipToParent === "subagent";

/**
 * Live subagents keyed by the top-level thread they descend from, each list
 * depth-first with the newest started first at every level. A subagent whose
 * chain never reaches a listed thread is left out.
 */
function groupSubagents(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<string, ReadonlyArray<SidebarSubagent>> {
  const childrenOf = new Map<string, EnvironmentThreadShell[]>();
  const byKey = new Map<string, EnvironmentThreadShell>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    byKey.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
    const parentId = thread.lineage.parentThreadId;
    if (!isSubagent(thread) || parentId === null) continue;
    const parentKey = scopedThreadKey(scopeThreadRef(thread.environmentId, parentId));
    const siblings = childrenOf.get(parentKey);
    if (siblings) siblings.push(thread);
    else childrenOf.set(parentKey, [thread]);
  }
  const groups = new Map<string, SidebarSubagent[]>();
  for (const [key, thread] of byKey) {
    if (isSubagent(thread) || !childrenOf.has(key)) continue;
    const rows: SidebarSubagent[] = [];
    const seen = new Set<string>([key]);
    const walk = (parentKey: string) => {
      const children = [...(childrenOf.get(parentKey) ?? [])].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
      for (const child of children) {
        const childKey = scopedThreadKey(scopeThreadRef(child.environmentId, child.id));
        if (seen.has(childKey)) continue;
        seen.add(childKey);
        rows.push({ key: childKey, thread: child, parentKey });
        walk(childKey);
      }
    };
    walk(key);
    groups.set(key, rows);
  }
  return groups;
}

type SubagentProviderEntry = Pick<
  ProviderInstanceEntry,
  "driverKind" | "displayName" | "accentColor" | "acpRegistryAgentId" | "acpRegistryIconUrl"
>;

const NO_PROVIDER_ENTRIES: ReadonlyMap<string, SubagentProviderEntry> = new Map();

/**
 * Called once by the sidebar. `count(parentKey)` feeds that row's toggle;
 * `render(parentKey)` is the subagent block that goes right after the row:
 * one node, or none when nothing is visible. Shown, the first few are listed
 * until "Show more"; hidden, only running subagents and the one being viewed
 * stay visible, like the Other Agents and Hermes shelves.
 */
export function useSidebarSubagents(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  activeThreadKey: string | null;
  providerEntriesByEnvironment: ReadonlyMap<string, ReadonlyMap<string, SubagentProviderEntry>>;
  onOpen: (threadRef: ScopedThreadRef) => void;
}): {
  readonly count: (parentKey: string) => number;
  readonly render: (parentKey: string) => ReactNode[];
} {
  const { threads } = input;
  const groups = groupSubagents(threads);
  const [expandedKeys] = useLocalStorage(EXPANDED_STORAGE_KEY, NO_KEYS, ExpandedKeysSchema);
  const nowMinute = useNowMinute();
  const { archiveThread, deleteThread } = useThreadActions();
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const { copyToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: () => toastManager.add({ type: "success", title: "Thread ID copied" }),
  });

  const fail = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  const onContextMenu = useStableCallback(
    (
      thread: EnvironmentThreadShell,
      position: MenuPosition,
      open: (threadRef: ScopedThreadRef) => void,
    ) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        const items: ContextMenuItem<MenuAction>[] = [
          { id: "open", label: "Open" },
          { id: "copy-thread-id", label: "Copy thread ID" },
          {
            id: "archive",
            label: "Archive",
            separatorBefore: true,
            disabled: !threadRuntimeCanArchive(thread.runtime),
          },
          { id: "delete", label: "Delete", destructive: true },
        ];
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        switch (clicked.value) {
          case "open":
            open(threadRef);
            return;
          case "copy-thread-id":
            copyToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive subagent "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            fail("Failed to archive subagent", await archiveThread(threadRef));
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete subagent "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            fail("Failed to delete subagent", await deleteThread(threadRef));
            return;
          }
        }
      })();
    },
  );

  const count = (parentKey: string) => groups.get(parentKey)?.length ?? 0;

  const render = (parentKey: string): ReactNode[] => {
    const subagents = groups.get(parentKey);
    if (subagents === undefined) return [];
    const expanded = expandedKeys.includes(parentKey);
    const visible = expanded
      ? subagents
      : subagents.filter((entry) => alwaysShown(entry, input.activeThreadKey));
    if (visible.length === 0) return [];
    const environmentId = visible[0]!.thread.environmentId;
    return [
      <SidebarSubagentRows
        key={`${parentKey}:subagents`}
        tree={subagents}
        subagents={visible}
        capped={expanded}
        activeThreadKey={input.activeThreadKey}
        providerEntryByInstanceId={
          input.providerEntriesByEnvironment.get(environmentId) ?? NO_PROVIDER_ENTRIES
        }
        nowMinute={nowMinute}
        onOpen={input.onOpen}
        onContextMenu={onContextMenu}
      />,
    ];
  };

  return { count, render };
}

/** The row's show/hide switch for its subagents; nothing when it has none. */
export function SubagentToggle(props: { threadKey: string; count: number }) {
  return props.count > 0 ? <SubagentToggleButton {...props} /> : null;
}

function SubagentToggleButton(props: { threadKey: string; count: number }) {
  const [expandedKeys, setExpandedKeys] = useLocalStorage(
    EXPANDED_STORAGE_KEY,
    NO_KEYS,
    ExpandedKeysSchema,
  );
  const expanded = expandedKeys.includes(props.threadKey);
  const label = `${expanded ? "Hide" : "Show"} ${props.count} ${
    props.count === 1 ? "subagent" : "subagents"
  }`;
  // The row underneath opens, renames and drags on these; the toggle is not part of that.
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-expanded={expanded}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setExpandedKeys((keys) =>
                keys.includes(props.threadKey)
                  ? keys.filter((key) => key !== props.threadKey)
                  : [...keys, props.threadKey],
              );
            }}
            onPointerDown={stop}
            onDoubleClick={stop}
            onKeyDown={stop}
            className={cn(
              "-ms-1 inline-flex h-3.5 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-[11px] leading-none tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              expanded ? "text-foreground/80" : "text-muted-foreground",
            )}
          />
        }
      >
        <ChevronRightIcon aria-hidden className={cn("size-3", expanded && "rotate-90")} />
        {props.count}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Matches the thread rows' short relative time: "5m", "now". */
function compactTimeLabel(iso: string, now: number): string {
  const label = formatRelativeTimeLabel(iso, now);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function statusLabel(thread: EnvironmentThreadShell): string {
  if (threadRuntimeIsActive(thread.runtime)) return "Working";
  switch (thread.latestRun?.status) {
    case "failed":
      return "Failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "Stopped";
    case "completed":
      return "Done";
    default:
      return "Idle";
  }
}

const alwaysShown = (entry: SidebarSubagent, activeThreadKey: string | null) =>
  entry.key === activeThreadKey || threadRuntimeIsActive(entry.thread.runtime);

/**
 * How far each listed subagent indents: one step per listed ancestor, so a
 * subagent listed without its parent sits flush instead of under a stranger.
 */
function indentDepths(
  tree: ReadonlyArray<SidebarSubagent>,
  listed: ReadonlyArray<SidebarSubagent>,
): ReadonlyMap<string, number> {
  const parentOf = new Map(tree.map((entry) => [entry.key, entry.parentKey]));
  const depths = new Map<string, number>();
  for (const entry of listed) {
    let ancestor: string | undefined = entry.parentKey;
    while (ancestor !== undefined && !depths.has(ancestor)) ancestor = parentOf.get(ancestor);
    depths.set(entry.key, ancestor === undefined ? 0 : depths.get(ancestor)! + 1);
  }
  return depths;
}

/**
 * A top-level thread's visible subagents, one line each. `capped` lists the
 * first few, plus running ones and the one being viewed, until "Show more".
 */
function SidebarSubagentRows(props: {
  /** Every subagent under the parent, listed or not. */
  tree: ReadonlyArray<SidebarSubagent>;
  subagents: ReadonlyArray<SidebarSubagent>;
  capped: boolean;
  activeThreadKey: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SubagentProviderEntry>;
  nowMinute: string;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    thread: EnvironmentThreadShell,
    position: MenuPosition,
    open: (threadRef: ScopedThreadRef) => void,
  ) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const cappedList = props.capped
    ? props.subagents.filter(
        (entry, index) => index < SHOWN_BEFORE_MORE || alwaysShown(entry, props.activeThreadKey),
      )
    : props.subagents;
  const shown = showAll ? props.subagents : cappedList;
  const hiddenCount = props.subagents.length - shown.length;
  const depths = indentDepths(props.tree, shown);
  return (
    <li role="presentation" className="list-none ps-3">
      <TooltipProvider delay={150} closeDelay={0} timeout={400}>
        <ul role="presentation" className="flex flex-col">
          {shown.map((entry) => (
            <SubagentLine
              key={entry.key}
              thread={entry.thread}
              depth={depths.get(entry.key) ?? 0}
              isActive={entry.key === props.activeThreadKey}
              providerEntry={
                props.providerEntryByInstanceId.get(
                  entry.thread.runtime?.providerInstanceId ??
                    entry.thread.modelSelection.instanceId,
                ) ?? null
              }
              nowMinute={props.nowMinute}
              onOpen={props.onOpen}
              onContextMenu={props.onContextMenu}
            />
          ))}
          {hiddenCount > 0 ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className={AGENT_MORE_BUTTON_CLASS}
              >
                <AgentMoreIcon />
                {`Show ${hiddenCount} more`}
              </button>
            </li>
          ) : showAll && cappedList.length < props.subagents.length ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() => setShowAll(false)}
                className={AGENT_MORE_BUTTON_CLASS}
              >
                <AgentMoreIcon less />
                Show less
              </button>
            </li>
          ) : null}
        </ul>
      </TooltipProvider>
    </li>
  );
}

/**
 * One subagent on a single line: harness icon, title, then its age or a
 * running spinner. Finished ones recede; the hover card holds model and status.
 * `nowMinute` only exists to refresh the age once a minute.
 */
const SubagentLine = memo(function SubagentLine(props: {
  thread: EnvironmentThreadShell;
  /** Listed ancestors above this line. */
  depth: number;
  isActive: boolean;
  providerEntry: SubagentProviderEntry | null;
  nowMinute: string;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    thread: EnvironmentThreadShell,
    position: MenuPosition,
    open: (threadRef: ScopedThreadRef) => void,
  ) => void;
}) {
  const { thread, depth } = props;
  const now = Date.parse(`${props.nowMinute}:00Z`);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const running = threadRuntimeIsActive(thread.runtime);
  const status = statusLabel(thread);
  const model = shortModelLabel(thread.modelSelection.model);
  const providerName = props.providerEntry?.displayName ?? thread.runtime?.providerName ?? null;
  const details = [providerName, model].filter((part): part is string => part !== null);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    props.onOpen(threadRef);
  };
  return (
    <li className="list-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(threadRef)}
              aria-label={[thread.title, ...details, status].join(", ")}
              aria-current={props.isActive ? "page" : undefined}
              onClick={onClick}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(thread, { x: event.clientX, y: event.clientY }, props.onOpen);
              }}
              style={{
                paddingInlineStart: `calc(var(--sidebar-row-content-inset) + ${
                  Math.min(depth, MAX_INDENT_DEPTH) * 0.75
                }rem)`,
              }}
              className={cn(
                AGENT_LINE_CLASS,
                "pe-(--sidebar-row-content-inset)",
                props.isActive
                  ? AGENT_LINE_ACTIVE_CLASS
                  : running
                    ? "text-sidebar-foreground hover:bg-sidebar-row-hover"
                    : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
            />
          }
        >
          {props.providerEntry !== null ? (
            <ProviderInstanceIcon
              driverKind={props.providerEntry.driverKind}
              displayName={props.providerEntry.displayName}
              accentColor={props.providerEntry.accentColor}
              acpRegistryAgentId={props.providerEntry.acpRegistryAgentId}
              acpRegistryIconUrl={props.providerEntry.acpRegistryIconUrl}
              className={AGENT_LINE_ICON_CLASS}
              // Pi's solid block glyph fills its box and reads larger than the
              // outline glyphs in Other Agents and Hermes, so it draws smaller.
              iconClassName="size-2.5"
            />
          ) : (
            <CpuIcon aria-hidden className={cn(AGENT_LINE_ICON_CLASS, "opacity-60")} />
          )}
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          {running ? (
            <CircleDashedIcon
              aria-hidden
              className={cn(AGENT_LINE_ICON_CLASS, "text-info-foreground")}
            />
          ) : (
            <>
              {status === "Failed" ? (
                <CircleAlertIcon aria-hidden className={cn(AGENT_LINE_ICON_CLASS, "text-error")} />
              ) : null}
              <span className="shrink-0 tabular-nums text-secondary-label">
                {compactTimeLabel(thread.updatedAt, now)}
              </span>
            </>
          )}
        </TooltipTrigger>
        <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
          <ThreadHoverCard title={thread.title}>
            {details.length > 0 ? (
              <div className="min-w-0 truncate text-foreground/75">{details.join(" · ")}</div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              {running ? (
                <CircleDashedIcon className="size-3 shrink-0 text-info-foreground" />
              ) : (
                <ClockIcon className="size-3 shrink-0 stroke-muted-foreground" />
              )}
              <div className="min-w-0 truncate text-foreground/75">
                {running
                  ? status
                  : `${status} · last active ${formatRelativeTimeLabel(thread.updatedAt, now)}`}
              </div>
            </div>
          </ThreadHoverCard>
        </ThreadHoverCardPopup>
      </Tooltip>
    </li>
  );
});
