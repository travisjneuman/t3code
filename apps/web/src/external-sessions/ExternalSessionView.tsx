import { type LegendListRef } from "@legendapp/list/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EXTERNAL_SESSION_UNSUPPORTED_MESSAGES,
  externalSessionUnsupportedReason,
  MessageId,
  type EnvironmentId,
  type ExternalSessionMessage,
  type ExternalSessionSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { Debouncer } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChatCanvas } from "../components/chat/ChatCanvas";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { ProjectFavicon } from "../components/ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import type { TimelineEntry } from "../session-logic";
import { waitForThreadShell } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import {
  cwdBasename,
  externalSessionContinue,
  externalSessionOriginLabel,
  externalSessionProductName,
  externalSessionTitle,
  externalSessionTranscript,
} from "./atoms";

const EMPTY_MESSAGES: ReadonlyArray<ExternalSessionMessage> = [];
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const NO_TURN_DIFFS: [] = [];
const NO_RUNS: [] = [];
/** Tool lines show their first line, capped, like a standard tool row label. */
const TOOL_LABEL_MAX_CHARS = 240;
const SCROLL_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

const LIVENESS_BADGE_VARIANT = {
  running: "info",
  idle: "secondary",
  recent: "secondary",
} as const satisfies Record<ExternalSessionSummary["liveness"], string>;

const noop = () => {};
const noopAsync = async () => {};

/**
 * Timeline entries per message object. The transcript reducer keeps a
 * message's object until its content changes, so entries keep their identity
 * and the timeline's row memoization holds across appends.
 */
const entryByMessage = new WeakMap<ExternalSessionMessage, TimelineEntry>();

function toTimelineEntry(message: ExternalSessionMessage): TimelineEntry {
  const cached = entryByMessage.get(message);
  if (cached !== undefined) return cached;
  const id = `external:${message.id}`;
  let entry: TimelineEntry;
  if (message.role === "tool") {
    const firstLine = message.text.trimStart().split("\n", 1)[0] ?? "";
    entry = {
      id,
      kind: "work",
      createdAt: message.createdAt,
      entry: {
        id,
        createdAt: message.createdAt,
        label:
          firstLine.length > TOOL_LABEL_MAX_CHARS
            ? `${firstLine.slice(0, TOOL_LABEL_MAX_CHARS)}…`
            : firstLine,
        tone: "tool",
      },
    };
  } else {
    entry = {
      id,
      kind: "message",
      createdAt: message.createdAt,
      message: {
        id: MessageId.make(id),
        role: message.role,
        text: message.text,
        runId: null,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
      },
    };
  }
  entryByMessage.set(message, entry);
  return entry;
}

/** While the session runs, its last reply is still being written. */
function toTimelineEntries(
  messages: ReadonlyArray<ExternalSessionMessage>,
  running: boolean,
): ReadonlyArray<TimelineEntry> {
  const entries = messages.map(toTimelineEntry);
  const last = entries.at(-1);
  if (running && last?.kind === "message" && last.message.role === "assistant") {
    entries[entries.length - 1] = { ...last, message: { ...last.message, streaming: true } };
  }
  return entries;
}

/**
 * An agent session running outside T3, shown the way a T3 thread is: the same
 * header, timeline and docked bar. The bar stands in for the composer; an
 * idle session can be continued as a T3 thread from there. Key it by
 * environment and session so switching sessions starts fresh.
 */
