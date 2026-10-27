import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EXTERNAL_SESSION_UNSUPPORTED_MESSAGES,
  externalSessionOpensInOrigin,
  externalSessionUnsupportedReason,
  MessageId,
  type EnvironmentId,
  type ExternalSessionMessage,
  type ExternalSessionSummary,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  PlayIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

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
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../components/ui/anchoredCopyToast";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";
import { useTimelineLiveFollow } from "../forkTimelineLiveFollow";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTheme } from "../hooks/useTheme";
import { formatContextWindowTokens } from "../lib/contextWindow";
import { cn } from "../lib/utils";
import type { TimelineEntry } from "../session-logic";
import { waitForThreadShell } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../timestampFormat";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import {
  cwdBasename,
  externalSessionContinue,
  externalSessionOpenInOrigin,
  externalSessionOriginIsLocalAtom,
  externalSessionOriginLabel,
  externalSessionProductName,
  externalSessionSettingLabel,
  externalSessionTitle,
  externalSessionTranscript,
  LIVENESS_LABEL,
  shortModelLabel,
} from "./atoms";
import { ExternalSessionDetailsCard } from "./ExternalSessionDetails";
import { useExternalSessionPanel } from "./ExternalSessionPanel";

const EMPTY_MESSAGES: ReadonlyArray<ExternalSessionMessage> = [];
const NO_TURN_DIFFS: [] = [];
const NO_RUNS: [] = [];
/** Tool lines show their first line, capped, like a standard tool row label. */
const TOOL_LABEL_MAX_CHARS = 240;

const LIVENESS_DESCRIPTION = {
  running: "A turn is in progress",
  idle: "No turn running; active in the last hour",
  recent: "No activity in the last hour",
} as const satisfies Record<ExternalSessionSummary["liveness"], string>;

/**
 * A composer toolbar control's look at its expanded size, without the button
 * behavior, since these chips only describe the session. Mirrors
 * `composerControlClassName(size: "sm")` in components/chat/ComposerControl.tsx.
 */
const SESSION_CHIP_CLASS_NAME =
  "relative inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-(--control-radius) border border-transparent px-2.5 text-base font-medium text-secondary-label sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4";

const noop = () => {};
const noopAsync = async () => {};

function toTimelineEntry(message: ExternalSessionMessage): TimelineEntry {
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
  return entry;
}

/**
 * The transcript reducer preserves unchanged messages. Retain their entries
 * in render state, so appends preserve row identity without mutating a shared cache.
 */
function useSessionTimelineEntries(
  messages: ReadonlyArray<ExternalSessionMessage>,
  running: boolean,
): ReadonlyArray<TimelineEntry> {
  const [projection, setProjection] = useState(() => ({
    messages,
    entries: messages.map(toTimelineEntry),
  }));
  let current = projection;
  if (projection.messages !== messages) {
    const previous = new Map(
      projection.messages.map((message, index) => [message, projection.entries[index]] as const),
    );
    current = {
      messages,
      entries: messages.map((message) => previous.get(message) ?? toTimelineEntry(message)),
    };
    setProjection(current);
  }
  // While the session runs, its last reply is still being written.
  const entries = [...current.entries];
  const last = entries.at(-1);
  if (running && last?.kind === "message" && last.message.role === "assistant") {
    entries[entries.length - 1] = { ...last, message: { ...last.message, streaming: true } };
  }
  return entries;
}

/**
 * An agent session running outside T3, shown the way a T3 thread is: the same
 * layout, header, timeline, details card and composer-shaped block. The block
 * stands in for the composer; an idle session can be continued as a T3 thread
 * from there.
 * Key it by environment and session so switching sessions starts fresh.
 */
