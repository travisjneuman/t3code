/**
 * Hermes shelf above Other Agents, titled with the instance's agent name: the
 * T3 threads running on a Hermes instance merged with the sessions that Hermes
 * holds and T3 has not opened (Discord, cron, the CLI). Pinned sessions first,
 * then the last few days; "Load more" reaches further back and "Show less"
 * returns to the window. Subagents Hermes started sit indented under their
 * parent. Cmd/Ctrl-click and Shift-click select several rows for the
 * right-click actions. Fork add-on: Hermes provider.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
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
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { CircleDashedIcon, MinusIcon, PinIcon, PlusIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type MouseEvent } from "react";

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
import { useStableCallback } from "../hooks/useStableCallback";
import { useThreadActions } from "../hooks/useThreadActions";
import { cn } from "../lib/utils";
import {
  AGENT_LINE_CLASS,
  AGENT_LINE_ICON_CLASS,
  AGENT_MORE_BUTTON_CLASS,
} from "../sidebar-compact/agentLines";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForThreadShell } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentThreadShells } from "../state/threads";
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

type MenuAction =
  | "continue"
  | "details"
  | "pin"
  | "unpin"
  | "archive"
  | "delete"
  | "copy-session-id"
  | "clear-selection"
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
  /** A subagent's parent row. */
  readonly parentKey: string | null;
}

interface Listed {
  readonly sessions: ReadonlyArray<HermesSessionSummary>;
  readonly hasMore: boolean;
}

type MenuPosition = { readonly x: number; readonly y: number };

const targetKey = (target: HermesTarget) => `${target.environmentId}\u0000${target.instanceId}`;

function targetsFromKey(key: string): HermesTarget[] {
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

/**
 * The rows whose connection may run `command`, reading each environment's grant
 * once. Menus read this when they open, so rows stay free of permission atoms.
 */
function permittedRows(
  rows: ReadonlyArray<HermesRow>,
  command: { readonly permissionAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean> },
): HermesRow[] {
  const granted = new Map<EnvironmentId, boolean>();
  return rows.filter((row) => {
    let allowed = granted.get(row.environmentId);
    if (allowed === undefined) {
      allowed = appAtomRegistry.get(command.permissionAtom(row.environmentId));
      granted.set(row.environmentId, allowed);
    }
    return allowed;
  });
}

/** What the last applied listing run asked for, per instance thread signature. */
interface LastListing {
  readonly targetsKey: string;
  readonly connectedKey: string;
  readonly extra: number;
  readonly refreshNonce: number;
  readonly signatures: ReadonlyMap<string, string>;
}

// Ids never hold control characters, so this splits a target key from its threads.
const SIGNATURE_SEPARATOR = "\u0001";

function parseSignatures(signature: string): ReadonlyMap<string, string> {
  const signatures = new Map<string, string>();
  for (const line of signature === "" ? [] : signature.split("\n")) {
    const at = line.indexOf(SIGNATURE_SEPARATOR);
    signatures.set(line.slice(0, at), line.slice(at + 1));
  }
  return signatures;
}

function preventMouseFocus(event: MouseEvent) {
  event.preventDefault();
}

/** Exact for rows and session summaries, whose fields are all scalars or kept references. */
function sameFields<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as Array<keyof T>;
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/**
 * The unarchived top-level threads of the Hermes instances in `targetsKey`.
 * It keeps the previous array while none of them changed, so updates to other
 * threads do not re-render the shelf.
 */
const hermesThreadsAtom = Atom.family((targetsKey: string) => {
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
  }).pipe(Atom.withLabel(`hermes-sidebar-threads:${targetsKey}`));
});

/**
 * A fresh listing that reuses the previous summary objects it repeats, and the
 * previous listing when nothing changed, so a refetch re-renders only the rows
 * whose sessions moved.
 */
function keepListed(previous: Listed | undefined, next: Listed): Listed {
  if (previous === undefined) return next;
  const before = new Map(previous.sessions.map((session) => [session.id, session]));
  const sessions = next.sessions.map((session) => {
    const kept = before.get(session.id);
    return kept !== undefined && sameFields(kept, session) ? kept : session;
  });
  return previous.hasMore === next.hasMore && arrayElementsEqual(previous.sessions, sessions)
    ? previous
    : { sessions, hasMore: next.hasMore };
}

/**
 * Hands back the previous row object for each row whose fields are unchanged,
 * and the previous array when every row is, so memoized lines skip rendering.
 * Reuse only ever swaps in an equal value, so a render React throws away
 * leaves nothing stale behind.
 */
