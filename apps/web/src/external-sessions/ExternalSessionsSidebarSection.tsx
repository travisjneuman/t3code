import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORS,
  externalSessionUnsupportedReason,
  type ContextMenuItem,
  type EditorId,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CircleDashedIcon } from "lucide-react";
import { memo, useCallback, useMemo, useRef, type MouseEvent } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useSidebar } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  cwdBasename,
  externalSessionContinue,
  externalSessionEntriesAtom,
  externalSessionOriginLabel,
  externalSessionProductName,
  externalSessionTitle,
  LIVENESS_LABEL,
  shortModelLabel,
  type ExternalSessionEntry,
} from "./atoms";
import { resolveHandoffTargets, type HandoffTo } from "./handoffTargets";

const EXPANDED_STORAGE_KEY = "t3code:sidebar:external-sessions-expanded";
const HIDDEN_STORAGE_KEY = "t3code:sidebar:external-sessions-hidden:v1";
/** Sessions leave the list after a few idle days, so old hidden keys only need a cap. */
const MAX_HIDDEN_KEYS = 500;
const HiddenKeysSchema = Schema.Array(Schema.String);

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

type RowMenuAction =
  | "continue"
  | "continue-with"
  | `handoff:${string}`
  | "copy-session-id"
  | "copy-path"
  | "open-folder"
  | "open-with"
  | `editor:${EditorId}`
  | "hide"
  | "unhide-all";

type MenuPosition = { readonly x: number; readonly y: number };

function rowKey(environmentId: string, sessionKey: string): string {
  return `${environmentId}\u0000${sessionKey}`;
}

/** The provider's own session id: the key is `<driver>:<session id>`. */
function nativeSessionId(sessionKey: string): string {
  return sessionKey.slice(sessionKey.indexOf(":") + 1);
}

function unhideAllItem(hiddenCount: number): ContextMenuItem<RowMenuAction> {
  return {
    id: "unhide-all",
    label: `Show ${hiddenCount} hidden session${hiddenCount === 1 ? "" : "s"}`,
    icon: "refresh-cw",
  };
}

/**
 * "Other Agents" shelf: sessions running outside T3 on the connected
 * environments, live ones first. Expanding shows every session. Right-click a
 * row for its actions, or the header to bring hidden sessions back. Renders
 * nothing while no environment reports any.
 */