export function ExternalSessionView(props: { environmentId: EnvironmentId; sessionKey: string }) {
  const { environmentId, sessionKey } = props;
  const atom = externalSessionTranscript({ environmentId, input: { key: sessionKey } });
  const { data, error, refresh } = useEnvironmentQuery(atom);
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const { resolvedTheme } = useTheme();
  const { timestampFormat } = useEnvironmentSettings(environmentId);

  const summary = data?.summary ?? null;
  const messages = data?.messages ?? EMPTY_MESSAGES;
  const running = summary?.liveness === "running";
  const timelineEntries = useSessionTimelineEntries(messages, running);
  const activeTurnStartedAt = running
    ? (messages.findLast((message) => message.role === "user")?.createdAt ?? null)
    : null;
  const cwd = summary?.cwd ?? undefined;
  const hasEntries = timelineEntries.length > 0;

  const {
    listRef,
    liveFollowEnabled,
    showScrollToEnd,
    scrollToEnd,
    onIsAtEndChange,
    stopFollowing,
  } = useTimelineLiveFollow(hasEntries);

  // The docked block floats over the timeline; keep the end clear of it.
  const [overlayElement, setOverlayElement] = useState<HTMLDivElement | null>(null);
  const [overlayHeight, setOverlayHeight] = useState(0);
  const measureOverlayOnAttach = useStableCallback((element: HTMLDivElement | null) => {
    setOverlayElement(element);
    if (element !== null) setOverlayHeight(Math.round(element.offsetHeight));
  });
  useLayoutEffect(() => {
    if (overlayElement === null) return;
    const update = () => setOverlayHeight(Math.round(overlayElement.offsetHeight));
    const observer = new ResizeObserver(update);
    observer.observe(overlayElement);
    return () => observer.disconnect();
  }, [overlayElement]);
  const sidePanel = useExternalSessionPanel(environmentId);
  // The details card opens as a popover under the header when the canvas is too narrow.
  const headerRef = useRef<HTMLElement | null>(null);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      {/* ChatView's workspace row and chat column, so the column, header and
          composer land where a thread's do in the same window. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
          <ExternalSessionHeader
            headerRef={headerRef}
            environmentId={environmentId}
            summary={summary}
            controls={sidePanel.headerControls}
          />
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
              {/* ChatView's docked composer overlay, lane, stack and surface. */}
              <div
                ref={measureOverlayOnAttach}
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
                            <ExternalSessionComposerBlock
                              environmentId={environmentId}
                              sessionKey={sessionKey}
                              summary={summary}
                              hasMessages={hasEntries}
                              truncated={data?.truncated ?? false}
                              loaded={data !== null}
                              error={error}
                              connected={connected}
                              timestampFormat={timestampFormat}
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
              {summary !== null ? (
                <ExternalSessionDetailsCard
                  environmentId={environmentId}
                  sessionKey={sessionKey}
                  summary={summary}
                  anchor={headerRef}
                  card={sidePanel.details}
                />
              ) : null}
            </ChatCanvas>
          </div>
        </div>
        {sidePanel.rootControls}
        {sidePanel.panel}
      </div>
    </SidebarInset>
  );
}

/**
 * The thread header's layout (ChatView's header plus ChatHeader's breadcrumb
 * row): folder / title. The right side holds the details card and side panel
 * toggles where a thread keeps its own; the card is anchored to this header.
 */
