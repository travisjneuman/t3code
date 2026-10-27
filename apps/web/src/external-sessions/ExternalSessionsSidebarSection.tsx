import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORS,
  externalSessionDeletable,
  externalSessionOpensInOrigin,
  externalSessionUnsupportedReason,
  type ContextMenuItem,
  type EditorId,
  type EnvironmentId,
  type ExternalSessionSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CircleDashedIcon, ClockIcon, FolderIcon, MonitorIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type MouseEvent } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../components/ThreadHoverCard";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { MiddleTruncate } from "../components/ui/middle-truncate";
import { useSidebar } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  useLocalStorage,
} from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn, isMacPlatform } from "../lib/utils";
import {
  AGENT_LINE_ACTIVE_CLASS,
  AGENT_LINE_CLASS,
  AGENT_LINE_ICON_CLASS,
  AGENT_LINE_SELECTED_CLASS,
  AGENT_MORE_BUTTON_CLASS,
} from "../sidebar-compact/agentLines";
import { AgentMoreIcon, AgentSectionAccessory } from "../sidebar-compact/AgentSectionParts";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  cwdBasename,
  externalSessionArchive,
  externalSessionContinue,
  externalSessionDelete,
  externalSessionEntriesAtom,
  externalSessionHostLabelsAtom,
  externalSessionListCutsAtom,
  externalSessionListOlder,
  externalSessionOpenInOrigin,
  externalSessionOriginIsLocalAtom,
  externalSessionOriginLabel,
  externalSessionProductName,
  externalSessionTitle,
  LIVENESS_LABEL,
  shortModelLabel,
  type ExternalSessionEntry,
  type ExternalSessionListCut,
} from "./atoms";

const EXPANDED_STORAGE_KEY = "t3code:sidebar:external-sessions-expanded";
/** The expanded shelf first shows sessions that moved within this long. */
const FIRST_VIEW_MS = 3 * 24 * 60 * 60 * 1000;
/** Rows each Load more reveals. */
const LOAD_MORE_ROWS = 10;

/** Per-browser "Hide from list" keys from before archive; archived once, then removed. */
const LEGACY_HIDDEN_STORAGE_KEY = "t3code:sidebar:external-sessions-hidden:v1";
const LegacyHiddenKeysSchema = Schema.Array(Schema.String);

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

type RowMenuAction =
  | "continue"
  | "open-origin"
  | "copy-session-id"
  | "copy-path"
  | "open-folder"
  | "open-with"
  | `editor:${EditorId}`
  | "archive"
  | "delete"
  | "show-archived";

/** The row menu's actions, each over every selected row it applies to. */
type SelectionMenuAction =
  | "continue"
  | `open-origin:${string}`
  | "copy-session-ids"
  | "copy-paths"
  | "open-folders"
  | "open-with"
  | `editor:${EditorId}`
  | "archive"
  | "delete"
  | "clear-selection";

type MenuPosition = { readonly x: number; readonly y: number };

function isReportedFailure(result: Parameters<typeof isAtomCommandInterrupted>[0]): boolean {
  return result._tag === "Failure" && !isAtomCommandInterrupted(result);
}

function reportBulkFailures(verb: string, failed: number) {
  if (failed === 0) return;
  toastManager.add({
    type: "error",
    title: `Could not ${verb} ${failed} session${failed === 1 ? "" : "s"}`,
  });
}

/** One entry per distinct folder on each environment. */
function distinctFolders(
  entries: ReadonlyArray<ExternalSessionEntry>,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly cwd: string }> {
  const seen = new Set<string>();
  return entries.flatMap(({ environmentId, session: { cwd } }) => {
    if (cwd === null || seen.has(rowKey(environmentId, cwd))) return [];
    seen.add(rowKey(environmentId, cwd));
    return [{ environmentId, cwd }];
  });
}

function rowKey(environmentId: string, sessionKey: string): string {
  return `${environmentId}\u0000${sessionKey}`;
}

/** Cmd/Ctrl-click toggles a row, Shift-click selects from the anchor, as in the thread list. */
interface RowSelection {
  readonly keys: ReadonlySet<string>;
  readonly anchor: string | null;
}

const NO_SELECTED_KEYS: ReadonlySet<string> = new Set();

