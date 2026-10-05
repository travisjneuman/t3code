/**
 * One side of a comparison, shown the way a thread is: the standard chat
 * timeline (messages, tool work, diffs, images, the working row) under a
 * small header naming the side's provider and model. Diffs and related
 * threads open in the thread itself. Fork add-on: compare agents.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveLatestThreadRun,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  type EnvironmentId,
  modelSelectionLabel,
  providerInstanceLabel,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { ChatCanvas } from "../components/chat/ChatCanvas";
import { ExpandedImageDialog } from "../components/chat/ExpandedImageDialog";
import {
  type ExpandedImagePreview,
  expandedImageKey,
} from "../components/chat/ExpandedImagePreview";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { useDiffPanelStore } from "../diffPanelStore";
import { useTimelineLiveFollow } from "../forkTimelineLiveFollow";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useRightPanelStore } from "../rightPanelStore";
import {
  derivePhase,
  deriveActiveWorkStartedAt,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  isLatestRunSettled,
  type TimelineEntriesProjection,
} from "../session-logic";
import { useProjects, useThreadProjection, useThreadVisibleTurnItems } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const noop = () => {};
const noopAsync = async () => {};

export function CompareThreadColumn(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const { environmentId, threadId } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { timestampFormat } = useEnvironmentSettings(environmentId);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const visibleTurnItems = useThreadVisibleTurnItems(threadRef);

  // The previous projection lets unchanged rows keep their identity, as in ChatView.
  const timelineProjectionRef = useRef<{
    readonly threadKey: string;
    readonly projection: TimelineEntriesProjection;
  } | null>(null);
  const threadKey = `${environmentId}:${threadId}`;
  const timelineEntries = useMemo(() => {
    const previous = timelineProjectionRef.current;
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      {
        visibleTurnItems,
        optimisticMessages: [],
        ...(projection === null
          ? {}
          : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
      },
      previous?.threadKey === threadKey ? previous.projection : null,
    );
    timelineProjectionRef.current = { threadKey, projection: next };
    return next.entries;
  }, [projection, threadKey, visibleTurnItems]);

  const latestRun = useMemo(
    () => (projection === null ? null : deriveLatestThreadRun(projection)),
    [projection],
  );
  const activityRun = useMemo(
    () => (projection === null ? null : deriveThreadActivityRun(projection)),
    [projection],
  );
  const runtime = useMemo(
    () => (projection === null ? null : deriveThreadRuntime(projection)),
    [projection],
  );
  const runlessWorkStartedAt = useMemo(
    () => (projection === null ? null : deriveRunlessWorkStartedAt(projection)),
    [projection],
  );
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const activeTurnInProgress = isWorking || !isLatestRunSettled(latestRun, runtime);
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;
  const { turnDiffSummaries } = useTurnDiffSummaries(projection);

  const hasEntries = timelineEntries.length > 0;
  const {
    listRef,
    liveFollowEnabled,
    showScrollToEnd,
    scrollToEnd,
    onIsAtEndChange,
    stopFollowing,
  } = useTimelineLiveFollow(hasEntries);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  const openThread = useCallback(
    (target: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, target)),
      }),
    [environmentId, navigate],
  );
  const onOpenTurnDiff = useCallback(
    (runId: RunId, filePath?: string) => {
      useDiffPanelStore.getState().selectTurn(threadRef, runId, filePath);
      useRightPanelStore.getState().open(threadRef, "diff");
      openThread(threadId);
    },
    [openThread, threadId, threadRef],
  );

  if (projection === null) {
    return <p className="p-4 text-sm text-muted-foreground">Loading this side…</p>;
  }
  const selection = projection.thread.modelSelection;
  const workspaceRoot =
    projection.thread.worktreePath ??
    projects.find(
      (project) =>
        project.environmentId === environmentId && project.id === projection.thread.projectId,
    )?.workspaceRoot;
  const providerStatuses =
    environments.find((entry) => entry.environmentId === environmentId)?.serverConfig?.providers ??
    EMPTY_PROVIDERS;

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {providerInstanceLabel(projection, selection.instanceId)}
          </p>
          <p className="truncate text-xs text-muted-foreground">{modelSelectionLabel(selection)}</p>
        </div>
        {activeTurnInProgress ? <Spinner /> : null}
        <Button size="sm" variant="ghost" onClick={() => openThread(threadId)}>
          Open thread
        </Button>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ChatCanvas composerOverlayElement={null}>
          <div className="relative flex min-h-0 flex-1 flex-col bg-background">
            <MessagesTimeline
              isWorking={isWorking}
              runlessWorkActive={runlessWorkStartedAt !== null}
              activeTurnInProgress={activeTurnInProgress}
              activeTurnStartedAt={activeWorkStartedAt}
              listRef={listRef}
              timelineEntries={timelineEntries}
              latestRun={activityRun}
              runningRunId={runtime?.activeRunId ?? null}
              turnDiffSummaries={turnDiffSummaries}
              routeThreadKey={`compare:${threadKey}`}
              onOpenTurnDiff={onOpenTurnDiff}
              onOpenThread={openThread}
              onForkFromRun={noopAsync}
              onRollbackCheckpoint={noop}
              supportsConversationRollback={false}
              onRevertToTurnCount={noop}
              isRevertingCheckpoint={false}
              onImageExpand={setExpandedImage}
              activeThreadEnvironmentId={environmentId}
              markdownCwd={workspaceRoot}
              resolvedTheme={resolvedTheme}
              timestampFormat={timestampFormat}
              workspaceRoot={workspaceRoot}
              providerStatuses={providerStatuses}
              runs={projection.runs}
              anchorMessageId={null}
              onAnchorReady={noop}
              onAnchorSizeChanged={noop}
              contentInsetEndAdjustment={0}
              onIsAtEndChange={onIsAtEndChange}
              liveFollowEnabled={liveFollowEnabled}
              onManualNavigation={stopFollowing}
              hideEmptyPlaceholder={!hasEntries}
              topFadeEnabled
            />
            {showScrollToEnd ? (
              <div className="chat-scroll-to-bottom pointer-events-none absolute bottom-1 z-30 flex justify-center py-1.5">
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
        </ChatCanvas>
      </div>
      {expandedImage ? (
        <ExpandedImageDialog
          key={expandedImageKey(expandedImage)}
          preview={expandedImage}
          onClose={() => setExpandedImage(null)}
        />
      ) : null}
    </section>
  );
}
