/**
 * Watches each environment's active sessions, runs queued updates once their
 * target settles idle, and keeps the desktop app's update gate informed.
 * Rechecks on an interval and whenever the window wakes, refocuses, or comes
 * back online. Renders nothing. Fork add-on: maintenance queue.
 *
 * @module maintenance-queue/MaintenanceQueueCoordinator
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentPresentations } from "../state/presentation";
import {
  busyThreadInstancesAtom,
  recordBusyThreads,
  recordConnected,
  subscribeActivity,
  thisMachineBusySessionCount,
} from "./activity";
import {
  getDesktopUpdateGateState,
  reportThisMachineBusySessions,
  watchDesktopUpdateGate,
} from "./desktopGate";
import { LONG_WAIT_MS, processQueuedUpdates, waitingLine } from "./runner";

const CHECK_INTERVAL_MS = 30_000;

function EnvironmentActivityWatcher({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const busyThreads = useAtomValue(busyThreadInstancesAtom(environmentId));
  useEffect(() => {
    recordBusyThreads(environmentId, busyThreads);
  }, [environmentId, busyThreads]);
  useEffect(() => {
    recordConnected(environmentId, connected);
  }, [environmentId, connected]);
  return null;
}

let notifiedDesktopHoldAt: number | null = null;

function notifyLongDesktopHold(now: number): void {
  const { queuedAt } = getDesktopUpdateGateState();
  if (queuedAt === null || queuedAt === notifiedDesktopHoldAt || now - queuedAt < LONG_WAIT_MS) {
    return;
  }
  notifiedDesktopHoldAt = queuedAt;
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "App update has waited 4 hours",
      description: `${waitingLine(thisMachineBusySessionCount(), "this computer")}. Use Update now in the sidebar to install it anyway.`,
      timeout: 0,
    }),
  );
}

function useMaintenanceQueueChecks(): void {
  useEffect(() => {
    watchDesktopUpdateGate();
    const bridge = window.desktopBridge;
    let lastReported: number | null = null;
    const reportBusy = (refreshHermes: boolean) => {
      if (!bridge?.updateGate) return;
      lastReported = thisMachineBusySessionCount();
      void reportThisMachineBusySessions(bridge, { refreshHermes }).catch(() => undefined);
    };
    const check = () => {
      // A held install needs Hermes's answer too; otherwise the session count
      // alone keeps the gate's report fresh.
      reportBusy(getDesktopUpdateGateState().queuedAt !== null);
      notifyLongDesktopHold(Date.now());
      void processQueuedUpdates();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    const unsubscribeActivity = subscribeActivity(() => {
      if (thisMachineBusySessionCount() !== lastReported) reportBusy(false);
    });
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    check();
    return () => {
      unsubscribeActivity();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, []);
}

export function MaintenanceQueueCoordinator() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  useMaintenanceQueueChecks();
  return (
    <>
      {Array.from(presentations, ([environmentId, presentation]) => (
        <EnvironmentActivityWatcher
          key={environmentId}
          environmentId={environmentId}
          connected={presentation.connection.phase === "connected"}
        />
      ))}
    </>
  );
}
