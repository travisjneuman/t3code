/**
 * Hermes shelf above Other Agents, titled with the instance's agent name: the
 * T3 threads running on a Hermes instance merged with the sessions that Hermes
 * holds and T3 has not opened (Discord, cron, the CLI). Pinned sessions first,
 * then the last few days; "Load more" reaches further back and "Show less"
 * returns to the window. Cmd/Ctrl-click and Shift-click select
 * several rows for the right-click actions. Fork add-on: Hermes provider.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ContextMenuItem,
  type EnvironmentId,
  HERMES_DEFAULT_MODEL,
  HERMES_SESSIONS_WINDOW_MS,
  type HermesSessionSummary,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CircleDashedIcon, MinusIcon, PinIcon, PlusIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useSidebar } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useScratchProject } from "../hooks/useScratchProject";
import { useThreadActions } from "../hooks/useThreadActions";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { useThreadShells, waitForThreadShell } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  HermesSessionDetailsCard,
  type HermesSessionDetailsTarget,
} from "./HermesSessionDetailsCard";
import {
  HERMES_DRIVER,
  hermesAgentName,
  hermesInstanceIds,
  hermesSessionsContinue,
  hermesSessionsDelete,
  hermesSessionsList,
  hermesSessionsUpdate,
  runHermes,
  runHermesQuietly,
} from "./hermesSessions";

const EXPANDED_STORAGE_KEY = "t3code:sidebar:hermes-expanded";
const MORE_BUTTON_CLASS =
  "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground";

type MenuAction =
  | "continue"
  | "details"
  | "pin"
  | "unpin"
  | "archive"
  | "delete"
  | "copy-session-id"
  | "refresh"
  | "show-archived";

interface HermesTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

/** One line: a T3 thread, a Hermes session not opened in T3 yet, or both. */
interface HermesRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly session: HermesSessionSummary | null;
  readonly thread: EnvironmentThreadShell | null;
  readonly title: string;
  readonly lastActiveAt: number;
  readonly pinned: boolean;
  readonly running: boolean;
}

interface Listed {
  readonly sessions: ReadonlyArray<HermesSessionSummary>;
  readonly hasMore: boolean;
}

type MenuPosition = { readonly x: number; readonly y: number };

const targetKey = (target: HermesTarget) => `${target.environmentId}\u0000${target.instanceId}`;

function preventMouseFocus(event: MouseEvent) {
  event.preventDefault();
}

function mergeRows(
  target: HermesTarget,
  listed: Listed | undefined,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  activeThreadKey: string | null,
): HermesRow[] {
  const byThreadId = new Map(threads.map((thread) => [thread.id as string, thread]));
  const rows: HermesRow[] = [];
  const claimed = new Set<string>();
  const sessions = listed?.sessions ?? [];
  for (const session of sessions) {
    const thread = session.threadId === null ? undefined : byThreadId.get(session.threadId);
    if (thread !== undefined) claimed.add(thread.id);
    const threadActiveAt = thread === undefined ? 0 : Date.parse(thread.updatedAt);
    rows.push({
      key: `${target.environmentId}\u0000session:${session.id}`,
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      session,
      thread: thread ?? null,
      title: thread?.title ?? session.title,
      lastActiveAt: Math.max(session.lastActiveAt, threadActiveAt),
      pinned: session.pinned,
      running: threadRuntimeIsActive(thread?.runtime),
    });
  }
  // Threads Hermes has not listed: new ones before their first reply lands,
  // or ones past the loaded window. The latter show once "Load more" reaches them.
  const oldestListed = sessions.reduce(
    (oldest, session) => (session.pinned ? oldest : Math.min(oldest, session.lastActiveAt)),
    Date.now() - HERMES_SESSIONS_WINDOW_MS,
  );
  const floor = listed === undefined || listed.hasMore ? oldestListed : 0;
  for (const thread of threads) {
    if (claimed.has(thread.id)) continue;
    const lastActiveAt = Date.parse(thread.updatedAt);
    const key = `${target.environmentId}\u0000thread:${thread.id}`;
    if (lastActiveAt < floor && activeThreadKey !== `${thread.environmentId}\u0000${thread.id}`) {
      continue;
    }
    rows.push({
      key,
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      session: null,
      thread,
      title: thread.title,
      lastActiveAt,
      pinned: false,
      running: threadRuntimeIsActive(thread.runtime),
    });
  }
  return rows;
}