function createRowKeeper() {
  let previous: ReadonlyArray<HermesRow> = [];
  return (next: ReadonlyArray<HermesRow>): ReadonlyArray<HermesRow> => {
    const before = new Map(previous.map((row) => [row.key, row]));
    const rows = next.map((row) => {
      const kept = before.get(row.key);
      return kept !== undefined && sameFields(kept, row) ? kept : row;
    });
    if (arrayElementsEqual(previous, rows)) return previous;
    previous = rows;
    return rows;
  };
}

function mergeRows(
  target: HermesTarget,
  listed: Listed | undefined,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  activeThreadKey: string | null,
  now: number,
): HermesRow[] {
  const byThreadId = new Map(threads.map((thread) => [thread.id as string, thread]));
  const rows: HermesRow[] = [];
  const claimed = new Set<string>();
  const sessions = listed?.sessions ?? [];
  const sessionKey = (id: string) => `${target.environmentId}\u0000session:${id}`;
  for (const session of sessions) {
    const thread = session.threadId === null ? undefined : byThreadId.get(session.threadId);
    if (thread !== undefined) claimed.add(thread.id);
    const threadActiveAt = thread === undefined ? 0 : Date.parse(thread.updatedAt);
    rows.push({
      key: sessionKey(session.id),
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      session,
      thread: thread ?? null,
      title: thread?.title ?? session.title,
      lastActiveAt: Math.max(session.lastActiveAt, threadActiveAt),
      pinned: session.pinned,
      running: threadRuntimeIsActive(thread?.runtime),
      parentKey: session.parentSessionId === undefined ? null : sessionKey(session.parentSessionId),
    });
  }
  // Threads Hermes has not listed: new ones before their first reply lands,
  // or ones past the loaded window. The latter show once "Load more" reaches them.
  const oldestListed = sessions.reduce(
    (oldest, session) =>
      session.pinned || session.parentSessionId !== undefined
        ? oldest
        : Math.min(oldest, session.lastActiveAt),
    now - HERMES_SESSIONS_WINDOW_MS,
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
      parentKey: null,
    });
  }
  return rows;
}

const newestFirst = (left: HermesRow, right: HermesRow) => right.lastActiveAt - left.lastActiveAt;

/**
 * Pinned rows first, then newest, each followed by its subagents. A subagent
 * whose parent is not listed is left out.
 */
function nestRows(rows: ReadonlyArray<HermesRow>): HermesRow[] {
  const topLevel: HermesRow[] = [];
  const childrenOf = new Map<string, HermesRow[]>();
  for (const row of rows) {
    if (row.parentKey === null) {
      topLevel.push(row);
      continue;
    }
    const children = childrenOf.get(row.parentKey) ?? [];
    children.push(row);
    childrenOf.set(row.parentKey, children);
  }
  topLevel.sort(
    (left, right) => Number(right.pinned) - Number(left.pinned) || newestFirst(left, right),
  );
  return topLevel.flatMap((row) => [row, ...(childrenOf.get(row.key)?.sort(newestFirst) ?? [])]);
}

