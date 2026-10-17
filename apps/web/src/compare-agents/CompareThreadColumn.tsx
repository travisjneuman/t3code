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
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

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
import { useIncrementalTimelineEntries } from "../hooks/useIncrementalTimelineEntries";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useRightPanelStore } from "../rightPanelStore";
import {
  derivePhase,
  deriveActiveWorkStartedAt,
  isLatestRunSettled,
  type TimelineEntriesInput,
} from "../session-logic";
import {
  useProjects,
  useThreadCheckpointSummaries,
  useThreadProjection,
  useThreadVisibleTurnItems,
} from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";

const EMPTY_OPTIMISTIC_MESSAGES: TimelineEntriesInput["optimisticMessages"] = [];
const noop = () => {};
const noopAsync = async () => {};

export function CompareThreadColumn(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const { environmentId, threadId } = props;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { timestampFormat } = useEnvironmentSettings(environmentId);
  const projects = useProjects();
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const visibleTurnItems = useThreadVisibleTurnItems(threadRef);

  // The previous projection lets unchanged rows keep their identity, as in ChatView.
  const threadKey = `${environmentId}:${threadId}`;
  const timelineEntries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems,
    optimisticMessages: EMPTY_OPTIMISTIC_MESSAGES,
    ...(projection === null
      ? {}
      : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
  });

  const latestRun = projection === null ? null : deriveLatestThreadRun(projection);
  const activityRun = projection === null ? null : deriveThreadActivityRun(projection);
  const runtime = projection === null ? null : deriveThreadRuntime(projection);
  const runlessWorkStartedAt = projection === null ? null : deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const activeTurnInProgress = isWorking || !isLatestRunSettled(latestRun, runtime);
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;
  const turnDiffSummaries = useThreadCheckpointSummaries(threadRef);

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

  const openThread = (target: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, target)),
    });
  const onOpenTurnDiff = (runId: RunId, filePath?: string) => {
    useDiffPanelStore.getState().selectTurn(threadRef, runId, filePath);
    useRightPanelStore.getState().open(threadRef, "diff");
    openThread(threadId);
  };

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