export function ExternalSessionView(props: { environmentId: EnvironmentId; sessionKey: string }) {
  const { environmentId, sessionKey } = props;
  const atom = useMemo(
    () => externalSessionTranscript({ environmentId, input: { key: sessionKey } }),
    [environmentId, sessionKey],
  );
  const { data, error, refresh } = useEnvironmentQuery(atom);
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const { resolvedTheme } = useTheme();
  const { timestampFormat } = useEnvironmentSettings(environmentId);

  const summary = data?.summary ?? null;
  const messages = data?.messages ?? EMPTY_MESSAGES;
  const running = summary?.liveness === "running";
  const timelineEntries = useMemo(() => toTimelineEntries(messages, running), [messages, running]);
  const activeTurnStartedAt = running
    ? (messages.findLast((message) => message.role === "user")?.createdAt ?? null)
    : null;
  const cwd = summary?.cwd ?? undefined;
  const hasEntries = timelineEntries.length > 0;

  // Live follow, simplified from the chat view: follow the end until the
  // reader scrolls up, offer the pill while away, follow again at the end.
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const liveFollowRef = useRef(true);
  const isAtEndRef = useRef(true);
  const [showScrollToEnd, setShowScrollToEnd] = useState(false);
  // Showing is debounced so the pill does not flash while the list settles.
  const [showPillDebouncer] = useState(
    () => new Debouncer(() => setShowScrollToEnd(true), { wait: 150 }),
  );
  useEffect(() => () => showPillDebouncer.cancel(), [showPillDebouncer]);
  const setFollow = useCallback((follow: boolean) => {
    liveFollowRef.current = follow;
    setLiveFollowEnabled(follow);
  }, []);
  const hidePill = useCallback(() => {
    showPillDebouncer.cancel();
    setShowScrollToEnd(false);
  }, [showPillDebouncer]);
  const stopFollowing = useCallback(() => {
    if (!liveFollowRef.current) return;
    setFollow(false);
    if (!isAtEndRef.current) showPillDebouncer.maybeExecute();
  }, [setFollow, showPillDebouncer]);
  const scrollToEnd = useCallback(
    (animated: boolean) => {
      setFollow(true);
      hidePill();
      requestAnimationFrame(() => {
        void listRef.current?.scrollToEnd?.({ animated });
      });
    },
    [hidePill, setFollow],
  );
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      isAtEndRef.current = isAtEnd;
      if (isAtEnd) {
        setFollow(true);
        hidePill();
      } else if (liveFollowRef.current) {
        // Streamed growth briefly leaves the end before the follow catches up.
        hidePill();
      } else {
        showPillDebouncer.maybeExecute();
      }
    },
    [hidePill, setFollow, showPillDebouncer],
  );

  // Gestures that move the view away from the end stop following. The list
  // mounts once there are rows, so attach then, retrying a few frames.
  useEffect(() => {
    if (!hasEntries) return;
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;
    const attach = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const node: unknown = listRef.current?.getScrollableNode();
        if (!(node instanceof HTMLElement)) {
          if (remainingAttempts > 0) attach(remainingAttempts - 1);
          return;
        }
        const overflows = () => node.scrollHeight > node.clientHeight;
        const handleWheel = (event: WheelEvent) => {
          if (event.deltaY < 0 && overflows()) stopFollowing();
        };
        // A touch at the end that moves nothing must not break follow, since
        // no later scroll event would re-arm it.
        const handleTouchMove = () => {
          if (!isAtEndRef.current) stopFollowing();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
          if (
            SCROLL_KEYS.has(event.key) &&
            overflows() &&
            !(
              event.target instanceof Element &&
              event.target.closest("input, textarea, [contenteditable=true]")
            )
          ) {
            stopFollowing();
          }
        };
        node.addEventListener("wheel", handleWheel, { passive: true });
        node.addEventListener("touchmove", handleTouchMove, { passive: true });
        node.ownerDocument.addEventListener("keydown", handleKeyDown);
        removeListeners = () => {
          node.removeEventListener("wheel", handleWheel);
          node.removeEventListener("touchmove", handleTouchMove);
          node.ownerDocument.removeEventListener("keydown", handleKeyDown);
        };
      });
    };
    attach(10);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      removeListeners?.();
    };
  }, [hasEntries, stopFollowing]);

  // The docked bar floats over the timeline; keep the end clear of it.
  const [overlayElement, setOverlayElement] = useState<HTMLDivElement | null>(null);
  const [overlayHeight, setOverlayHeight] = useState(0);
  useLayoutEffect(() => {
    if (overlayElement === null) return;
    const update = () => setOverlayHeight(Math.round(overlayElement.offsetHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(overlayElement);
    return () => observer.disconnect();
  }, [overlayElement]);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <ExternalSessionHeader environmentId={environmentId} summary={summary} />
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ChatCanvas composerOverlayElement={overlayElement}>
            <div className="relative flex min-h-0 flex-1 flex-col bg-background">
              <MessagesTimeline
                isWorking={running}
                runlessWorkActive={running}
                activeTurnInProgress={running}
                activeTurnStartedAt={activeTurnStartedAt}
                listRef={listRef}
                timelineEntries={timelineEntries}
                latestRun={null}
                turnDiffSummaries={NO_TURN_DIFFS}
                routeThreadKey={`external:${environmentId}:${sessionKey}`}
                onOpenTurnDiff={noop}
                onOpenThread={noop}
                onForkFromRun={noopAsync}
                onRollbackCheckpoint={noop}
                supportsConversationRollback={false}
                onRevertToTurnCount={noop}
                isRevertingCheckpoint={false}
                onImageExpand={noop}
                activeThreadEnvironmentId={environmentId}
                markdownCwd={cwd}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={cwd}
                providerStatuses={EMPTY_PROVIDERS}
                runs={NO_RUNS}
                anchorMessageId={null}
                onAnchorReady={noop}
                onAnchorSizeChanged={noop}
                contentInsetEndAdjustment={overlayHeight}
                onIsAtEndChange={onIsAtEndChange}
                liveFollowEnabled={liveFollowEnabled}
                onManualNavigation={stopFollowing}
                hideEmptyPlaceholder={!hasEntries}
                topFadeEnabled
              />
              {showScrollToEnd ? (
                <div
                  className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
                  style={{ bottom: overlayHeight + 4 }}
                >
                  <Button
                    aria-label="Scroll to end"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => scrollToEnd(true)}
                    className="pointer-events-auto"
                    size="xs"
                    variant="glass"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
                  </Button>
                </div>
              ) : null}
            </div>
            <div
              ref={setOverlayElement}
              data-chat-composer-overlay="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
            >
              <div className="chat-composer-lane w-full">
                <div
                  data-chat-composer-stack="true"
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
                >
                  <div className="relative z-10">
                    <ComposerSurface.Shell>
                      <ComposerSurface.Host>
                        <div className="relative z-10">
                          <ExternalSessionBar
                            environmentId={environmentId}
                            sessionKey={sessionKey}
                            summary={summary}
                            hasMessages={hasEntries}
                            truncated={data?.truncated ?? false}
                            loaded={data !== null}
                            error={error}
                            connected={connected}
                            onRetry={refresh}
                          />
                        </div>
                      </ComposerSurface.Host>
                    </ComposerSurface.Shell>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>
          </ChatCanvas>
        </div>
      </div>
    </SidebarInset>
  );
}