export function HermesSidebarSection() {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useEnvironments();
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const [extra, setExtra] = useState(0);
  const [listed, setListed] = useState<ReadonlyMap<string, Listed>>(new Map());
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [keepRows] = useState(createRowKeeper);
  const lastListingRef = useRef<LastListing | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectionAnchor = useRef<string | null>(null);
  // Rows whose session is being opened. The ref turns away a repeat click at
  // once; the state shows the row as busy until the thread opens.
  const openingRef = useRef(new Set<string>());
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set());
  // The session whose details card is open, for a row T3 has not opened.
  const [detailsTarget, setDetailsTarget] = useState<HermesSessionDetailsTarget | null>(null);
  const closeDetails = () => setDetailsTarget(null);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
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
  const targetsKey = (() => {
    const keys: string[] = [];
    for (const [environmentId, config] of serverConfigs) {
      for (const instanceId of hermesInstanceIds(config)) {
        keys.push(targetKey({ environmentId, instanceId }));
      }
    }
    return keys.join("\n");
  })();
  const targets = targetsFromKey(targetsKey);
  const hermesThreads = useAtomValue(hermesThreadsAtom(targetsKey));

  // Listing waits for the environment's socket; asking earlier only fails with "not connected".
  const connectedKey = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId)
    .join("\n");

  // One agent name, or "Hermes" when instances disagree.
  const sectionName = (() => {
    const names = new Set(
      targets.map((target) =>
        hermesAgentName(serverConfigs.get(target.environmentId)?.settings, target.instanceId),
      ),
    );
    return names.size === 1 ? ([...names][0] ?? "Hermes") : "Hermes";
  })();

  const threadsByTarget = (() => {
    const byTarget = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of hermesThreads) {
      const key = targetKey({
        environmentId: thread.environmentId,
        instanceId: thread.providerInstanceId,
      });
      const list = byTarget.get(key) ?? [];
      list.push(thread);
      byTarget.set(key, list);
    }
    return byTarget;
  })();

  // A Hermes thread appearing, going or finishing a turn changes what Hermes
  // lists, per instance, so one thread's turn relists only its own instance.
  const threadsSignature = targets
    .map((target) => {
      const key = targetKey(target);
      const threads = (threadsByTarget.get(key) ?? [])
        .map((thread) => `${thread.id}:${thread.runtime?.status ?? "idle"}`)
        .join(",");
      return `${key}${SIGNATURE_SEPARATOR}${threads}`;
    })
    .join("\n");

  useEffect(() => {
    const signatures = parseSignatures(threadsSignature);
    const last = lastListingRef.current;
    // Focus, Refresh, Load more and target or connection changes list every
    // instance; a thread change alone lists only the instances it touched.
    const threadsOnlySignatures =
      last !== null &&
      last.targetsKey === targetsKey &&
      last.connectedKey === connectedKey &&
      last.extra === extra &&
      last.refreshNonce === refreshNonce
        ? last.signatures
        : null;
    const connected = new Set(connectedKey.split("\n"));
    const ready = targetsFromKey(targetsKey).filter((target) => {
      if (!connected.has(target.environmentId)) return false;
      const key = targetKey(target);
      return (
        threadsOnlySignatures === null || threadsOnlySignatures.get(key) !== signatures.get(key)
      );
    });
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
      // Recorded only once applied, so a run cut short is compared against
      // again. A failed instance drops its signature and is retried next time.
      const listedSignatures = new Map<string, string>(threadsOnlySignatures ?? []);
      for (const [key, result] of results) {
        const signature = signatures.get(key);
        if (result === null || signature === undefined) listedSignatures.delete(key);
        else listedSignatures.set(key, signature);
      }
      lastListingRef.current = {
        targetsKey,
        connectedKey,
        extra,
        refreshNonce,
        signatures: listedSignatures,
      };
      // Unchanged listings keep the previous state, so React skips the render.
      setListed((previous) => {
        let next: Map<string, Listed> | null = null;
        for (const [key, result] of results) {
          if (result === null) continue;
          const kept = keepListed(previous.get(key), result);
          if (kept === previous.get(key)) continue;
          next ??= new Map(previous);
          next.set(key, kept);
        }
        return next ?? previous;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [targetsKey, connectedKey, extra, refreshNonce, threadsSignature]);

  // Sessions from Discord or cron move while T3 is in the background.
  useEffect(() => {
    const onFocus = () => setRefreshNonce((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const rows = keepRows(
    nestRows(
      targets.flatMap((target) =>
        mergeRows(
          target,
          listed.get(targetKey(target)),
          threadsByTarget.get(targetKey(target)) ?? [],
          activeThreadKey,
          now,
        ),
      ),
    ),
  );
  const hasMore = targets.some((target) => listed.get(targetKey(target))?.hasMore === true);

  // Collapsed, the shelf still lists running sessions, like Other Agents.
  const visibleRows = expanded ? rows : rows.filter((row) => row.running);
  // Collapsed, a running subagent may show without its parent; it is not indented then.
  const visibleKeys = new Set(visibleRows.map((row) => row.key));
  const refresh = () => setRefreshNonce((value) => value + 1);
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

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
    if (permittedRows([row], hermesSessionsContinue).length === 0) return;
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
    if (permittedRows([row], hermesSessionsContinue).length === 0) {
      toastManager.add({
        type: "info",
        title: "Cannot open this Hermes session",
        description: "Needs operate access on this connection.",
      });
      return;
    }
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
      ? visibleRows.filter((candidate) => selected.has(candidate.key))
      : [row];
    const withSession = subject.filter((candidate) => candidate.session !== null);
    const count = subject.length;
    const suffix = count > 1 ? ` (${count})` : "";
    const anyRunning = subject.some((candidate) => candidate.running);
    const items: Array<ContextMenuItem<MenuAction>> = [];
    // Hermes calls show only where the connection may make them; Open and Copy need none.
    const unopened = permittedRows(
      subject.filter((candidate) => candidate.thread === null),
      hermesSessionsContinue,
    );
    const updatable = permittedRows(withSession, hermesSessionsUpdate);
    const deletable = permittedRows(withSession, hermesSessionsDelete);
    const updatableKeys = new Set(updatable.map((candidate) => candidate.key));
    const deletableKeys = new Set(deletable.map((candidate) => candidate.key));
    // A thread Hermes has not listed yet is archived or deleted in T3 alone.
    const archivable = subject.filter(
      (candidate) => candidate.session === null || updatableKeys.has(candidate.key),
    );
    const removable = subject.filter(
      (candidate) => candidate.session === null || deletableKeys.has(candidate.key),
    );
    if ((count === 1 && row.thread !== null) || unopened.length > 0) {
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
    // A mixed selection gets both, each counting the sessions it changes.
    const pinnable = updatable.filter((candidate) => !candidate.pinned);
    const unpinnable = updatable.filter((candidate) => candidate.pinned);
    const countOf = (rows: ReadonlyArray<HermesRow>) => (count > 1 ? ` (${rows.length})` : "");
    if (pinnable.length > 0) {
      items.push({ id: "pin", label: `Pin${countOf(pinnable)}`, icon: "pin" });
    }
    if (unpinnable.length > 0) {
      items.push({ id: "unpin", label: `Unpin${countOf(unpinnable)}`, icon: "pin-off" });
    }
    if (withSession.length > 0) {
      items.push({
        id: "copy-session-id",
        label:
          withSession.length > 1 ? `Copy session IDs (${withSession.length})` : "Copy session ID",
        icon: "hash",
      });
    }
    if (archivable.length > 0) {
      items.push({
        id: "archive",
        label: `Archive${suffix}`,
        icon: "archive",
        separatorBefore: true,
        disabled: anyRunning,
      });
    }
    if (removable.length > 0) {
      items.push({
        id: "delete",
        label: `Delete${suffix}`,
        icon: "trash",
        destructive: true,
        disabled: anyRunning,
        separatorBefore: archivable.length === 0,
      });
    }
    if (count > 1) {
      items.push({ id: "clear-selection", label: "Clear selection", separatorBefore: true });
    }

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
        await updateSessions(
          clicked === "pin" ? pinnable : unpinnable,
          { pinned: clicked === "pin" },
          clicked,
        );
        break;
      case "archive":
        await archiveRows(archivable);
        break;
      case "delete":
        await deleteRows(removable);
        break;
      case "copy-session-id":
        copyToClipboard(withSession.map((candidate) => candidate.session!.id).join("\n"), {
          title: withSession.length === 1 ? "Session ID copied" : "Session IDs copied",
        });
        return;
      case "clear-selection":
        setSelected(new Set());
        return;
      default:
        return;
    }
    setSelected(new Set());
    refresh();
  };

  // Rows are memoized, so they get stable callbacks that run the latest handlers.
  const handleContextMenu = useStableCallback(
    (row: HermesRow, position: MenuPosition, anchor: Element) => {
      void showRowMenu(row, position, anchor);
    },
  );
  const handleClick = useStableCallback((row: HermesRow, event: MouseEvent) => {
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
      // Shift-click ranges cover only the rows on screen.
      const keys = visibleRows.map((candidate) => candidate.key);
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
      void continueRow(row);
    } else {
      closeMobileSidebar();
      void syncRow(row);
    }
  });

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
    <section aria-label={sectionName} className="mt-1">
      <div
        className="@container/hermes mx-0.5 flex h-5 items-center gap-0.5"
        onContextMenu={(event) => void handleHeaderContextMenu(event)}
      >
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={expanded}
            size="sidebar"
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
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
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
              isNested={row.parentKey !== null && visibleKeys.has(row.parentKey)}
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
                className={AGENT_MORE_BUTTON_CLASS}
              >
                <PlusIcon aria-hidden className={AGENT_LINE_ICON_CLASS} />
                Load more
              </button>
            </li>
          ) : null}
          {expanded && extra > 0 ? (
            <li className="list-none">
              <button type="button" onClick={() => setExtra(0)} className={AGENT_MORE_BUTTON_CLASS}>
                <MinusIcon aria-hidden className={AGENT_LINE_ICON_CLASS} />
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
function compactTimeLabel(ms: number, nowMinute: string): string {
  const label = formatRelativeTimeLabel(new Date(ms).toISOString(), Date.parse(`${nowMinute}:00Z`));
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
  /** A subagent shown under its parent row. */
  isNested: boolean;
  nowMinute: string;
  onClick: (row: HermesRow, event: MouseEvent) => void;
  onContextMenu: (row: HermesRow, position: MenuPosition, anchor: Element) => void;
}) {
  const { row } = props;
  const source = row.session?.source;
  const status = row.running ? "Running" : props.isOpening ? "Opening" : null;
  const className = cn(
    AGENT_LINE_CLASS,
    "px-(--sidebar-row-content-inset)",
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
        className={AGENT_LINE_ICON_CLASS}
        iconClassName="size-3"
      />
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {status !== null ? (
        <span aria-hidden title={status} className="flex shrink-0">
          <CircleDashedIcon className="size-3 text-info" />
        </span>
      ) : (
        <>
          {row.pinned ? <PinIcon aria-label="Pinned" className="size-3 shrink-0" /> : null}
          <span className="shrink-0 tabular-nums text-secondary-label">
            {compactTimeLabel(row.lastActiveAt, props.nowMinute)}
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
    <li className={cn("list-none", props.isNested && "pl-3")}>
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