export function ExternalSessionsSidebarSection() {
  const entries = useAtomValue(externalSessionEntriesAtom);
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const [hiddenKeys, setHiddenKeys] = useLocalStorage<ReadonlyArray<string>, readonly string[]>(
    HIDDEN_STORAGE_KEY,
    [],
    HiddenKeysSchema,
  );
  const nowMinute = useNowMinute();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const runContinue = useAtomCommand(externalSessionContinue, { reportFailure: false });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
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

  const hiddenSet = useMemo(() => new Set(hiddenKeys), [hiddenKeys]);
  const { visible, hiddenCount } = useMemo(() => {
    const live: Array<ExternalSessionEntry> = [];
    const recent: Array<ExternalSessionEntry> = [];
    let hidden = 0;
    for (const entry of entries) {
      if (hiddenSet.has(rowKey(entry.environmentId, entry.session.key))) {
        hidden += 1;
        continue;
      }
      (entry.session.liveness === "recent" ? recent : live).push(entry);
    }
    return { visible: [...live, ...recent], hiddenCount: hidden };
  }, [entries, hiddenSet]);

  const toggleExpanded = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  // Without `handoffTo` the session continues in place; with it, a new thread
  // on that agent starts from the session's history.
  const continueInT3 = async (entry: ExternalSessionEntry, handoffTo?: HandoffTo) => {
    const { environmentId, session } = entry;
    const result = await runContinue({
      environmentId,
      input: handoffTo === undefined ? { key: session.key } : { key: session.key, handoffTo },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: handoffTo === undefined ? "Could not continue in T3" : "Could not hand off",
        description:
          failure instanceof Error ? failure.message : "Could not continue this session in T3.",
      });
      return;
    }
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

  const setHidden = (key: string | null) =>
    setHiddenKeys((keys) =>
      key === null ? [] : [key, ...keys.filter((k) => k !== key)].slice(0, MAX_HIDDEN_KEYS),
    );

  const showRowMenu = async (entry: ExternalSessionEntry, position: MenuPosition) => {
    const api = readLocalApi();
    if (api === undefined) return;
    const { environmentId, session } = entry;
    // Read at click time, so rows do not each subscribe to the server config.
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    const editors = config?.availableEditors ?? [];
    const handoffTargets = resolveHandoffTargets(config?.providers ?? [], session);
    const otherEditors = editors.filter((id) => id !== "file-manager");
    const items: Array<ContextMenuItem<RowMenuAction>> = [];
    if (externalSessionUnsupportedReason(session) === null) {
      items.push({
        id: "continue",
        label: "Continue in T3",
        icon: "message-square-plus",
        // Two writers on one native session would interleave its transcript.
        disabled: session.liveness === "running",
      });
    }
    if (handoffTargets.length > 0) {
      // A handoff only reads the transcript, so a running session can still go.
      items.push({
        id: "continue-with",
        label: "Continue with",
        children: handoffTargets.map(({ entry: target }) => ({
          id: `handoff:${target.instanceId}` as const,
          label: target.displayName,
        })),
      });
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
    items.push({ id: "hide", label: "Hide from list", icon: "archive", separatorBefore: true });
    if (hiddenCount > 0) items.push(unhideAllItem(hiddenCount));

    const clicked = await api.contextMenu.show(items, position);
    switch (clicked) {
      case null:
      case "open-with":
      case "continue-with":
        return;
      case "continue":
        await continueInT3(entry);
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
      case "hide":
        setHidden(rowKey(environmentId, session.key));
        return;
      case "unhide-all":
        setHidden(null);
        return;
      default:
        if (clicked.startsWith("handoff:")) {
          const instanceId = clicked.slice("handoff:".length);
          const target = handoffTargets.find(({ entry: t }) => t.instanceId === instanceId);
          if (target !== undefined) {
            await continueInT3(entry, { instanceId: target.entry.instanceId, model: target.model });
          }
          return;
        }
        await openFolder(entry, clicked.slice("editor:".length) as EditorId);
    }
  };

  // Rows are memoized, so they get one stable callback that runs the latest menu.
  const showRowMenuRef = useRef(showRowMenu);
  showRowMenuRef.current = showRowMenu;
  const handleRowContextMenu = useCallback(
    (entry: ExternalSessionEntry, position: MenuPosition) => {
      void showRowMenuRef.current(entry, position);
    },
    [],
  );

  const handleHeaderContextMenu = async (event: MouseEvent) => {
    const api = readLocalApi();
    if (hiddenCount === 0 || api === undefined) return;
    event.preventDefault();
    const clicked = await api.contextMenu.show([unhideAllItem(hiddenCount)], {
      x: event.clientX,
      y: event.clientY,
    });
    if (clicked === "unhide-all") setHidden(null);
  };

  if (entries.length === 0) return null;

  return (
    <section aria-label="Other Agents" className="mt-2">
      <div className="mx-0.5 h-8" onContextMenu={(event) => void handleHeaderContextMenu(event)}>
        <CollapsibleSectionHeader expanded={expanded} onClick={toggleExpanded}>
          {`Other Agents (${visible.length})`}
        </CollapsibleSectionHeader>
      </div>
      {expanded ? (
        <ul className="flex flex-col">
          {visible.map((entry) => {
            const key = rowKey(entry.environmentId, entry.session.key);
            return (
              <ExternalSessionRow
                key={key}
                entry={entry}
                isActive={activeKey === key}
                nowMinute={nowMinute}
                onNavigate={closeMobileSidebar}
                onContextMenu={handleRowContextMenu}
              />
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** Matches the standard thread rows' short relative time: "5m", "now". */
function compactTimeLabel(iso: string): string {
  const label = formatRelativeTimeLabel(iso);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/**
 * One external session, in the standard thread row's type scale and surfaces:
 * title and status on top, then provider, folder and model. Inactive sessions
 * recede the way settled threads do. `nowMinute` only exists to refresh the
 * relative time once a minute; the other props keep their identity across
 * unrelated pushes.
 */
const ExternalSessionRow = memo(function ExternalSessionRow(props: {
  entry: ExternalSessionEntry;
  isActive: boolean;
  nowMinute: string;
  onNavigate: () => void;
  onContextMenu: (entry: ExternalSessionEntry, position: MenuPosition) => void;
}) {
  const { environmentId, environmentLabel, session } = props.entry;
  const title = externalSessionTitle(session);
  const providerLabel = externalSessionProductName(session);
  const folder = cwdBasename(session.cwd);
  const model = shortModelLabel(session.model);
  const recede = session.liveness === "recent";
  const running = session.liveness === "running";
  const label = [
    title,
    externalSessionOriginLabel(session),
    folder,
    model,
    LIVENESS_LABEL[session.liveness],
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(", ");

  return (
    <li className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_58px]">
      <Link
        to="/external/$environmentId/$sessionKey"
        params={{ environmentId, sessionKey: session.key }}
        aria-label={label}
        aria-current={props.isActive ? "page" : undefined}
        onClick={props.onNavigate}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(props.entry, { x: event.clientX, y: event.clientY });
        }}
        title={session.cwd === null ? title : `${title}\n${session.cwd}`}
        className={cn(
          "group/sidebar-row relative block w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : recede
              ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <span
          aria-hidden
          className="relative z-10 block px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)"
        >
          <span className="flex h-5 min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                recede && !props.isActive
                  ? "font-normal text-secondary-label"
                  : "font-medium text-foreground/90",
              )}
            >
              {title}
            </span>
            <span className="ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end text-xs tabular-nums text-secondary-label">
              {running ? (
                <span className="inline-flex items-center gap-1 font-medium text-info">
                  <CircleDashedIcon className="size-4 shrink-0" />
                  Running
                </span>
              ) : (
                compactTimeLabel(session.updatedAt)
              )}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-secondary-label">
            <ProviderInstanceIcon
              driverKind={session.driver}
              displayName={providerLabel}
              className="size-3.5 shrink-0"
              iconClassName="size-3.5"
            />
            <span className="min-w-0 truncate">
              {folder ?? externalSessionOriginLabel(session)}
            </span>
            {model !== null ? (
              <span className="min-w-0 shrink-[2] truncate text-muted-foreground/60">{model}</span>
            ) : null}
            {environmentLabel !== null ? (
              <span className="ml-auto min-w-0 shrink-[3] truncate text-muted-foreground/60">
                {environmentLabel}
              </span>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
});
