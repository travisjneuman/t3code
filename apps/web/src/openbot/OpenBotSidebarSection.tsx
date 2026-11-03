/**
 * OpenBot shelves above Other Agents, one per OpenBot instance: each agent's
 * main conversation, read from OpenBot's database and merged with the T3
 * threads opened from them, with its side threads nested under it like
 * subagents. Side threads and agents without Local scripts are watch-only.
 * Fork add-on: OpenBot provider.
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
  type OpenBotAgentSummary,
  type OpenBotConversationSummary,
  openBotAgentLabel,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, CircleDashedIcon, EyeIcon, PlusIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useSidebar } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
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
  defaultOpenBotAgent,
  OPENBOT_DRIVER,
  openbotInstanceIds,
  openbotSessionsList,
  openbotSessionsOpen,
  openOpenBotAgentThread,
  runOpenBot,
} from "./openbotSessions";

/** Shelves the user collapsed, by target. */
const COLLAPSED_STORAGE_KEY = "t3code:sidebar:openbot-collapsed";
/** Agents whose side threads are all shown; the rest show only running ones. */
const AGENTS_EXPANDED_STORAGE_KEY = "t3code:sidebar:openbot-agents-expanded";
const KeysSchema = Schema.Array(Schema.String);
const NO_KEYS: ReadonlyArray<string> = [];
const WATCH_ONLY = "Watch-only: T3 sends only to an agent's main conversation, with Local scripts on";

type MenuAction = "open" | "archive" | "delete" | "copy-id";
type HeaderAction = "refresh";
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
  /** The hover text: the agent and the thread for a side thread. */
  readonly hint: string;
  readonly lastActiveAt: number;
  /** A T3 turn is running in it. */
  readonly running: boolean;
  /** OpenBot was working in it when last listed, outside T3. */
  readonly runningInOpenBot: boolean;
}

/** An agent's main conversation and the side threads nested under it. */
interface OpenBotGroup {
  readonly row: OpenBotRow;
  readonly children: ReadonlyArray<OpenBotRow>;
  readonly lastActiveAt: number;
}

interface OpenBotListing {
  readonly label: string | undefined;
  readonly conversations: ReadonlyArray<OpenBotConversationSummary>;
  readonly agents: ReadonlyArray<OpenBotAgentSummary>;
}

const agentLabel = (conversation: OpenBotConversationSummary) =>
  openBotAgentLabel(conversation.agentName, conversation.agentTitle);

/** The tooltip keeps the role in full. */
const agentFullLabel = (conversation: OpenBotConversationSummary) =>
  conversation.agentTitle?.trim()
    ? `${conversation.agentName} - ${conversation.agentTitle.trim()}`
    : conversation.agentName;

const isBusy = (row: OpenBotRow) => row.running || row.runningInOpenBot;

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
      title:
        conversation.side === false
          ? agentLabel(conversation)
          : conversation.side === true
            ? conversation.title
            : (thread?.title ?? conversation.title),
      hint:
        conversation.side === true
          ? `${agentFullLabel(conversation)} · ${conversation.title}`
          : conversation.side === false
            ? agentFullLabel(conversation)
            : `${conversation.agentName} · ${thread?.title ?? conversation.title}`,
      lastActiveAt: Math.max(
        conversation.lastActiveAt,
        thread === undefined ? 0 : Date.parse(thread.updatedAt),
      ),
      running: threadRuntimeIsActive(thread?.runtime),
      runningInOpenBot: conversation.running,
    };
  });
  // Threads OpenBot no longer lists. An empty thread is an opened conversation OpenBot holds
  // nothing for, so it doesn't list the agent.
  for (const thread of threads) {
    if (claimed.has(thread.id) || thread.itemCount === 0) continue;
    rows.push({
      key: `${targetKey(target)}\u0000thread:${thread.id}`,
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      conversation: null,
      thread,
      title: thread.title,
      hint: thread.title,
      lastActiveAt: Date.parse(thread.updatedAt),
      running: threadRuntimeIsActive(thread.runtime),
      runningInOpenBot: false,
    });
  }
  return rows;
}