/** The chat header's layout: folder / title, then provider, model and state. */
function ExternalSessionHeader(props: {
  environmentId: EnvironmentId;
  summary: ExternalSessionSummary | null;
}) {
  const { summary } = props;
  const title = summary === null ? "Session" : externalSessionTitle(summary);
  const folder = summary === null ? null : cwdBasename(summary.cwd);
  const model = summary?.model ? formatModelSlugName(summary.model) : null;
  const project =
    summary?.cwd != null && folder !== null
      ? { environmentId: props.environmentId, workspaceRoot: summary.cwd, title: folder }
      : null;

  return (
    <header
      data-chat-header
      className={cn(
        "relative bg-background",
        isElectron
          ? "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5"
          : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <WorkspaceBreadcrumb
          ariaLabel="Session breadcrumb"
          className="flex-1 overflow-clip [overflow-clip-margin:2px]"
        >
          {project !== null ? (
            <>
              <WorkspaceBreadcrumbItem className="shrink">
                <span
                  className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-muted-foreground"
                  title={project.workspaceRoot}
                >
                  <ProjectFavicon project={project} className="size-3.5" />
                  <WorkspaceBreadcrumbText className="max-w-40">{folder}</WorkspaceBreadcrumbText>
                </span>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
            </>
          ) : null}
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
            <h2 className="min-w-0" title={title}>
              <WorkspaceBreadcrumbText>{title}</WorkspaceBreadcrumbText>
            </h2>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {summary !== null ? (
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <ProviderInstanceIcon
              driverKind={summary.driver}
              displayName={externalSessionProductName(summary)}
              className="size-4 shrink-0"
              iconClassName="size-4"
            />
            {model !== null ? (
              <span className="max-w-40 truncate max-sm:hidden">{model}</span>
            ) : null}
            <Badge variant={LIVENESS_BADGE_VARIANT[summary.liveness]} size="sm">
              {livenessLine(summary)}
            </Badge>
          </span>
        ) : null}
      </div>
    </header>
  );
}

/** "Running in Claude Desktop", "Idle · Codex CLI". */
function livenessLine(summary: ExternalSessionSummary): string {
  const origin = externalSessionOriginLabel(summary);
  switch (summary.liveness) {
    case "running":
      return `Running in ${origin}`;
    case "idle":
      return `Idle · ${origin}`;
    case "recent":
      return `Inactive · ${origin}`;
  }
}

/**
 * Stands in for the composer, as the subagent bar does: what the session is
 * doing, and either "Continue in T3" or why it cannot be continued yet.
 */
function ExternalSessionBar(props: {
  environmentId: EnvironmentId;
  sessionKey: string;
  summary: ExternalSessionSummary | null;
  hasMessages: boolean;
  truncated: boolean;
  loaded: boolean;
  error: string | null;
  connected: boolean;
  onRetry: () => void;
}) {
  const { environmentId, sessionKey, summary } = props;
  const navigate = useNavigate();
  const runContinue = useAtomCommand(externalSessionContinue, { reportFailure: false });
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  const handleContinue = useCallback(async () => {
    setContinuing(true);
    setContinueError(null);
    const result = await runContinue({ environmentId, input: { key: sessionKey } });
    if (result._tag === "Failure") {
      setContinuing(false);
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setContinueError(
          failure instanceof Error ? failure.message : "Could not continue this session in T3.",
        );
      }
      return;
    }
    const threadRef = scopeThreadRef(environmentId, result.value.threadId);
    // The thread route treats a thread missing from the shell as gone.
    if (!(await waitForThreadShell(threadRef))) {
      setContinuing(false);
      setContinueError(
        "The thread was created, but it has not reached this client yet. Open it from the sidebar.",
      );
      return;
    }
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  }, [environmentId, navigate, runContinue, sessionKey]);

  const model = summary?.model ? formatModelSlugName(summary.model) : null;
  const unsupported = summary === null ? null : externalSessionUnsupportedReason(summary);
  const canContinue =
    summary !== null &&
    summary.liveness !== "running" &&
    unsupported === null &&
    props.hasMessages &&
    props.connected;

  let status: string;
  let tone: "muted" | "error" = "muted";
  if (props.error !== null) {
    status = `Could not load this session. ${props.error}`;
    tone = "error";
  } else if (!props.connected) {
    status = props.loaded ? "Disconnected. Reconnecting…" : "Waiting for the environment…";
  } else if (summary === null) {
    status = "Loading session…";
  } else if (continueError !== null) {
    status = continueError;
    tone = "error";
  } else if (summary.liveness === "running") {
    status = `Running in ${externalSessionOriginLabel(summary)}. Stop it there to continue here.`;
  } else if (unsupported !== null) {
    status = EXTERNAL_SESSION_UNSUPPORTED_MESSAGES[unsupported];
  } else if (!props.hasMessages) {
    status = "No messages yet.";
  } else {
    status = props.truncated
      ? `${livenessLine(summary)} · Older messages are not shown`
      : livenessLine(summary);
  }

  return (
    <div className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm">
      {summary !== null ? (
        <span className="flex min-w-0 shrink-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={summary.driver}
            displayName={externalSessionProductName(summary)}
            className="size-4 shrink-0"
            iconClassName="size-4"
          />
          {model !== null ? (
            <span className="max-w-40 truncate font-medium text-foreground max-sm:hidden">
              {model}
            </span>
          ) : null}
        </span>
      ) : null}
      <span
        role="status"
        title={status}
        className={cn(
          "min-w-0 flex-1 truncate",
          tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {status}
      </span>
      {props.error !== null ? (
        <Button size="sm" variant="ghost" onClick={props.onRetry}>
          Retry
        </Button>
      ) : canContinue ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={continuing}
          onClick={() => void handleContinue()}
        >
          {continuing ? "Continuing…" : "Continue in T3"}
        </Button>
      ) : null}
    </div>
  );
}
