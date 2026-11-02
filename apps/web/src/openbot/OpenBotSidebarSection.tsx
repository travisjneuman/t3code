/**
 * OpenBot shelf above Other Agents: every OpenBot agent's conversations, read
 * from OpenBot's database, merged with the T3 threads opened from them. Side
 * threads and agents without Local scripts are watch-only. Fork add-on: OpenBot provider.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  type ContextMenuItem,
  type EnvironmentId,
  type OpenBotConversationSummary,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { CircleDashedIcon, EyeIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type MouseEvent } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useSidebar } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useStableCallback } from "../hooks/useStableCallback";
import { useThreadActions } from "../hooks/useThreadActions";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  AGENT_LINE_ACTIVE_CLASS,
  AGENT_LINE_CLASS,
  AGENT_LINE_ICON_CLASS,
} from "../sidebar-compact/agentLines";
import { AgentSectionAccessory } from "../sidebar-compact/AgentSectionParts";
import { waitForThreadShell } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  OPENBOT_DRIVER,
  openbotInstanceIds,
  openbotSessionsList,
  openbotSessionsOpen,
  runOpenBot,
} from "./openbotSessions";

const EXPANDED_STORAGE_KEY = "t3code:sidebar:openbot-expanded";
const WATCH_ONLY = "Watch-only: T3 sends only to an agent's main conversation, with Local scripts on";

type MenuAction = "open" | "archive" | "delete" | "copy-id" | "refresh";
type MenuPosition = { readonly x: number; readonly y: number };

interface OpenBotTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

/** One line: an OpenBot conversation, the T3 thread opened from it, or both. */
interface OpenBotRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly conversation: OpenBotConversationSummary | null;
  readonly thread: EnvironmentThreadShell | null;
  readonly title: string;
  readonly lastActiveAt: number;
  /** A T3 turn is running in it. */
  readonly running: boolean;
  /** OpenBot was working in it when last listed, outside T3. */
  readonly runningInOpenBot: boolean;
}

const targetKey = (target: OpenBotTarget) =>
  `${target.environmentId}\u0000${target.instanceId}`;

function targetsFromKey(key: string): OpenBotTarget[] {
  return key === ""
    ? []
    : key.split("\n").map((entry) => {
        const [environmentId, instanceId] = entry.split("\u0000");
        return {
          environmentId: environmentId as EnvironmentId,
          instanceId: instanceId as ProviderInstanceId,
        };
      });
}

function preventMouseFocus(event: MouseEvent) {
  event.preventDefault();
}

/** The unarchived threads of the OpenBot instances in `targetsKey`, stable while none change. */
const openbotThreadsAtom = Atom.family((targetsKey: string) => {
  const wanted = new Set(targetsKey === "" ? [] : targetsKey.split("\n"));
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const next = get(environmentThreadShells.navigationThreadShellsAtom).filter((thread) =>
      wanted.has(
        targetKey({ environmentId: thread.environmentId, instanceId: thread.providerInstanceId }),
      ),
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`openbot-sidebar-threads:${targetsKey}`));
});

function mergeRows(
  target: OpenBotTarget,
  conversations: ReadonlyArray<OpenBotConversationSummary>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): OpenBotRow[] {
  const byThreadId = new Map(threads.map((thread) => [thread.id as string, thread]));
  const claimed = new Set<string>();
  const rows: OpenBotRow[] = conversations.map((conversation) => {
    const thread =
      conversation.threadId === null ? undefined : byThreadId.get(conversation.threadId);
    if (thread !== undefined) claimed.add(thread.id);
    return {
      key: `${targetKey(target)}\u0000conversation:${conversation.id}`,
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      conversation,
      thread: thread ?? null,
      title: thread?.title ?? conversation.title,
      lastActiveAt: Math.max(
        conversation.lastActiveAt,
        thread === undefined ? 0 : Date.parse(thread.updatedAt),
      ),
      running: threadRuntimeIsActive(thread?.runtime),
      runningInOpenBot: conversation.running,
    };
  });
  // Threads OpenBot has not listed yet, such as one started from the model picker.
  for (const thread of threads) {
    if (claimed.has(thread.id)) continue;
    rows.push({
      key: `${targetKey(target)}\u0000thread:${thread.id}`,
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      conversation: null,
      thread,
      title: thread.title,
      lastActiveAt: Date.parse(thread.updatedAt),
      running: threadRuntimeIsActive(thread.runtime),
      runningInOpenBot: false,
    });
  }
  return rows;
}