function toggleSelected(selection: RowSelection, key: string): RowSelection {
  const keys = new Set(selection.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { keys, anchor: keys.has(key) ? key : selection.anchor };
}

/** Adds the shown rows between the anchor and `key`; without a shown anchor, just `key`. */
function selectRangeTo(
  selection: RowSelection,
  key: string,
  shownKeys: ReadonlyArray<string>,
): RowSelection {
  const keys = new Set(selection.keys);
  const anchorIndex = selection.anchor === null ? -1 : shownKeys.indexOf(selection.anchor);
  const targetIndex = shownKeys.indexOf(key);
  if (anchorIndex === -1 || targetIndex === -1) {
    keys.add(key);
    return { keys, anchor: key };
  }
  for (const shownKey of shownKeys.slice(
    Math.min(anchorIndex, targetIndex),
    Math.max(anchorIndex, targetIndex) + 1,
  )) {
    keys.add(shownKey);
  }
  return { keys, anchor: selection.anchor };
}

function clearSelected(selection: RowSelection): RowSelection {
  if (selection.keys.size === 0) return selection;
  return { keys: NO_SELECTED_KEYS, anchor: selection.anchor };
}

/**
 * Keeps a mouse click from focusing the section's buttons, so their focus ring
 * shows only for keyboard focus.
 */
function preventMouseFocus(event: MouseEvent) {
  event.preventDefault();
}

/** The first `count` entries, plus the open session when it falls past them. */
function firstWithOpen(
  entries: ReadonlyArray<ExternalSessionEntry>,
  count: number,
  activeKey: string | null,
): ReadonlyArray<ExternalSessionEntry> {
  if (count >= entries.length) return entries;
  const open = entries
    .slice(count)
    .find((entry) => rowKey(entry.environmentId, entry.session.key) === activeKey);
  const shown = entries.slice(0, count);
  return open === undefined ? shown : [...shown, open];
}

/**
 * A host's sessions past its live list's cut, paged in by Load more. The first
 * page also keeps the live rows it continued from, so a row that later ages out
 * of the live list does not fall into a gap.
 */
interface OlderPages {
  /** In the server's list order, newest first. */
  readonly entries: ReadonlyArray<ExternalSessionEntry>;
  readonly more: boolean;
  readonly loading: boolean;
  /** The last read failed; only another Load more click retries it. */
  readonly failed: boolean;
}

const NO_OLDER_PAGES: ReadonlyMap<EnvironmentId, OlderPages> = new Map();

function updatedAtMs(entry: ExternalSessionEntry): number {
  const parsed = Date.parse(entry.session.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The live entries plus the paged-in older ones they do not already hold,
 * newest first. A session that ran again since its page was read is live.
 */
function withOlderEntries(
  entries: ReadonlyArray<ExternalSessionEntry>,
  older: ReadonlyArray<ExternalSessionEntry>,
): ReadonlyArray<ExternalSessionEntry> {
  if (older.length === 0) return entries;
  const seen = new Set(entries.map((entry) => rowKey(entry.environmentId, entry.session.key)));
  const extra = older.filter((entry) => {
    const key = rowKey(entry.environmentId, entry.session.key);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (extra.length === 0) return entries;
  const merged = [...entries, ...extra];
  const timeByEntry = new Map(merged.map((entry) => [entry, updatedAtMs(entry)] as const));
  // Stable, so one host's equal times keep its server order.
  return merged.sort((left, right) => (timeByEntry.get(right) ?? 0) - (timeByEntry.get(left) ?? 0));
}

/** The provider's own session id: the key is `<driver>:<session id>`. */
function nativeSessionId(sessionKey: string): string {
  return sessionKey.slice(sessionKey.indexOf(":") + 1);
}

/** The legacy hidden keys, read once; null when there are none or they cannot be read. */
function takeLegacyHiddenKeys(): ReadonlySet<string> | null {
  try {
    const keys = getLocalStorageItem(LEGACY_HIDDEN_STORAGE_KEY, LegacyHiddenKeysSchema);
    if (keys === null) return null;
    removeLocalStorageItem(LEGACY_HIDDEN_STORAGE_KEY);
    return keys.length > 0 ? new Set(keys) : null;
  } catch {
    return null;
  }
}

/**
 * "Other Agents" shelf: sessions running outside T3 on the connected
 * environments, one line each, every host merged newest first. Running ones
 * always show, even with the shelf collapsed; expanded, the last three days'
 * follow, and Load more reveals the next ten. Right-click a row for its
 * actions, or the header to find archived sessions; Cmd/Ctrl- and Shift-click
 * select rows for bulk actions. Renders nothing while no environment reports
 * any.
 */
export function ExternalSessionsSidebarSection() {
  const liveEntries = useAtomValue(externalSessionEntriesAtom);
  const cuts = useAtomValue(externalSessionListCutsAtom);
  const [olderPages, setOlderPages] = useState(NO_OLDER_PAGES);
  const [selection, setSelection] = useState<RowSelection>({
    keys: NO_SELECTED_KEYS,
    anchor: null,
  });
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const [revealed, setRevealed] = useState(0);
  const nowMinute = useNowMinute();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const runContinue = useAtomCommand(externalSessionContinue, { reportFailure: false });
  const runArchive = useAtomCommand(externalSessionArchive, { reportFailure: false });
  const runDelete = useAtomCommand(externalSessionDelete, { reportFailure: false });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const runOpenInOrigin = useAtomCommand(externalSessionOpenInOrigin, { reportFailure: false });
  const runListOlder = useAtomCommand(externalSessionListOlder, { reportFailure: false });
  const activeKey = useParams({
    strict: false,
    select: (params) =>
      params.environmentId && params.sessionKey
        ? rowKey(params.environmentId, params.sessionKey)
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

  // Pages belong to a cut: they go when their host disconnects or stops being cut.
  useEffect(() => {
    setOlderPages((current) => {
      if (current.size === 0) return current;
      const cutHosts = new Set(cuts.map((cut) => cut.environmentId));
      if ([...current.keys()].every((environmentId) => cutHosts.has(environmentId))) {
        return current;
      }
      return new Map([...current].filter(([environmentId]) => cutHosts.has(environmentId)));
    });
  }, [cuts]);

  const shownOlder = cuts.flatMap((cut) => olderPages.get(cut.environmentId)?.entries ?? []);
  const entries = withOlderEntries(liveEntries, shownOlder);
  const shownByHost = new Map<EnvironmentId, number>();
  for (const entry of entries) {
    shownByHost.set(entry.environmentId, (shownByHost.get(entry.environmentId) ?? 0) + 1);
  }

  // `nowMinute` is the UTC minute ("YYYY-MM-DDTHH:mm"); its ticks age sessions
  // out of the first view. Entries come newest first.
  const now = Date.parse(`${nowMinute}Z`);
  const active = entries.filter((entry) => entry.session.liveness === "running");
  const rest = entries.filter((entry) => entry.session.liveness !== "running");
  const firstViewCount = rest.findIndex((entry) => now - updatedAtMs(entry) >= FIRST_VIEW_MS);
  const wanted = (firstViewCount === -1 ? rest.length : firstViewCount) + revealed;

  // A cut host's unread sessions are all older than its last loaded one, so a
  // row older than that could still have one of them ahead of it. Only rows
  // at or after every such boundary are shown, which keeps the merge in order.
  const hostsWithMore = cuts.flatMap((cut) => {
    const pages = olderPages.get(cut.environmentId);
    if (pages?.more === false || (shownByHost.get(cut.environmentId) ?? 0) >= cut.total) {
      return [];
    }
    const last =
      pages?.entries.at(-1) ??
      liveEntries.findLast((entry) => entry.environmentId === cut.environmentId);
    // With nothing loaded, its live list held nothing newer than the first view.
    const hostBoundaryMs = last === undefined ? now - FIRST_VIEW_MS : updatedAtMs(last);
    return [{ cut, pages, boundaryMs: hostBoundaryMs }];
  });
  const boundaryMs = Math.max(-Infinity, ...hostsWithMore.map((host) => host.boundaryMs));
  const ordered = rest.findIndex((entry) => updatedAtMs(entry) < boundaryMs);
  const shownRestCount = Math.min(wanted, ordered === -1 ? rest.length : ordered);

  // The rows in screen order: what Shift-click ranges over and bulk actions act on.
  const shownRest = firstWithOpen(rest, shownRestCount, activeKey);
  const shownEntries = expanded ? [...active, ...shownRest] : active;
  const selectedEntries = () =>
    shownEntries.filter((entry) =>
      selection.keys.has(rowKey(entry.environmentId, entry.session.key)),
    );

  // One selection at a time: selecting threads drops the sessions' selection.
  const threadSelectionActive = useThreadSelectionStore(
    (state) => state.selectedThreadKeys.size > 0,
  );
  useEffect(() => {
    if (threadSelectionActive) setSelection(clearSelected);
  }, [threadSelectionActive]);

  const hasSelection = selection.keys.size > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelection(clearSelected);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasSelection]);

  // Sessions hidden in this browser before archive existed are archived, once,
  // on the first non-empty list. Keys of sessions not listed then
  // (aged out, or on an environment not yet connected) are dropped.
  const legacyMigrated = useRef(false);
  useEffect(() => {
    if (legacyMigrated.current || liveEntries.length === 0) return;
    legacyMigrated.current = true;
    const hidden = takeLegacyHiddenKeys();
    if (hidden === null) return;
    for (const { environmentId, session } of liveEntries) {
      if (!hidden.has(rowKey(environmentId, session.key))) continue;
      if (!appAtomRegistry.get(externalSessionArchive.permissionAtom(environmentId))) continue;
      void runArchive({ environmentId, input: { key: session.key } });
    }
  }, [liveEntries, runArchive]);

  const toggleExpanded = () => {
    if (expanded) setRevealed(0);
    setExpanded((value) => !value);
  };
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  // A paged-in row is not live, so one that left the list is removed here.
  const dropOlder = (entry: ExternalSessionEntry) =>
    setOlderPages((current) => {
      const pages = current.get(entry.environmentId);
      if (pages === undefined) return current;
      const kept = pages.entries.filter(({ session }) => session.key !== entry.session.key);
      if (kept.length === pages.entries.length) return current;
      return new Map(current).set(entry.environmentId, { ...pages, entries: kept });
    });

  // The cursor is the last session already loaded: the live tail, then each page's last.
  const loadOlder = async (cut: ExternalSessionListCut) => {
    const { environmentId } = cut;
    const pages = olderPages.get(environmentId);
    if (pages?.loading === true) return;
    const live = liveEntries.filter((entry) => entry.environmentId === environmentId);
    const last = pages?.entries.at(-1) ?? live.at(-1);
    // A host with no live rows pages from the top of its list.
    const before =
      last === undefined
        ? { updatedAt: new Date(Date.now() + 1).toISOString(), key: "~" }
        : { updatedAt: last.session.updatedAt, key: last.session.key };
    setOlderPages((current) =>
      new Map(current).set(environmentId, {
        entries: current.get(environmentId)?.entries ?? live,
        more: true,
        loading: true,
        failed: false,
      }),
    );
    const result = await runListOlder({ environmentId, input: { before } });
    const environmentLabel =
      appAtomRegistry.get(externalSessionHostLabelsAtom)?.get(environmentId) ?? null;
    setOlderPages((current) => {
      const held = current.get(environmentId);
      // Dropped meanwhile: the cut ended or the host went away.
      if (held === undefined) return current;
      if (result._tag === "Failure") {
        return new Map(current).set(environmentId, { ...held, loading: false, failed: true });
      }
      const page = result.value.sessions.map(
        (session: ExternalSessionSummary): ExternalSessionEntry => ({
          environmentId,
          environmentLabel,
          session,
        }),
      );
      return new Map(current).set(environmentId, {
        entries: [...held.entries, ...page],
        more: result.value.more,
        loading: false,
        failed: false,
      });
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not load older sessions",
        description: failure instanceof Error ? failure.message : "An error occurred.",
      });
    }
  };

  // Fills the view up to `wanted` rows: the next page from each cut host whose
  // boundary still holds a wanted row back. The key changes when a boundary
  // moves or a read ends, so a host that needs several pages gets them in turn.
  const target = rest[wanted - 1];
  const holdingBack =
    expanded && wanted > shownRestCount
      ? hostsWithMore.filter(
          ({ pages, boundaryMs: hostBoundaryMs }) =>
            pages?.loading !== true &&
            pages?.failed !== true &&
            (target === undefined || hostBoundaryMs > updatedAtMs(target)),
        )
      : [];
  const holdingBackKey = holdingBack
    .map(({ cut, boundaryMs: hostBoundaryMs }) => `${cut.environmentId}@${hostBoundaryMs}`)
    .join(",");
  const loadOlderLatest = useStableCallback(loadOlder);
  useEffect(() => {
    for (const { cut } of holdingBack) void loadOlderLatest(cut);
    // `holdingBackKey` names exactly what `holdingBack` would read.
  }, [holdingBackKey, loadOlderLatest]);

  const loadMore = () => {
    setOlderPages((current) =>
      [...current.values()].some((pages) => pages.failed)
        ? new Map(
            [...current].map(([environmentId, pages]) => [
              environmentId,
              { ...pages, failed: false },
            ]),
          )
        : current,
    );
    setRevealed((count) => count + LOAD_MORE_ROWS);
  };

  const continueInT3 = async (entry: ExternalSessionEntry) => {
    const { environmentId, session } = entry;
    if (!appAtomRegistry.get(externalSessionContinue.permissionAtom(environmentId))) return;
    const result = await runContinue({ environmentId, input: { key: session.key } });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not continue in T3",
        description:
          failure instanceof Error ? failure.message : "Could not continue this session in T3.",
      });
      return;
    }
    dropOlder(entry);
    const threadRef = scopeThreadRef(environmentId, result.value.threadId);
    // The thread route treats a thread missing from the shell as gone.
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

  const openFolder = async (entry: ExternalSessionEntry, editor: EditorId) => {
    if (entry.session.cwd === null) return;
    const result = await openInEditor({
      environmentId: entry.environmentId,
      input: { cwd: entry.session.cwd, editor },
    });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title:
        editor === "file-manager"
          ? "Could not open folder"
          : `Could not open in ${EDITOR_LABEL_BY_ID.get(editor) ?? editor}`,
      description: entry.session.cwd,
    });
  };

  const openInOrigin = async (entry: ExternalSessionEntry) => {
    if (!appAtomRegistry.get(externalSessionOriginIsLocalAtom(entry.environmentId))) return;
    if (!appAtomRegistry.get(externalSessionOpenInOrigin.permissionAtom(entry.environmentId))) {
      return;
    }
    const result = await runOpenInOrigin({
      environmentId: entry.environmentId,
      input: { key: entry.session.key },
    });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not open ${externalSessionOriginLabel(entry.session)}`,
      description: failure instanceof Error ? failure.message : "An error occurred.",
    });
  };

  // The row leaves the list on the server's next push; an open session's view stays put.
  const archiveSession = async (entry: ExternalSessionEntry) => {
    if (!appAtomRegistry.get(externalSessionArchive.permissionAtom(entry.environmentId))) return;
    const result = await runArchive({
      environmentId: entry.environmentId,
      input: { key: entry.session.key },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not archive session",
        description: failure instanceof Error ? failure.message : "An error occurred.",
      });
      return;
    }
    dropOlder(entry);
  };

  const archiveSelected = async (targets: ReadonlyArray<ExternalSessionEntry>) => {
    const results = await Promise.all(
      targets.map(async (entry) => {
        const result = await runArchive({
          environmentId: entry.environmentId,
          input: { key: entry.session.key },
        });
        if (result._tag !== "Failure") dropOlder(entry);
        return result;
      }),
    );
    reportBulkFailures("archive", results.filter(isReportedFailure).length);
  };

  // Gone from the agent's own app too, so it always asks first. One at a time, and an
  // open session's view leaves with it.
  const deleteSessions = async (targets: ReadonlyArray<ExternalSessionEntry>) => {
    const api = readLocalApi();
    const [first] = targets;
    if (api === undefined || first === undefined) return;
    const confirmed = await api.dialogs
      .confirm(
        [
          targets.length === 1
            ? `Delete "${externalSessionTitle(first.session)}"?`
            : `Delete ${targets.length} sessions?`,
          targets.length === 1
            ? `This deletes the session in ${externalSessionProductName(first.session)} too. It cannot be undone.`
            : "This deletes each session in its agent's own app too. It cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      )
      .catch(() => false);
    if (!confirmed) return;
    let failed = 0;
    let lastFailure: unknown = null;
    let leftActive = false;
    for (const entry of targets) {
      const result = await runDelete({
        environmentId: entry.environmentId,
        input: { key: entry.session.key },
      });
      if (result._tag === "Failure") {
        if (!isReportedFailure(result)) continue;
        failed += 1;
        lastFailure = squashAtomCommandFailure(result);
        continue;
      }
      dropOlder(entry);
      if (rowKey(entry.environmentId, entry.session.key) === activeKey) leftActive = true;
    }
    if (targets.length === 1 && failed === 1) {
      toastManager.add({
        type: "error",
        title: "Could not delete session",
        description: lastFailure instanceof Error ? lastFailure.message : "An error occurred.",
      });
    } else {
      reportBulkFailures("delete", failed);
    }
    if (leftActive) await navigate({ to: "/" });
  };

  // One at a time: sessions in one new folder would otherwise each create its project.
  // The first thread opens, as continuing one session does.
  const continueSelected = async (targets: ReadonlyArray<ExternalSessionEntry>) => {
    let firstThread: ScopedThreadRef | null = null;
    let failed = 0;
    for (const entry of targets) {
      const result = await runContinue({
        environmentId: entry.environmentId,
        input: { key: entry.session.key },
      });
      if (result._tag === "Failure") {
        if (isReportedFailure(result)) failed += 1;
        continue;
      }
      dropOlder(entry);
      firstThread ??= scopeThreadRef(entry.environmentId, result.value.threadId);
    }
    reportBulkFailures("continue", failed);
    if (firstThread === null || !(await waitForThreadShell(firstThread))) return;
    closeMobileSidebar();
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(firstThread),
    });
  };

  const openSelectedInOrigin = async (targets: ReadonlyArray<ExternalSessionEntry>) => {
    let failed = 0;
    for (const entry of targets) {
      const result = await runOpenInOrigin({
        environmentId: entry.environmentId,
        input: { key: entry.session.key },
      });
      if (isReportedFailure(result)) failed += 1;
    }
    reportBulkFailures("open", failed);
  };

  const openFolders = async (
    folders: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly cwd: string }>,
    editor: EditorId,
  ) => {
    let failed = 0;
    for (const { environmentId, cwd } of folders) {
      const result = await openInEditor({ environmentId, input: { cwd, editor } });
      if (isReportedFailure(result)) failed += 1;
    }
    if (failed === 0) return;
    toastManager.add({
      type: "error",
      title: `Could not open ${failed} folder${failed === 1 ? "" : "s"}`,
    });
  };

  const showSelectionMenu = async (
    selected: ReadonlyArray<ExternalSessionEntry>,
    position: MenuPosition,
  ) => {
    const api = readLocalApi();
    if (api === undefined) return;
    const count = selected.length;
    // Read at click time, as the single-row menu does; each action keeps its per-row rules.
    const editorsOf = (environmentId: EnvironmentId) =>
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.availableEditors ?? [];
    const continuable = selected.filter(
      ({ environmentId, session }) =>
        externalSessionUnsupportedReason(session) === null &&
        appAtomRegistry.get(externalSessionContinue.permissionAtom(environmentId)),
    );
    const continueTargets = continuable.filter(({ session }) => session.liveness !== "running");
    const byOrigin = new Map<string, Array<ExternalSessionEntry>>();
    for (const entry of selected) {
      const { environmentId, session } = entry;
      if (
        !externalSessionOpensInOrigin(session) ||
        !appAtomRegistry.get(externalSessionOpenInOrigin.permissionAtom(environmentId)) ||
        !appAtomRegistry.get(externalSessionOriginIsLocalAtom(environmentId))
      ) {
        continue;
      }
      const label = externalSessionOriginLabel(session);
      byOrigin.set(label, [...(byOrigin.get(label) ?? []), entry]);
    }
    const folders = distinctFolders(selected);
    const paths = [...new Set(folders.map(({ cwd }) => cwd))];
    const fileManagerFolders = folders.filter(({ environmentId }) =>
      editorsOf(environmentId).includes("file-manager"),
    );
    const otherEditors = [
      ...new Set(folders.flatMap(({ environmentId }) => editorsOf(environmentId))),
    ].filter((id) => id !== "file-manager");
    const permitted = selected.filter(({ environmentId }) =>
      appAtomRegistry.get(externalSessionArchive.permissionAtom(environmentId)),
    );
    // Running ones may be in use in the other app right now.
    const archivable = permitted.filter(({ session }) => session.liveness !== "running");
    const deletePermitted = selected.filter(
      ({ environmentId, session }) =>
        externalSessionDeletable(session) &&
        appAtomRegistry.get(externalSessionDelete.permissionAtom(environmentId)),
    );
    const deletable = deletePermitted.filter(({ session }) => session.liveness !== "running");

    const items: Array<ContextMenuItem<SelectionMenuAction>> = [];
    if (continuable.length > 0) {
      items.push({
        id: "continue",
        label: `Continue in T3 (${continueTargets.length})`,
        icon: "message-square-plus",
        disabled: continueTargets.length === 0,
      });
    }
    for (const [label, group] of byOrigin) {
      items.push({ id: `open-origin:${label}`, label: `Open in ${label} (${group.length})` });
    }
    items.push({
      id: "copy-session-ids",
      label: `Copy session IDs (${count})`,
      icon: "hash",
      separatorBefore: items.length > 0,
    });
    if (paths.length > 0) {
      items.push({
        id: "copy-paths",
        label: `Copy folder paths (${paths.length})`,
        icon: "copy",
      });
    }
    if (fileManagerFolders.length > 0) {
      items.push({
        id: "open-folders",
        label: `Open folders (${fileManagerFolders.length})`,
        icon: "folder",
      });
    }
    if (otherEditors.length > 0) {
      items.push({
        id: "open-with",
        label: "Open folders in",
        children: otherEditors.map((editorId) => ({
          id: `editor:${editorId}` as const,
          label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
        })),
      });
    }
    if (permitted.length > 0) {
      items.push({
        id: "archive",
        label: `Archive (${archivable.length})`,
        icon: "archive",
        separatorBefore: true,
        disabled: archivable.length === 0,
      });
    }
    if (deletePermitted.length > 0) {
      items.push({
        id: "delete",
        label: `Delete (${deletable.length})`,
        icon: "trash",
        destructive: true,
        separatorBefore: permitted.length === 0,
        disabled: deletable.length === 0,
      });
    }
    items.push({ id: "clear-selection", label: "Clear selection", separatorBefore: true });

    const clicked = await api.contextMenu.show(items, position);
    if (clicked === null || clicked === "open-with") return;
    if (clicked === "copy-session-ids") {
      copyToClipboard(selected.map(({ session }) => nativeSessionId(session.key)).join("\n"), {
        title: `${count} session IDs copied`,
      });
      return;
    }
    if (clicked === "copy-paths") {
      copyToClipboard(paths.join("\n"), {
        title: paths.length === 1 ? "Path copied" : `${paths.length} paths copied`,
      });
      return;
    }
    setSelection(clearSelected);
    if (clicked === "continue") await continueSelected(continueTargets);
    else if (clicked === "open-folders") await openFolders(fileManagerFolders, "file-manager");
    else if (clicked === "archive") await archiveSelected(archivable);
    else if (clicked === "delete") await deleteSessions(deletable);
    else if (clicked.startsWith("open-origin:")) {
      await openSelectedInOrigin(byOrigin.get(clicked.slice("open-origin:".length)) ?? []);
    } else if (clicked.startsWith("editor:")) {
      const editor = clicked.slice("editor:".length) as EditorId;
      await openFolders(
        folders.filter(({ environmentId }) => editorsOf(environmentId).includes(editor)),
        editor,
      );
    }
  };

  const showArchived = async () => {
    closeMobileSidebar();
    await navigate({ to: "/settings/archived" });
  };

  const showRowMenu = async (entry: ExternalSessionEntry, position: MenuPosition) => {
    const api = readLocalApi();
    if (api === undefined) return;
    if (selection.keys.has(rowKey(entry.environmentId, entry.session.key))) {
      const selected = selectedEntries();
      if (selected.length > 1) {
        await showSelectionMenu(selected, position);
        return;
      }
    }
    const { environmentId, session } = entry;
    // Read at click time, so rows do not each subscribe to the server config.
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    const editors = config?.availableEditors ?? [];
    const otherEditors = editors.filter((id) => id !== "file-manager");
    // Each action shows only where this connection's grants allow it.
    const canContinue = appAtomRegistry.get(externalSessionContinue.permissionAtom(environmentId));
    const canOpenInOrigin = appAtomRegistry.get(
      externalSessionOpenInOrigin.permissionAtom(environmentId),
    );
    const canArchive = appAtomRegistry.get(externalSessionArchive.permissionAtom(environmentId));
    const canDelete =
      externalSessionDeletable(session) &&
      appAtomRegistry.get(externalSessionDelete.permissionAtom(environmentId));
    const items: Array<ContextMenuItem<RowMenuAction>> = [];
    if (externalSessionUnsupportedReason(session) === null && canContinue) {
      items.push({
        id: "continue",
        label: "Continue in T3",
        icon: "message-square-plus",
        // Two writers on one native session would interleave its transcript.
        disabled: session.liveness === "running",
      });
    }
    if (
      canOpenInOrigin &&
      externalSessionOpensInOrigin(session) &&
      appAtomRegistry.get(externalSessionOriginIsLocalAtom(environmentId))
    ) {
      items.push({ id: "open-origin", label: `Open in ${externalSessionOriginLabel(session)}` });
    }
    items.push({
      id: "copy-session-id",
      label: "Copy session ID",
      icon: "hash",
      separatorBefore: items.length > 0,
    });
    if (session.cwd !== null) {
      items.push({ id: "copy-path", label: "Copy folder path", icon: "copy" });
      if (editors.includes("file-manager")) {
        items.push({ id: "open-folder", label: "Open folder", icon: "folder" });
      }
      if (otherEditors.length > 0) {
        items.push({
          id: "open-with",
          label: "Open folder in",
          children: otherEditors.map((editorId) => ({
            id: `editor:${editorId}` as const,
            label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
          })),
        });
      }
    }
    if (canArchive) {
      items.push({
        id: "archive",
        label: "Archive",
        icon: "archive",
        separatorBefore: true,
        // It may be in use in the other app right now.
        disabled: session.liveness === "running",
      });
    }
    if (canDelete) {
      items.push({
        id: "delete",
        label: "Delete",
        icon: "trash",
        destructive: true,
        separatorBefore: !canArchive,
        disabled: session.liveness === "running",
      });
    }

    const clicked = await api.contextMenu.show(items, position);
    switch (clicked) {
      case null:
      case "open-with":
        return;
      case "continue":
        await continueInT3(entry);
        return;
      case "open-origin":
        await openInOrigin(entry);
        return;
      case "copy-session-id":
        copyToClipboard(nativeSessionId(session.key), { title: "Session ID copied" });
        return;
      case "copy-path":
        if (session.cwd !== null) copyToClipboard(session.cwd, { title: "Path copied" });
        return;
      case "open-folder":
        await openFolder(entry, "file-manager");
        return;
      case "archive":
        await archiveSession(entry);
        return;
      case "delete":
        await deleteSessions([entry]);
        return;
      case "show-archived":
        await showArchived();
        return;
      default:
        await openFolder(entry, clicked.slice("editor:".length) as EditorId);
    }
  };

  // Modifier clicks select instead of opening; the Link would otherwise open a new window.
  const handleRowClick = useStableCallback((entry: ExternalSessionEntry, event: MouseEvent) => {
    const key = rowKey(entry.environmentId, entry.session.key);
    const isModClick = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (isModClick || event.shiftKey) {
      event.preventDefault();
      useThreadSelectionStore.getState().clearSelection();
      const shownKeys = shownEntries.map(({ environmentId, session }) =>
        rowKey(environmentId, session.key),
      );
      setSelection((current) =>
        isModClick ? toggleSelected(current, key) : selectRangeTo(current, key, shownKeys),
      );
      return;
    }
    setSelection((current) =>
      current.keys.size === 0 && current.anchor === key
        ? current
        : { keys: NO_SELECTED_KEYS, anchor: key },
    );
    closeMobileSidebar();
  });

  // Rows are memoized, so they get one stable callback that runs the latest menu.
  const handleRowContextMenu = useStableCallback(
    (entry: ExternalSessionEntry, position: MenuPosition) => {
      void showRowMenu(entry, position);
    },
  );

  const handleHeaderContextMenu = async (event: MouseEvent) => {
    const api = readLocalApi();
    if (api === undefined) return;
    event.preventDefault();
    const clicked = await api.contextMenu.show<RowMenuAction>(
      [{ id: "show-archived", label: "Show archived sessions", icon: "archive" }],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "show-archived") await showArchived();
  };

  if (entries.length === 0) return null;
  const activeCount = active.length;
  const loadingOlder = hostsWithMore.some(({ pages }) => pages?.loading === true);
  const canLoadMore = rest.length > shownRestCount || hostsWithMore.length > 0;
  const rowProps = {
    activeKey,
    selectedKeys: selection.keys,
    nowMinute,
    onClick: handleRowClick,
    onContextMenu: handleRowContextMenu,
  };

  return (
    <section aria-label="Other Agents" className="mt-1">
      <div
        className="@container/other-agents mx-0.5 h-5"
        onContextMenu={(event) => void handleHeaderContextMenu(event)}
      >
        <CollapsibleSectionHeader
          expanded={expanded}
          size="sidebar"
          onClick={toggleExpanded}
          onMouseDown={preventMouseFocus}
          accessory={
            <AgentSectionAccessory
              count={active.length + shownRest.length}
              running={activeCount}
              // At the narrowest sidebar the word drops out, so the chevron stays in view.
              runningSuffix={
                <span className="sr-only @min-[14.5rem]/other-agents:not-sr-only">{" active"}</span>
              }
            />
          }
        >
          Other Agents
        </CollapsibleSectionHeader>
      </div>
      {/* Same hover timing as the thread list's cards. */}
      <TooltipProvider delay={150} closeDelay={0} timeout={400}>
        <ExternalSessionRows entries={active} {...rowProps} />
        {expanded ? (
          <>
            <ExternalSessionRows entries={shownRest} {...rowProps} />
            {canLoadMore ? (
              <button
                type="button"
                disabled={loadingOlder}
                onClick={loadMore}
                onMouseDown={preventMouseFocus}
                className={AGENT_MORE_BUTTON_CLASS}
              >
                <AgentMoreIcon />
                <span className="min-w-0 truncate">{loadingOlder ? "Loading…" : "Load more"}</span>
              </button>
            ) : null}
          </>
        ) : null}
      </TooltipProvider>
    </section>
  );
}

function ExternalSessionRows(props: {
  entries: ReadonlyArray<ExternalSessionEntry>;
  activeKey: string | null;
  selectedKeys: ReadonlySet<string>;
  nowMinute: string;
  onClick: (entry: ExternalSessionEntry, event: MouseEvent) => void;
  onContextMenu: (entry: ExternalSessionEntry, position: MenuPosition) => void;
}) {
  if (props.entries.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {props.entries.map((entry) => {
        const key = rowKey(entry.environmentId, entry.session.key);
        return (
          <ExternalSessionLine
            key={key}
            entry={entry}
            isActive={props.activeKey === key}
            isSelected={props.selectedKeys.has(key)}
            nowMinute={props.nowMinute}
            onClick={props.onClick}
            onContextMenu={props.onContextMenu}
          />
        );
      })}
    </ul>
  );
}

/** The thread rows' hover card, for a session: where it runs, its folder and how recently it moved. */
function ExternalSessionHoverCard(props: { entry: ExternalSessionEntry; nowMinute: string }) {
  const { environmentLabel, session } = props.entry;
  const model = shortModelLabel(session.model);
  const origin = externalSessionOriginLabel(session);
  const now = Date.parse(`${props.nowMinute}Z`);
  const lastActive = `Last active ${formatRelativeTimeLabel(session.updatedAt, now)}`;
  const activity =
    session.liveness === "running"
      ? LIVENESS_LABEL.running
      : session.liveness === "idle"
        ? `${LIVENESS_LABEL.idle} · ${lastActive.toLowerCase()}`
        : lastActive;
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard title={externalSessionTitle(session)}>
        <div className="flex min-w-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={session.driver}
            displayName={externalSessionProductName(session)}
            iconClassName="size-3 shrink-0 grayscale opacity-60"
          />
          <div className="min-w-0 truncate text-foreground/75">
            {model === null ? origin : `${origin} · ${model}`}
          </div>
        </div>
        {session.cwd !== null ? (
          <div className="flex min-w-0 items-center gap-2">
            <FolderIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={session.cwd} className="flex text-foreground/75" />
          </div>
        ) : null}
        {environmentLabel !== null ? (
          <div className="flex min-w-0 items-center gap-2">
            <MonitorIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          {session.liveness === "running" ? (
            <CircleDashedIcon className="size-3 shrink-0 text-info-foreground" />
          ) : (
            <ClockIcon className="size-3 shrink-0 stroke-muted-foreground" />
          )}
          <div className="min-w-0 truncate text-foreground/75">{activity}</div>
        </div>
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

/** Matches the standard thread rows' short relative time: "5m", "now". */
function compactTimeLabel(iso: string, nowMinute: string): string {
  const label = formatRelativeTimeLabel(iso, Date.parse(`${nowMinute}Z`));
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/** What a screen reader hears for a session row. */
function sessionRowLabel({ environmentLabel, session }: ExternalSessionEntry): string {
  return [
    externalSessionTitle(session),
    externalSessionOriginLabel(session),
    cwdBasename(session.cwd),
    shortModelLabel(session.model),
    environmentLabel,
    LIVENESS_LABEL[session.liveness],
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(", ");
}

/**
 * One external session on a single line: harness icon, title, its host while
 * more than one is connected, then its age or a running spinner. Sessions that
 * are not running or idle recede the way settled threads do; the hover card holds the folder, model and machine.
 * `nowMinute` only exists to refresh the age once a minute; the other props
 * keep their identity across unrelated pushes.
 */
const ExternalSessionLine = memo(function ExternalSessionLine(props: {
  entry: ExternalSessionEntry;
  isActive: boolean;
  isSelected: boolean;
  nowMinute: string;
  onClick: (entry: ExternalSessionEntry, event: MouseEvent) => void;
  onContextMenu: (entry: ExternalSessionEntry, position: MenuPosition) => void;
}) {
  const { environmentId, environmentLabel, session } = props.entry;
  const running = session.liveness === "running";
  return (
    <li className="list-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/external/$environmentId/$sessionKey"
              params={{ environmentId, sessionKey: session.key }}
              aria-label={sessionRowLabel(props.entry)}
              aria-current={props.isActive ? "page" : undefined}
              onClick={(event) => props.onClick(props.entry, event)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(props.entry, { x: event.clientX, y: event.clientY });
              }}
              className={cn(
                AGENT_LINE_CLASS,
                "px-(--sidebar-row-content-inset)",
                props.isActive
                  ? AGENT_LINE_ACTIVE_CLASS
                  : props.isSelected
                    ? AGENT_LINE_SELECTED_CLASS
                    : session.liveness === "recent"
                      ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-row-hover",
              )}
            />
          }
        >
          <ProviderInstanceIcon
            driverKind={session.driver}
            displayName={externalSessionProductName(session)}
            className={AGENT_LINE_ICON_CLASS}
            iconClassName="size-3"
          />
          <span className="min-w-0 flex-1 truncate">{externalSessionTitle(session)}</span>
          {environmentLabel !== null ? (
            <span className="max-w-20 shrink-0 truncate text-secondary-label">
              {environmentLabel}
            </span>
          ) : null}
          {running ? (
            <CircleDashedIcon
              aria-hidden
              className={cn(AGENT_LINE_ICON_CLASS, "text-info-foreground")}
            />
          ) : (
            <span className="shrink-0 tabular-nums text-secondary-label">
              {compactTimeLabel(session.updatedAt, props.nowMinute)}
            </span>
          )}
        </TooltipTrigger>
        <ExternalSessionHoverCard entry={props.entry} nowMinute={props.nowMinute} />
      </Tooltip>
    </li>
  );
});
