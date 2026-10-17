/**
 * One sidebar capsule per update waiting for active sessions, with Update now
 * and Cancel. Fork add-on: maintenance queue.
 *
 * @module maintenance-queue/MaintenanceQueueCapsule
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentationWithProviders } from "@t3tools/client-runtime/state/presentation";
import { ClockIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { getDesktopUpdateActionError } from "../components/desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { environmentPresentations } from "../state/presentation";
import {
  busySessionCount,
  jobInstanceIds,
  subscribeActivity,
  thisMachineBusySessionCount,
} from "./activity";
import { useDesktopUpdateGateState } from "./desktopGate";
import {
  queuedUpdateKey,
  queuedUpdateTitle,
  removeQueuedUpdate,
  useQueuedUpdates,
  type QueuedUpdate,
} from "./queueStore";
import { runQueuedUpdateNow, waitingLine } from "./runner";

function toastError(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An unexpected error occurred.",
    }),
  );
}

function WaitingCapsule({
  title,
  line,
  onUpdateNow,
  onCancel,
}: {
  readonly title: string;
  readonly line: string;
  readonly onUpdateNow: () => Promise<void>;
  readonly onCancel: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const act = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  const buttonClass =
    "relative shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 opacity-70 outline-none hover:bg-sidebar-row-hover hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-40";
  return (
    <div className="flex min-h-7 w-full shrink-0 items-center gap-1 rounded-lg bg-sidebar-control-surface pr-1 text-2xs leading-4 font-medium text-sidebar-foreground">
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2">
              <ClockIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 wrap-break-word">{line}</span>
            </div>
          }
        />
        <TooltipPopup side="top">
          {title} runs once these sessions finish and stay idle for 2 minutes.
        </TooltipPopup>
      </Tooltip>
      <button
        type="button"
        className={buttonClass}
        disabled={busy}
        onClick={() => act(onUpdateNow)}
      >
        Update now
      </button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => act(onCancel)}>
        Cancel
      </button>
    </div>
  );
}

function DesktopHoldCapsule() {
  const { queuedAt } = useDesktopUpdateGateState();
  const busyCount = useSyncExternalStore(
    subscribeActivity,
    thisMachineBusySessionCount,
    thisMachineBusySessionCount,
  );
  const gate = window.desktopBridge?.updateGate;
  if (queuedAt === null || !gate) return null;
  return (
    <WaitingCapsule
      title="The app update"
      line={waitingLine(busyCount, "this computer")}
      onUpdateNow={async () => {
        try {
          const result = await gate.installNow();
          const error = result.accepted
            ? getDesktopUpdateActionError(result)
            : (result.state.message ?? "The update is no longer ready to install.");
          if (error !== null) toastError("Could not install update", new Error(error));
        } catch (error) {
          toastError("Could not install update", error);
        }
      }}
      onCancel={async () => {
        try {
          await gate.cancel();
        } catch (error) {
          toastError("Could not cancel the update", error);
        }
      }}
    />
  );
}

function QueuedJobCapsule({
  job,
  presentation,
}: {
  readonly job: QueuedUpdate;
  readonly presentation: EnvironmentPresentationWithProviders | undefined;
}) {
  const instanceIds = jobInstanceIds(job, presentation?.serverConfig ?? null);
  const getBusyCount = () => busySessionCount(job.environmentId, instanceIds);
  const busyCount = useSyncExternalStore(subscribeActivity, getBusyCount, getBusyCount);
  const key = queuedUpdateKey(job);
  const host = presentation?.entry.target.label ?? "a disconnected host";
  const line =
    presentation?.connection.phase !== "connected"
      ? `Waiting for ${host} to reconnect`
      : waitingLine(busyCount, host);
  return (
    <WaitingCapsule
      title={queuedUpdateTitle(job)}
      line={line}
      onUpdateNow={() => runQueuedUpdateNow(key)}
      onCancel={async () => removeQueuedUpdate(key)}
    />
  );
}

export function MaintenanceQueueCapsule() {
  const jobs = useQueuedUpdates();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  return (
    <>
      <DesktopHoldCapsule />
      {jobs.map((job) => (
        <QueuedJobCapsule
          key={queuedUpdateKey(job)}
          job={job}
          presentation={presentations.get(job.environmentId)}
        />
      ))}
    </>
  );
}