export function OpenBotSidebarSection() {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useEnvironments();
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const [listed, setListed] = useState<
    ReadonlyMap<string, ReadonlyArray<OpenBotConversationSummary>>
  >(new Map());
  const [refreshNonce, setRefreshNonce] = useState(0);
  const openingRef = useRef(new Set<string>());
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set());
  const nowMinute = useNowMinute();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const { archiveThread, confirmAndDeleteThread } = useThreadActions();
  const activeThreadKey = useParams({
    strict: false,
    select: (params) =>
      params.environmentId && params.threadId
        ? `${params.environmentId}\u0000${params.threadId}`
        : null,
  });
  const { copyToClipboard } = useCopyToClipboard<{ title: string }>({
    onCopy: ({ title }) => toastManager.add({ type: "success", title }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Failed to copy",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
  });

  // Keyed by string so provider status pushes do not refetch the list.
  const targetsKey = (() => {
    const keys: string[] = [];
    for (const [environmentId, config] of serverConfigs) {
      for (const instanceId of openbotInstanceIds(config)) {
        keys.push(targetKey({ environmentId, instanceId }));
      }
    }
    return keys.join("\n");
  })();
  const targets = targetsFromKey(targetsKey);
  const openbotThreads = useAtomValue(openbotThreadsAtom(targetsKey));
  const connectedKey = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId)
    .join("\n");
  // A thread appearing, going or finishing a turn changes what OpenBot lists.
  const threadsSignature = openbotThreads
    .map((thread) => `${thread.id}:${thread.runtime?.status ?? "idle"}`)
    .join(",");

  useEffect(() => {
    const connected = new Set(connectedKey.split("\n"));
    const ready = targetsFromKey(targetsKey).filter((target) =>
      connected.has(target.environmentId),
    );
    if (ready.length === 0) return;
    let cancelled = false;
    void Promise.all(
      ready.map(async (target) => {
        const result = await runOpenBot(
          openbotSessionsList,
          target.environmentId,
          { instanceId: target.instanceId },
          "Could not list OpenBot conversations",
        );
        return [targetKey(target), result?.conversations ?? null] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setListed((previous) => {
        const next = new Map(previous);
        for (const [key, conversations] of results) {
          if (conversations !== null) next.set(key, conversations);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [targetsKey, connectedKey, refreshNonce, threadsSignature]);

  // OpenBot's own UI and schedules move conversations while T3 is in the background.
  useEffect(() => {
    const onFocus = () => setRefreshNonce((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const threadsByTarget = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of openbotThreads) {
    const key = targetKey({
      environmentId: thread.environmentId,
      instanceId: thread.providerInstanceId,
    });
    threadsByTarget.set(key, [...(threadsByTarget.get(key) ?? []), thread]);
  }
  const rows = targets
    .flatMap((target) =>
      mergeRows(
        target,
        listed.get(targetKey(target)) ?? [],
        threadsByTarget.get(targetKey(target)) ?? [],
      ),
    )
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  const isBusy = (row: OpenBotRow) => row.running || row.runningInOpenBot;
  // Collapsed, the shelf still lists what is running, like Other Agents.
  const visibleRows = expanded ? rows : rows.filter(isBusy);
  const refresh = () => setRefreshNonce((value) => value + 1);
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const mayOpen = (row: OpenBotRow) =>
    appAtomRegistry.get(openbotSessionsOpen.permissionAtom(row.environmentId));

  const openThread = async (environmentId: EnvironmentId, threadId: string) => {
    const threadRef = scopeThreadRef(environmentId, threadId as EnvironmentThreadShell["id"]);
    if (!(await waitForThreadShell(threadRef))) {
      toastManager.add({
        type: "info",
        title: "Thread created",
        description: "It has not reached this client yet. Open it from the sidebar.",
      });
      return;
    }
    closeMobileSidebar();
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };

  /** Opens the conversation in T3, or brings its thread up to date with what OpenBot added since. */
  const openRow = async (row: OpenBotRow) => {
    if (row.conversation === null) {
      if (row.thread !== null) await openThread(row.environmentId, row.thread.id);
      return;
    }
    if (!mayOpen(row)) {
      if (row.thread !== null) {
        await openThread(row.environmentId, row.thread.id);
        return;
      }
      toastManager.add({
        type: "info",
        title: "Cannot open this OpenBot conversation",
        description: "Needs operate access on this connection.",
      });
      return;
    }
    if (row.thread !== null) {
      await openThread(row.environmentId, row.thread.id);
      await runOpenBot(
        openbotSessionsOpen,
        row.environmentId,
        { instanceId: row.instanceId, conversationId: row.conversation.id },
        null,
      );
      return;
    }
    if (openingRef.current.has(row.key)) return;
    openingRef.current.add(row.key);
    setOpening(new Set(openingRef.current));
    try {
      const result = await runOpenBot(
        openbotSessionsOpen,
        row.environmentId,
        { instanceId: row.instanceId, conversationId: row.conversation.id },
        "Could not open this OpenBot conversation",
      );
      if (result !== null) await openThread(row.environmentId, result.threadId);
    } finally {
      openingRef.current.delete(row.key);
      setOpening(new Set(openingRef.current));
    }
  };

  const showRowMenu = async (row: OpenBotRow, position: MenuPosition) => {
    const api = readLocalApi();
    if (api === undefined) return;
    const items: Array<ContextMenuItem<MenuAction>> = [];
    if (row.thread !== null || mayOpen(row)) {
      items.push({
        id: "open",
        label: row.thread !== null ? "Open" : "Open in T3",
        icon: "message-square-plus",
      });
    }
    if (row.conversation !== null) {
      items.push({ id: "copy-id", label: "Copy conversation ID", icon: "hash" });
    }
    // The conversation stays in OpenBot; these act on the T3 thread alone.
    if (row.thread !== null) {
      items.push(
        {
          id: "archive",
          label: "Archive thread",
          icon: "archive",
          separatorBefore: true,
          disabled: row.running,
        },
        {
          id: "delete",
          label: "Delete thread",
          icon: "trash",
          destructive: true,
          disabled: row.running,
        },
      );
    }
    const clicked = await api.contextMenu.show(items, position);
    switch (clicked) {
      case "open":
        await openRow(row);
        return;
      case "copy-id":
        if (row.conversation !== null) {
          copyToClipboard(row.conversation.id, { title: "Conversation ID copied" });
        }
        return;
      case "archive":
        if (row.thread !== null) {
          await archiveThread(scopeThreadRef(row.environmentId, row.thread.id));
        }
        break;
      case "delete":
        if (row.thread !== null) {
          await confirmAndDeleteThread(scopeThreadRef(row.environmentId, row.thread.id));
        }
        break;
      default:
        return;
    }
    refresh();
  };

  // Rows are memoized, so they get stable callbacks that run the latest handlers.
  const handleContextMenu = useStableCallback((row: OpenBotRow, position: MenuPosition) => {
    void showRowMenu(row, position);
  });
  const handleClick = useStableCallback((row: OpenBotRow, event: MouseEvent) => {
    if (row.thread === null) {
      event.preventDefault();
      void openRow(row);
      return;
    }
    closeMobileSidebar();
    if (row.conversation !== null && mayOpen(row)) {
      void runOpenBot(
        openbotSessionsOpen,
        row.environmentId,
        { instanceId: row.instanceId, conversationId: row.conversation.id },
        null,
      );
    }
  });

  const handleHeaderContextMenu = async (event: MouseEvent) => {
    const api = readLocalApi();
    if (api === undefined) return;
    event.preventDefault();
    const clicked = await api.contextMenu.show<MenuAction>(
      [{ id: "refresh", label: "Refresh", icon: "refresh-cw" }],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "refresh") refresh();
  };

  if (targets.length === 0) return null;

  return (
    <section aria-label="OpenBot" className="mt-1">
      <div
        className="mx-0.5 flex h-5 items-center gap-0.5"
        onContextMenu={(event) => void handleHeaderContextMenu(event)}
      >
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={expanded}
            size="sidebar"
            onClick={() => setExpanded((value) => !value)}
            onMouseDown={preventMouseFocus}
            accessory={
              <AgentSectionAccessory count={rows.length} running={rows.filter(isBusy).length} />
            }
          >
            OpenBot
          </CollapsibleSectionHeader>
        </div>
      </div>
      {expanded || visibleRows.length > 0 ? (
        <ul className="flex flex-col">
          {visibleRows.map((row) => (
            <OpenBotLine
              key={row.key}
              row={row}
              isActive={
                row.thread !== null &&
                activeThreadKey === `${row.environmentId}\u0000${row.thread.id}`
              }
              isOpening={opening.has(row.key)}
              nowMinute={nowMinute}
              onClick={handleClick}
              onContextMenu={handleContextMenu}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Matches the thread rows' short relative time: "5m", "now". */
function compactTimeLabel(ms: number, nowMinute: string): string {
  const label = formatRelativeTimeLabel(new Date(ms).toISOString(), Date.parse(`${nowMinute}:00Z`));
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/**
 * One OpenBot row: glyph, title, a watch-only eye, then a static status glyph
 * or its age. Conversations T3 has not opened recede like settled threads.
 */
const OpenBotLine = memo(function OpenBotLine(props: {
  row: OpenBotRow;
  isActive: boolean;
  isOpening: boolean;
  nowMinute: string;
  onClick: (row: OpenBotRow, event: MouseEvent) => void;
  onContextMenu: (row: OpenBotRow, position: MenuPosition) => void;
}) {
  const { row } = props;
  const status = row.running
    ? "Running"
    : props.isOpening
      ? "Opening"
      : row.runningInOpenBot
        ? "Running in OpenBot"
        : null;
  const watchOnly = row.conversation !== null && !row.conversation.sendable;
  const agentName = row.conversation?.agentName;
  const className = cn(
    AGENT_LINE_CLASS,
    "px-(--sidebar-row-content-inset)",
    props.isActive
      ? AGENT_LINE_ACTIVE_CLASS
      : row.thread === null
        ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        : "text-sidebar-foreground hover:bg-sidebar-row-hover",
  );
  const content = (
    <>
      <ProviderInstanceIcon
        driverKind={OPENBOT_DRIVER}
        displayName="OpenBot"
        className={AGENT_LINE_ICON_CLASS}
        iconClassName="size-3"
      />
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {watchOnly ? (
        <span aria-hidden title={WATCH_ONLY} className="flex shrink-0">
          <EyeIcon className="size-3 text-secondary-label" />
        </span>
      ) : null}
      {status !== null ? (
        <span aria-hidden title={status} className="flex shrink-0">
          <CircleDashedIcon className="size-3 text-info-foreground" />
        </span>
      ) : (
        <span className="shrink-0 tabular-nums text-secondary-label">
          {compactTimeLabel(row.lastActiveAt, props.nowMinute)}
        </span>
      )}
    </>
  );
  const label = [row.title, watchOnly ? "watch-only" : null, status?.toLowerCase() ?? null]
    .filter((part) => part !== null)
    .join(", ");
  const common = {
    title: agentName !== undefined ? `${agentName} · ${row.title}` : row.title,
    // The glyphs are aria-hidden, so the row's name carries them instead.
    "aria-label": label,
    "aria-current": props.isActive ? ("page" as const) : undefined,
    "aria-busy": props.isOpening || undefined,
    onClick: (event: MouseEvent) => props.onClick(row, event),
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      props.onContextMenu(row, { x: event.clientX, y: event.clientY });
    },
    className,
  };
  return (
    <li className="list-none">
      {row.thread !== null ? (
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(scopeThreadRef(row.environmentId, row.thread.id))}
          {...common}
        >
          {content}
        </Link>
      ) : (
        <button type="button" {...common}>
          {content}
        </button>
      )}
    </li>
  );
});