/** Side threads under their agent's main conversation; groups and children newest first. */
function groupRows(rows: ReadonlyArray<OpenBotRow>): OpenBotGroup[] {
  const mains = new Set<string>();
  for (const row of rows) {
    if (row.conversation !== null && row.conversation.side !== true) {
      mains.add(row.conversation.agentId);
    }
  }
  const parentOf = (row: OpenBotRow) =>
    row.conversation?.side === true && mains.has(row.conversation.agentId)
      ? row.conversation.agentId
      : undefined;
  const nested = (row: OpenBotRow) => parentOf(row) !== undefined;
  const childrenOf = new Map<string, OpenBotRow[]>();
  for (const row of rows) {
    const agentId = parentOf(row);
    if (agentId !== undefined) childrenOf.set(agentId, [...(childrenOf.get(agentId) ?? []), row]);
  }
  return rows
    .filter((row) => !nested(row))
    .map((row) => {
      const children =
        row.conversation === null
          ? []
          : (childrenOf.get(row.conversation.agentId) ?? []).toSorted(
              (left, right) => right.lastActiveAt - left.lastActiveAt,
            );
      return {
        row,
        children,
        lastActiveAt: Math.max(row.lastActiveAt, ...children.map((child) => child.lastActiveAt)),
      };
    })
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

export function OpenBotSidebarSection() {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useEnvironments();
  const [collapsedKeys, setCollapsedKeys] = useLocalStorage(
    COLLAPSED_STORAGE_KEY,
    NO_KEYS,
    KeysSchema,
  );
  const [expandedAgents, setExpandedAgents] = useLocalStorage(
    AGENTS_EXPANDED_STORAGE_KEY,
    NO_KEYS,
    KeysSchema,
  );
  const [listed, setListed] = useState<ReadonlyMap<string, OpenBotListing>>(new Map());
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
        return [
          targetKey(target),
          result === null
            ? null
            : {
                label: result.label,
                conversations: result.conversations,
                agents: result.agents ?? [],
              },
        ] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setListed((previous) => {
        const next = new Map(previous);
        for (const [key, listing] of results) {
          if (listing !== null) next.set(key, listing);
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
  const sections = targets.map((target) => {
    const key = targetKey(target);
    const listing = listed.get(key);
    const rows = mergeRows(
      target,
      listing?.conversations ?? [],
      threadsByTarget.get(key) ?? [],
    );
    const providerName = serverConfigs
      .get(target.environmentId)
      ?.providers.find((provider) => provider.instanceId === target.instanceId)?.displayName;
    return {
      key,
      target,
      label: listing?.label ?? providerName ?? "OpenBot",
      defaultAgent: defaultOpenBotAgent(listing?.agents ?? []),
      rows,
      groups: groupRows(rows),
    };
  });
  const isActiveRow = (row: OpenBotRow) =>
    row.thread !== null && activeThreadKey === `${row.environmentId}\u0000${row.thread.id}`;
  const toggleKey = (keys: ReadonlyArray<string>, key: string) =>
    keys.includes(key) ? keys.filter((each) => each !== key) : [...keys, key];
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
  const handleToggleChildren = useStableCallback((row: OpenBotRow) => {
    setExpandedAgents((keys) => toggleKey(keys, row.key));
  });
  const handleClick = useStableCallback((row: OpenBotRow, event: SyntheticEvent) => {
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

  /** The + opens the default agent's main conversation; the composer's agent picker moves on. */
  const openDefaultAgent = async (
    target: OpenBotTarget,
    agent: OpenBotAgentSummary | undefined,
  ) => {
    if (agent?.conversationId === undefined) {
      toastManager.add({
        type: "info",
        title: "No OpenBot agent to message",
        description: "Turn on Local scripts for an agent in OpenBot.",
      });
      return;
    }
    const threadRef = await openOpenBotAgentThread(
      target.environmentId,
      target.instanceId,
      agent.conversationId,
    );
    if (threadRef === null) return;
    closeMobileSidebar();
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };

  const handleHeaderContextMenu = async (event: MouseEvent) => {
    const api = readLocalApi();
    if (api === undefined) return;
    event.preventDefault();
    const clicked = await api.contextMenu.show<HeaderAction>(
      [{ id: "refresh", label: "Refresh", icon: "refresh-cw" }],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "refresh") refresh();
  };

  if (targets.length === 0) return null;

  const renderLine = (row: OpenBotRow, children?: ReadonlyArray<OpenBotRow>) => (
    <OpenBotLine
      key={row.key}
      row={row}
      isActive={isActiveRow(row)}
      isOpening={opening.has(row.key)}
      nowMinute={nowMinute}
      childCount={children?.length ?? 0}
      childrenExpanded={expandedAgents.includes(row.key)}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onToggleChildren={handleToggleChildren}
    />
  );

  return (
    <>
      {sections.map((section) => {
        const expanded = !collapsedKeys.includes(section.key);
        // Collapsed, the shelf still lists what is running, like Other Agents.
        const groups = expanded
          ? section.groups
          : section.groups.filter(
              (group) => isBusy(group.row) || group.children.some(isBusy),
            );
        return (
          <section key={section.key} aria-label={section.label} className="mt-1">
            <div
              className="mx-0.5 flex h-5 items-center gap-0.5"
              onContextMenu={(event) => void handleHeaderContextMenu(event)}
            >
              <div className="min-w-0 flex-1">
                <CollapsibleSectionHeader
                  expanded={expanded}
                  size="sidebar"
                  onClick={() => setCollapsedKeys((keys) => toggleKey(keys, section.key))}
                  onMouseDown={preventMouseFocus}
                  accessory={
                    <AgentSectionAccessory
                      count={section.rows.length}
                      running={section.rows.filter(isBusy).length}
                    />
                  }
                >
                  {section.label}
                </CollapsibleSectionHeader>
              </div>
              <button
                type="button"
                aria-label={`Message ${section.label}`}
                title={
                  section.defaultAgent
                    ? `Message ${openBotAgentLabel(section.defaultAgent.name, section.defaultAgent.title)}`
                    : `Message ${section.label}`
                }
                onMouseDown={preventMouseFocus}
                onClick={() => void openDefaultAgent(section.target, section.defaultAgent)}
                className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                <PlusIcon aria-hidden className="size-3.5" />
              </button>
            </div>
            {groups.length > 0 ? (
              <ul className="flex flex-col">
                {groups.flatMap((group) => {
                  const shownChildren = expandedAgents.includes(group.row.key)
                    ? group.children
                    : group.children.filter((child) => isBusy(child) || isActiveRow(child));
                  return [
                    renderLine(group.row, group.children),
                    ...(shownChildren.length > 0
                      ? [
                          <li
                            key={`${group.row.key}:children`}
                            role="presentation"
                            className="list-none ps-3"
                          >
                            <ul role="presentation" className="flex flex-col">
                              {shownChildren.map((child) => renderLine(child))}
                            </ul>
                          </li>,
                        ]
                      : []),
                  ];
                })}
              </ul>
            ) : null}
          </section>
        );
      })}
    </>
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
  /** Side threads nested under this row; a toggle shows them all. */
  childCount: number;
  childrenExpanded: boolean;
  onClick: (row: OpenBotRow, event: SyntheticEvent) => void;
  onContextMenu: (row: OpenBotRow, position: MenuPosition) => void;
  onToggleChildren: (row: OpenBotRow) => void;
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
      {props.childCount > 0 ? (
        <ChildrenToggle
          count={props.childCount}
          expanded={props.childrenExpanded}
          onToggle={() => props.onToggleChildren(row)}
        />
      ) : null}
      {watchOnly ? (
        <span aria-hidden title={WATCH_ONLY} className="flex shrink-0">
          <EyeIcon className="size-3 text-secondary-label" />
        </span>
      ) : null}
      {status !== null ? (
        <span aria-hidden title={status} className="flex shrink-0">
          <CircleDashedIcon className="size-3 text-info-foreground" />
        </span>
      ) : row.lastActiveAt > 0 ? (
        // An agent with no conversation yet has no activity time.
        <span className="shrink-0 tabular-nums text-secondary-label">
          {compactTimeLabel(row.lastActiveAt, props.nowMinute)}
        </span>
      ) : null}
    </>
  );
  const label = [row.title, watchOnly ? "watch-only" : null, status?.toLowerCase() ?? null]
    .filter((part) => part !== null)
    .join(", ");
  const common = {
    title: row.hint,
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
        // Not a <button>: the side-thread toggle nests inside it.
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            props.onClick(row, event);
          }}
          {...common}
        >
          {content}
        </div>
      )}
    </li>
  );
});

/** The subagent rows' chevron and count, for an agent's side threads. */
function ChildrenToggle(props: { count: number; expanded: boolean; onToggle: () => void }) {
  const label = `${props.expanded ? "Hide" : "Show"} ${props.count} ${
    props.count === 1 ? "side thread" : "side threads"
  }`;
  // The row underneath opens on these; the toggle is not part of that.
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-expanded={props.expanded}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onToggle();
            }}
            onPointerDown={stop}
            onDoubleClick={stop}
            onKeyDown={stop}
            className={cn(
              "-ms-1 inline-flex h-3.5 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-[11px] leading-none tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              props.expanded ? "text-foreground/80" : "text-muted-foreground",
            )}
          />
        }
      >
        <ChevronRightIcon aria-hidden className={cn("size-3", props.expanded && "rotate-90")} />
        {props.count}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