function ExternalSessionHeader(props: {
  headerRef: RefObject<HTMLElement | null>;
  environmentId: EnvironmentId;
  summary: ExternalSessionSummary | null;
  controls: ReactNode;
}) {
  const { summary } = props;
  const title = summary === null ? "Session" : externalSessionTitle(summary);
  const folder = summary === null ? null : cwdBasename(summary.cwd);
  const project =
    summary?.cwd != null && folder !== null
      ? { environmentId: props.environmentId, workspaceRoot: summary.cwd, title: folder }
      : null;

  return (
    <header
      ref={props.headerRef}
      data-chat-header
      className={cn(
        "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
        isElectron
          ? "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5 wco:pr-(--workspace-native-controls-inset)"
          : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      {/* ChatHeader's row; pr-24 is the room a thread reserves for its panel toggles. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 pr-24 sm:gap-3">
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
            <Tooltip>
              <TooltipTrigger render={<h2 aria-label={title} className="min-w-0 flex-1" />}>
                <WorkspaceBreadcrumbText>{title}</WorkspaceBreadcrumbText>
              </TooltipTrigger>
              <TooltipPopup side="top">{title}</TooltipPopup>
            </Tooltip>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </div>
      {props.controls}
    </header>
  );
}

interface ComposerBlockState {
  /** The one-line explanation in the prompt area. */
  readonly message: string;
  readonly tone: "muted" | "error";
  /** Why "Continue in T3" is unavailable; null when it can run. */
  readonly blockedReason: string | null;
}

function resolveComposerBlockState(input: {
  summary: ExternalSessionSummary | null;
  hasMessages: boolean;
  loaded: boolean;
  error: string | null;
  connected: boolean;
  /** This connection's grants allow continuing sessions. */
  canContinue: boolean;
  continueError: string | null;
}): ComposerBlockState {
  const { summary } = input;
  if (input.error !== null) {
    const message = `Could not load this session. ${input.error}`;
    return { message, tone: "error", blockedReason: message };
  }
  if (!input.connected) {
    const message = input.loaded ? "Disconnected. Reconnecting…" : "Waiting for the environment…";
    return { message, tone: "muted", blockedReason: message };
  }
  if (summary === null) {
    return { message: "Loading session…", tone: "muted", blockedReason: "Loading session…" };
  }
  const origin = externalSessionOriginLabel(summary);
  const unsupported = externalSessionUnsupportedReason(summary);
  let message: string;
  let blockedReason: string | null = null;
  if (summary.liveness === "running") {
    message = `Running in ${origin} — stop it there to continue here.`;
    blockedReason = `Stop the session in ${origin} first.`;
  } else if (unsupported === "provider") {
    message = `${externalSessionProductName(summary)} sessions can't be continued in T3 yet.`;
    blockedReason = message;
  } else if (unsupported !== null) {
    message = EXTERNAL_SESSION_UNSUPPORTED_MESSAGES[unsupported];
    blockedReason = message;
  } else if (!input.canContinue) {
    message = "This connection can't continue sessions.";
    blockedReason = message;
  } else if (!input.hasMessages) {
    message = "No messages yet.";
    blockedReason = "Nothing to continue yet.";
  } else {
    message = `Continue this ${origin} session in T3 to reply here.`;
  }
  return input.continueError !== null
    ? { message: input.continueError, tone: "error", blockedReason }
    : { message, tone: "muted", blockedReason };
}

/**
 * Stands in for the composer and keeps its shape. The prompt area explains the
 * session's state in the placeholder's style, the toolbar row shows the model
 * and status where the composer's pickers sit, and "Continue in T3" sits where
 * the send button does. The classes mirror ChatComposer's expanded layout;
 * each part names its source.
 */
function ExternalSessionComposerBlock(props: {
  environmentId: EnvironmentId;
  sessionKey: string;
  summary: ExternalSessionSummary | null;
  hasMessages: boolean;
  truncated: boolean;
  loaded: boolean;
  error: string | null;
  connected: boolean;
  timestampFormat: TimestampFormat;
  onRetry: () => void;
}) {
  const { environmentId, sessionKey, summary } = props;
  const details = summary?.details;
  const effort = details?.effort === undefined ? null : externalSessionSettingLabel(details.effort);
  const effortKind = summary?.driver === "pi" ? "Thinking level" : "Reasoning effort";
  const branches = details?.gitBranches ?? [];
  const navigate = useNavigate();
  const runContinue = useAtomCommand(externalSessionContinue, { reportFailure: false });
  const canContinue = useAtomValue(externalSessionContinue.permissionAtom(environmentId));
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  const handleContinue = async () => {
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
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const { message, tone, blockedReason } = resolveComposerBlockState({
    summary,
    hasMessages: props.hasMessages,
    loaded: props.loaded,
    error: props.error,
    connected: props.connected,
    canContinue,
    continueError,
  });
  const continueTooltip = continuing
    ? "Opening this session as a T3 thread…"
    : (blockedReason ?? "Open this session as a T3 thread and reply here");
  const continueBlocked = blockedReason !== null || continuing;

  return (
    // ChatComposer's <form> and the wrapper around its main surface.
    <div className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)">
      <div className="relative">
        <ComposerSurface.Main>
          <div className="rounded-3xl">
            {/* ChatComposer's body padding and prompt type: the session's state
                in the placeholder's style, then its details. Nothing here
                accepts typing. */}
            <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
              <div className="flex min-h-19.5 flex-col gap-2 font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)">
                <p
                  role="status"
                  className={cn(
                    "line-clamp-2 wrap-break-word leading-relaxed",
                    tone === "error" ? "text-destructive-foreground" : "text-placeholder/75",
                  )}
                >
                  {message}
                  {props.truncated && props.hasMessages ? (
                    <span className="ms-2 text-xs text-muted-foreground/70">
                      Showing recent messages only.
                    </span>
                  ) : null}
                </p>
                {summary !== null ? (
                  <SessionDetails summary={summary} timestampFormat={props.timestampFormat} />
                ) : null}
              </div>
            </div>
            {/* ChatComposer's bottom toolbar: controls left, primary action right. */}
            <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:gap-0 sm:px-4 sm:pb-4">
              <div className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {summary !== null ? (
                  <>
                    {/* ProviderModelPicker's trigger content, without the menu. */}
                    <SessionChip
                      tooltip={
                        summary.model
                          ? formatModelSlugName(summary.model)
                          : externalSessionProductName(summary)
                      }
                      className="-ms-2.5"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <ProviderInstanceIcon
                          driverKind={summary.driver}
                          displayName={externalSessionProductName(summary)}
                          className="size-4"
                          iconClassName="size-4"
                        />
                        <span className="min-w-0 flex-1 overflow-hidden truncate">
                          {shortModelLabel(summary.model) ?? externalSessionProductName(summary)}
                        </span>
                      </span>
                    </SessionChip>
                    {effort !== null ? (
                      // TraitsPicker's effort control, read-only.
                      <SessionChip tooltip={`${effortKind}: ${effort}`}>
                        <BrainIcon aria-hidden />
                        {effort}
                      </SessionChip>
                    ) : null}
                    {branches.length > 0 ? (
                      <SessionChip tooltip={<BranchList branches={branches} />}>
                        <GitBranchIcon aria-hidden />
                        <span className="max-w-40 truncate">{branches[0]}</span>
                        {branches.length > 1 ? (
                          <span className="text-muted-foreground">+{branches.length - 1}</span>
                        ) : null}
                      </SessionChip>
                    ) : null}
                    <OriginChip
                      environmentId={environmentId}
                      sessionKey={sessionKey}
                      summary={summary}
                    />
                    <SessionChip tooltip={LIVENESS_DESCRIPTION[summary.liveness]}>
                      {summary.liveness === "running" ? (
                        <CircleDashedIcon aria-hidden className="text-info-foreground" />
                      ) : null}
                      {LIVENESS_LABEL[summary.liveness]}
                    </SessionChip>
                  </>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                {props.error !== null ? (
                  <Button variant="default" size="default" onClick={props.onRetry}>
                    Retry
                  </Button>
                ) : (
                  <Tooltip>
                    {/* aria-disabled, not disabled: the button keeps pointer
                        events, so the reason stays reachable. */}
                    <TooltipTrigger
                      render={
                        <Button
                          variant="default"
                          size="default"
                          aria-disabled={continueBlocked || undefined}
                          aria-busy={continuing || undefined}
                          onClick={() => {
                            if (!continueBlocked) void handleContinue();
                          }}
                        />
                      }
                    >
                      {continuing ? (
                        <Spinner aria-hidden />
                      ) : (
                        <PlayIcon aria-hidden className="fill-current" />
                      )}
                      Continue in T3
                    </TooltipTrigger>
                    <TooltipPopup>{continueTooltip}</TooltipPopup>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        </ComposerSurface.Main>
      </div>
    </div>
  );
}

/** A read-only toolbar chip; see SESSION_CHIP_CLASS_NAME. */
function SessionChip(props: { tooltip: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn(SESSION_CHIP_CLASS_NAME, props.className)} />}>
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Where the session runs; opens it there when that app takes a link to one session. */
function OriginChip(props: {
  environmentId: EnvironmentId;
  sessionKey: string;
  summary: ExternalSessionSummary;
}) {
  const { environmentId, sessionKey, summary } = props;
  const label = externalSessionOriginLabel(summary);
  const originIsLocal = useAtomValue(externalSessionOriginIsLocalAtom(environmentId));
  const canOpen = useAtomValue(externalSessionOpenInOrigin.permissionAtom(environmentId));
  const runOpen = useAtomCommand(externalSessionOpenInOrigin, { reportFailure: false });
  const handleOpen = async () => {
    if (!originIsLocal || !canOpen) return;
    const result = await runOpen({ environmentId, input: { key: sessionKey } });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Failed to open ${label}`,
      description: failure instanceof Error ? failure.message : "An error occurred.",
    });
  };
  if (!originIsLocal || !canOpen || !externalSessionOpensInOrigin(summary)) {
    return <SessionChip tooltip={`Session from ${label}`}>{label}</SessionChip>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(SESSION_CHIP_CLASS_NAME, "cursor-pointer hover:text-foreground")}
            onClick={() => void handleOpen()}
          />
        }
      >
        {label}
        <ExternalLinkIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Open this session in {label}</TooltipPopup>
    </Tooltip>
  );
}

/** Every branch the session ran on, most recently used first. */
function BranchList(props: { branches: ReadonlyArray<string> }) {
  if (props.branches.length === 1) return <>Branch: {props.branches[0]}</>;
  return (
    <div className="flex flex-col">
      <span>Branches, most recent first:</span>
      {props.branches.map((branch) => (
        <span key={branch}>{branch}</span>
      ))}
    </div>
  );
}

/** The agent's own session id, in full; clicking copies it. */
function SessionIdValue(props: { sessionId: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: "session ID",
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={ref}
            type="button"
            aria-label={`Copy session ID ${props.sessionId}`}
            className="flex min-w-0 items-center gap-1 rounded-sm font-medium text-secondary-label hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
            onClick={() => copyToClipboard(props.sessionId, undefined)}
          />
        }
      >
        <span className="min-w-0 truncate">{props.sessionId}</span>
        <CopyIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipPopup side="top">Click to copy</TooltipPopup>
    </Tooltip>
  );
}

interface DetailItem {
  readonly label: string;
  readonly value: string;
  /** Full text when the value is abbreviated. */
  readonly title?: string;
}

/**
 * What the agent's store records about the session, most useful first; the
 * details row drops whole items from the end when they don't fit. Branches
 * live in the toolbar.
 */
function sessionDetailItems(
  summary: ExternalSessionSummary,
  timestampFormat: TimestampFormat,
): ReadonlyArray<DetailItem> {
  const details = summary.details;
  const items: Array<DetailItem> = [];
  const add = (label: string, value: string | undefined, title?: string) => {
    if (value !== undefined && value !== "")
      items.push({ label, value, ...(title ? { title } : {}) });
  };
  const timestamp = (label: string, iso: string | undefined) => {
    if (iso === undefined) return;
    add(
      label,
      formatDayAwareTimestamp(iso, timestampFormat),
      formatChatTimestampTooltip(iso, timestampFormat),
    );
  };
  const setting = (value: string | undefined) =>
    value === undefined ? undefined : externalSessionSettingLabel(value);

  timestamp("Last active", summary.updatedAt);
  timestamp("Started", details?.createdAt);
  if (details?.contextTokens !== undefined) {
    const used = formatContextWindowTokens(details.contextTokens);
    add(
      "Context",
      details.contextWindow === undefined
        ? used
        : `${used} / ${formatContextWindowTokens(details.contextWindow)}`,
    );
  }
  add("Permissions", setting(details?.approval));
  add("Version", details?.version);
  add("Sandbox", setting(details?.sandbox));
  add("Messages", details?.messageCount?.toLocaleString());
  add("Steps", details?.stepCount?.toLocaleString());
  if (details?.totalTokens !== undefined) {
    add("Total processed", formatContextWindowTokens(details.totalTokens));
  }
  return items;
}

/**
 * The session's details in the prompt area, two rows so the block keeps the
 * empty composer's height: where it lives, then what it recorded.
 */
function SessionDetails(props: {
  summary: ExternalSessionSummary;
  timestampFormat: TimestampFormat;
}) {
  const { summary } = props;
  const items = sessionDetailItems(summary, props.timestampFormat);
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs leading-4">
      <div className="flex min-w-0 items-center gap-4">
        <span className="flex min-w-0 gap-1" title={summary.cwd}>
          <span className="shrink-0 text-muted-foreground">Folder</span>
          <span className="min-w-0 truncate font-medium text-secondary-label">{summary.cwd}</span>
        </span>
        {summary.details !== undefined ? (
          <span className="flex min-w-0 gap-1">
            <span className="shrink-0 text-muted-foreground">Session</span>
            <SessionIdValue sessionId={summary.details.sessionId} />
          </span>
        ) : null}
      </div>
      {items.length > 0 ? (
        // One line; items that wrap are clipped whole.
        <dl className="flex h-4 min-w-0 flex-wrap gap-x-4 overflow-hidden">
          {items.map((item) => (
            <div key={item.label} className="flex shrink-0 gap-1" title={item.title}>
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className="font-medium tabular-nums text-secondary-label">{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