export function HermesSidebarSection() {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useEnvironments();
  const allThreads = useThreadShells();
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const [extra, setExtra] = useState(0);
  const [listed, setListed] = useState<ReadonlyMap<string, Listed>>(new Map());
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectionAnchor = useRef<string | null>(null);
  // Rows whose session is being opened. The ref turns away a repeat click at
  // once; the state shows the row as busy until the thread opens.
  const openingRef = useRef(new Set<string>());
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set());
  // The session whose details card is open, for a row T3 has not opened.
  const [detailsTarget, setDetailsTarget] = useState<HermesSessionDetailsTarget | null>(null);
  const closeDetails = useCallback(() => setDetailsTarget(null), []);
  const nowMinute = useNowMinute();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const { openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const { archiveThread, deleteThread } = useThreadActions();
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
  const targetsKey = useMemo(() => {
    const keys: string[] = [];
    for (const [environmentId, config] of serverConfigs) {
      for (const instanceId of hermesInstanceIds(config)) {
        keys.push(targetKey({ environmentId, instanceId }));
      }
    }
    return keys.join("\n");
  }, [serverConfigs]);
  const targets = useMemo<HermesTarget[]>(
    () =>
      targetsKey === ""
        ? []
        : targetsKey.split("\n").map((key) => {
            const [environmentId, instanceId] = key.split("\u0000");
            return {
              environmentId: environmentId as EnvironmentId,
              instanceId: instanceId as ProviderInstanceId,
            };
          }),
    [targetsKey],
  );

  // Listing waits for the environment's socket; asking earlier only fails with "not connected".
  const connectedKey = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId)
        .join("\n"),
    [environments],
  );

  // One agent name, or "Hermes" when instances disagree.
  const sectionName = useMemo(() => {
    const names = new Set(
      targets.map((target) =>
        hermesAgentName(serverConfigs.get(target.environmentId)?.settings, target.instanceId),
      ),
    );
    return names.size === 1 ? ([...names][0] ?? "Hermes") : "Hermes";
  }, [serverConfigs, targets]);

  const threadsByTarget = useMemo(() => {
    const byTarget = new Map<string, EnvironmentThreadShell[]>();
    const wanted = new Set(targets.map(targetKey));
    for (const thread of allThreads) {
      if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
        continue;
      const key = targetKey({
        environmentId: thread.environmentId,
        instanceId: thread.providerInstanceId,
      });
      if (!wanted.has(key)) continue;
      const list = byTarget.get(key) ?? [];
      list.push(thread);
      byTarget.set(key, list);
    }
    return byTarget;
  }, [allThreads, targets]);

  // A Hermes thread appearing, going or finishing a turn changes what Hermes lists.
  const threadsSignature = useMemo(
    () =>
      [...threadsByTarget.values()]
        .flat()
        .map((thread) => `${thread.id}:${thread.runtime?.status ?? "idle"}`)
        .join(","),
    [threadsByTarget],
  );

  useEffect(() => {
    const connected = new Set(connectedKey.split("\n"));
    const ready = targets.filter((target) => connected.has(target.environmentId));
    if (ready.length === 0) return;
    let cancelled = false;
    void Promise.all(
      ready.map(async (target) => {
        const result = await runHermes(
          hermesSessionsList,
          target.environmentId,
          { instanceId: target.instanceId, extra },
          "Could not list Hermes sessions",
        );
        return [targetKey(target), result] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setListed((previous) => {
        const next = new Map(previous);
        for (const [key, result] of results) if (result !== null) next.set(key, result);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [targets, connectedKey, extra, refreshNonce, threadsSignature]);

  // Sessions from Discord or cron move while T3 is in the background.
  useEffect(() => {
    const onFocus = () => setRefreshNonce((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const rows = useMemo(() => {
    const merged = targets.flatMap((target) =>
      mergeRows(
        target,
        listed.get(targetKey(target)),
        threadsByTarget.get(targetKey(target)) ?? [],
        activeThreadKey,
      ),
    );
    return merged.sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) || right.lastActiveAt - left.lastActiveAt,
    );
  }, [targets, listed, threadsByTarget, activeThreadKey]);
  const hasMore = targets.some((target) => listed.get(targetKey(target))?.hasMore === true);

  // Collapsed, the shelf still lists running sessions, like Other Agents.
  const visibleRows = useMemo(
    () => (expanded ? rows : rows.filter((row) => row.running)),
    [expanded, rows],
  );
  // Shift-click ranges and multi-row actions cover only the rows on screen.
  const rowsRef = useRef(visibleRows);
  rowsRef.current = visibleRows;
  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), []);
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

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

  /**
   * Brings an opened session's thread up to date with what Hermes added since,
   * such as a cron run's tool calls and report. A text-only thread opened
   * before those were imported comes back replaced, so follow it.
   */
  const syncRow = async (row: HermesRow) => {
    if (row.thread === null || row.session === null) return;
    const result = await runHermesQuietly(hermesSessionsContinue, row.environmentId, {
      instanceId: row.instanceId,
      sessionId: row.session.id,
    });
    if (result !== null && result.threadId !== row.thread.id) {
      await openThread(row.environmentId, result.threadId);
    }
  };

  const continueRow = async (row: HermesRow) => {
    if (row.thread !== null) {
      await openThread(row.environmentId, row.thread.id);
      void syncRow(row);
      return;
    }
    if (row.session === null || openingRef.current.has(row.key)) return;
    openingRef.current.add(row.key);
    setOpening(new Set(openingRef.current));
    try {
      const result = await runHermes(
        hermesSessionsContinue,
        row.environmentId,
        { instanceId: row.instanceId, sessionId: row.session.id },
        "Could not open this Hermes session",
      );
      if (result !== null) await openThread(row.environmentId, result.threadId);
    } finally {
      openingRef.current.delete(row.key);
      setOpening(new Set(openingRef.current));
    }
  };

  const startNew = async () => {
    const target = targets[0];
    if (target === undefined) return;
    const project = await openScratchProject(
      target.environmentId,
      "Could not start a Hermes session",
    );
    if (project === null) return;
    const draft = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    if (draft === null) return;
    useComposerDraftStore
      .getState()
      .setModelSelection(
        draft.draftId,
        createModelSelection(target.instanceId, HERMES_DEFAULT_MODEL),
        { explicit: true },
      );
    closeMobileSidebar();
  };

  /** Groups rows by instance, so each call goes to one Hermes server. */
  const byInstance = (subject: ReadonlyArray<HermesRow>) => {
    const groups = new Map<string, { target: HermesTarget; rows: HermesRow[] }>();
    for (const row of subject) {
      const key = targetKey(row);
      const group = groups.get(key) ?? { target: row, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.values()];
  };

  const reportRefused = (verb: string, refused: ReadonlyArray<{ message: string }>) => {
    if (refused.length === 0) return;
    toastManager.add({
      type: "error",
      title: `Could not ${verb} ${refused.length} session${refused.length === 1 ? "" : "s"}`,
      description: refused[0]?.message,
    });
  };

  const updateSessions = async (
    subject: ReadonlyArray<HermesRow>,
    patch: { pinned?: boolean; archived?: true },
    verb: string,
  ) => {
    for (const { target, rows: group } of byInstance(subject)) {
      const sessions = group.flatMap((row) =>
        row.session === null ? [] : [{ id: row.session.id, title: row.title }],
      );
      if (sessions.length === 0) continue;
      const [first, ...rest] = sessions;
      const result = await runHermes(
        hermesSessionsUpdate,
        target.environmentId,
        { instanceId: target.instanceId, sessions: [first!, ...rest], ...patch },
        `Could not ${verb}`,
      );
      if (result !== null) reportRefused(verb, result.refused);
    }
  };

  const archiveRows = async (subject: ReadonlyArray<HermesRow>) => {
    await updateSessions(subject, { archived: true }, "archive");
    // A thread Hermes has not listed yet has no session to archive there.
    for (const row of subject) {
      if (row.session === null && row.thread !== null) {
        await archiveThread(scopeThreadRef(row.environmentId, row.thread.id));
      }
    }
  };

  const deleteRows = async (subject: ReadonlyArray<HermesRow>) => {
    const api = readLocalApi();
    if (api === undefined) return;
    const count = subject.length;
    const confirmed = await api.dialogs
      .confirm(
        [
          count === 1
            ? `Delete "${subject[0]?.title ?? "this session"}"?`
            : `Delete ${count} Hermes sessions?`,
          "This deletes the session in Hermes and its T3 thread. It cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      )
      .catch(() => false);
    if (!confirmed) return;
    for (const { target, rows: group } of byInstance(subject)) {
      const ids = group.flatMap((row) => (row.session === null ? [] : [row.session.id]));
      const [first, ...rest] = ids;
      if (first !== undefined) {
        const result = await runHermes(
          hermesSessionsDelete,
          target.environmentId,
          { instanceId: target.instanceId, sessionIds: [first, ...rest] },
          "Could not delete",
        );
        if (result !== null) reportRefused("delete", result.refused);
      }
    }
    for (const row of subject) {
      if (row.session === null && row.thread !== null) {
        await deleteThread(scopeThreadRef(row.environmentId, row.thread.id));
      }
    }
  };

  const showArchived = async () => {
    closeMobileSidebar();
    await navigate({ to: "/settings/archived" });
  };

  const showRowMenu = async (row: HermesRow, position: MenuPosition, anchor: Element) => {
    const api = readLocalApi();
    if (api === undefined) return;
    const subject = selected.has(row.key)
      ? rowsRef.current.filter((candidate) => selected.has(candidate.key))
      : [row];
    const withSession = subject.filter((candidate) => candidate.session !== null);
    const count = subject.length;
    const suffix = count > 1 ? ` (${count})` : "";
    const anyRunning = subject.some((candidate) => candidate.running);
    const items: Array<ContextMenuItem<MenuAction>> = [];
    const unopened = subject.filter((candidate) => candidate.thread === null);
    if (count === 1 || unopened.length > 0) {
      items.push({
        id: "continue",
        label: count === 1 && row.thread !== null ? "Open" : `Continue in T3${suffix}`,
        icon: "message-square-plus",
      });
    }
    // An unopened session's details, without importing it.
    if (count === 1 && row.thread === null && row.session !== null) {
      items.push({ id: "details", label: "Details" });
    }
    if (withSession.length > 0) {
      const allPinned = withSession.every((candidate) => candidate.pinned);
      items.push({
        id: allPinned ? "unpin" : "pin",
        label: `${allPinned ? "Unpin" : "Pin"}${suffix}`,
        icon: allPinned ? "pin-off" : "pin",
      });
      items.push({ id: "copy-session-id", label: "Copy session ID", icon: "hash" });
    }
    items.push({
      id: "archive",
      label: `Archive${suffix}`,
      icon: "archive",
      separatorBefore: true,
      disabled: anyRunning,
    });
    items.push({
      id: "delete",
      label: `Delete${suffix}`,
      icon: "trash",
      destructive: true,
      disabled: anyRunning,
    });

    const clicked = await api.contextMenu.show(items, position);
    switch (clicked) {
      case "continue":
        if (count === 1) await continueRow(row);
        else for (const candidate of unopened) await continueRow(candidate);
        break;
      case "details":
        if (row.session !== null) {
          setDetailsTarget({
            environmentId: row.environmentId,
            instanceId: row.instanceId,
            session: row.session,
            agentName: hermesAgentName(
              serverConfigs.get(row.environmentId)?.settings,
              row.instanceId,
            ),
            anchor,
          });
        }
        return;
      case "pin":
      case "unpin":
        await updateSessions(withSession, { pinned: clicked === "pin" }, clicked);
        break;
      case "archive":
        await archiveRows(subject);
        break;
      case "delete":
        await deleteRows(subject);
        break;
      case "copy-session-id":
        copyToClipboard(withSession.map((candidate) => candidate.session!.id).join("\n"), {
          title: withSession.length === 1 ? "Session ID copied" : "Session IDs copied",
        });
        return;
      default:
        return;
    }
    setSelected(new Set());
    refresh();
  };

  // Rows are memoized, so they get stable callbacks that run the latest handlers.
  const handlers = useRef({ showRowMenu, continueRow, syncRow });
  handlers.current = { showRowMenu, continueRow, syncRow };
  const handleContextMenu = useCallback(
    (row: HermesRow, position: MenuPosition, anchor: Element) => {
      void handlers.current.showRowMenu(row, position, anchor);
    },
    [],
  );
  const handleClick = useCallback(
    (row: HermesRow, event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        setSelected((previous) => {
          const next = new Set(previous);
          if (next.has(row.key)) next.delete(row.key);
          else next.add(row.key);
          return next;
        });
        selectionAnchor.current = row.key;
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        const keys = rowsRef.current.map((candidate) => candidate.key);
        const from = keys.indexOf(selectionAnchor.current ?? row.key);
        const to = keys.indexOf(row.key);
        const [start, end] = from <= to ? [from, to] : [to, from];
        setSelected(new Set(keys.slice(Math.max(start, 0), end + 1)));
        return;
      }
      setSelected(new Set());
      selectionAnchor.current = row.key;
      if (row.thread === null) {
        event.preventDefault();
        void handlers.current.continueRow(row);
      } else {
        closeMobileSidebar();
        void handlers.current.syncRow(row);
      }
    },
    [closeMobileSidebar],
  );

  const handleHeaderContextMenu = async (event: MouseEvent) => {
    const api = readLocalApi();
    if (api === undefined) return;
    event.preventDefault();
    const clicked = await api.contextMenu.show<MenuAction>(
      [
        { id: "refresh", label: "Refresh", icon: "refresh-cw" },
        { id: "show-archived", label: "Show archived sessions", icon: "archive" },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "refresh") refresh();
    if (clicked === "show-archived") await showArchived();
  };

  if (targets.length === 0) return null;
  const runningCount = rows.filter((row) => row.running).length;

  return (
    <section aria-label={sectionName} className="mt-2">
      <div
        className="@container/hermes mx-0.5 flex h-8 items-center gap-0.5"
        onContextMenu={(event) => void handleHeaderContextMenu(event)}
      >
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            onMouseDown={preventMouseFocus}
            accessory={
              runningCount > 0 ? (
                <span
                  title={`${runningCount} active`}
                  className="inline-flex shrink-0 items-center gap-1 text-info tabular-nums"
                >
                  <CircleDashedIcon aria-hidden className="size-3 shrink-0" />
                  {runningCount}
                </span>
              ) : null
            }
          >
            {`${sectionName} (${rows.length})`}
          </CollapsibleSectionHeader>
        </div>
        <button
          type="button"
          aria-label={`New ${sectionName} session`}
          title={`New ${sectionName} session`}
          onMouseDown={preventMouseFocus}
          onClick={() => void startNew()}
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <PlusIcon aria-hidden className="size-3.5" />
        </button>
      </div>
      {expanded || visibleRows.length > 0 ? (
        <ul className="flex flex-col">
          {visibleRows.map((row) => (
            <HermesLine
              key={row.key}
              row={row}
              isActive={
                row.thread !== null &&
                activeThreadKey === `${row.environmentId}\u0000${row.thread.id}`
              }
              isSelected={selected.has(row.key)}
              isOpening={opening.has(row.key)}
              nowMinute={nowMinute}
              onClick={handleClick}
              onContextMenu={handleContextMenu}
            />
          ))}
          {expanded && hasMore ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() => setExtra((value) => value + 1)}
                className={MORE_BUTTON_CLASS}
              >
                <PlusIcon aria-hidden className="size-3.5 shrink-0" />
                Load more
              </button>
            </li>
          ) : null}
          {expanded && extra > 0 ? (
            <li className="list-none">
              <button type="button" onClick={() => setExtra(0)} className={MORE_BUTTON_CLASS}>
                <MinusIcon aria-hidden className="size-3.5 shrink-0" />
                Show less
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {detailsTarget !== null ? (
        <HermesSessionDetailsCard target={detailsTarget} onClose={closeDetails} />
      ) : null}
    </section>
  );
}

/** Matches the thread rows' short relative time: "5m", "now". */
function compactTimeLabel(ms: number): string {
  const label = formatRelativeTimeLabel(new Date(ms).toISOString());
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/**
 * One Hermes row: glyph, title, then a pin, a running spinner or its age.
 * Sessions T3 has not opened recede like settled threads. `nowMinute` only
 * refreshes the age once a minute.
 */
const HermesLine = memo(function HermesLine(props: {
  row: HermesRow;
  isActive: boolean;
  isSelected: boolean;
  /** Its session is being opened in T3. */
  isOpening: boolean;
  nowMinute: string;
  onClick: (row: HermesRow, event: MouseEvent) => void;
  onContextMenu: (row: HermesRow, position: MenuPosition, anchor: Element) => void;
}) {
  const { row } = props;
  const source = row.session?.source;
  const status = row.running ? "Running" : props.isOpening ? "Opening" : null;
  const className = cn(
    "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    props.isActive || props.isSelected
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : row.thread === null
        ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        : "text-sidebar-foreground hover:bg-sidebar-row-hover",
  );
  const content = (
    <>
      <ProviderInstanceIcon
        driverKind={HERMES_DRIVER}
        displayName="Hermes"
        className="size-3.5 shrink-0"
        iconClassName="size-3.5"
      />
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {status !== null ? (
        <span aria-hidden title={status} className="flex shrink-0">
          <CircleDashedIcon className="size-3.5 text-info" />
        </span>
      ) : (
        <>
          {row.pinned ? <PinIcon aria-label="Pinned" className="size-3 shrink-0" /> : null}
          <span className="shrink-0 tabular-nums text-secondary-label">
            {compactTimeLabel(row.lastActiveAt)}
          </span>
        </>
      )}
    </>
  );
  const common = {
    title: source && source !== "api_server" ? `${row.title} · ${source}` : row.title,
    // The status glyph is aria-hidden, so the row's name carries it instead.
    "aria-label": status !== null ? `${row.title}, ${status.toLowerCase()}` : undefined,
    "aria-current": props.isActive ? ("page" as const) : undefined,
    "aria-selected": props.isSelected || undefined,
    "aria-busy": props.isOpening || undefined,
    onClick: (event: MouseEvent) => props.onClick(row, event),
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      props.onContextMenu(row, { x: event.clientX, y: event.clientY }, event.currentTarget);
    },
    className,
  };
  return (
    <li className="list-none py-px">
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
