/**
 * The Mac app that publishes fork host releases (see apps/desktop HostReleasePublisher) queues
 * each fork host's update to a newly published release once, and reports a failed publish with
 * Retry. Other clients render nothing. Fork add-on: host releases.
 */
import { useAtomValue } from "@effect/atom-react";
import type { DesktopHostReleaseBridge, DesktopHostReleaseStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { canUpdateServer } from "~/components/ServerUpdateAction";
import { toastManager } from "~/components/ui/toast";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { enqueueUpdate } from "~/maintenance-queue/queueStore";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { useEnvironments } from "~/state/environments";
import { environmentUpdateStatesAtom } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import {
  collectHostUpdateTargets,
  useNewestHostRelease,
  useRefreshHostUpdateTarget,
} from "./hostRelease";

// Which release each host was queued for, so a failed or declined update is not queued again.
const QUEUED_KEY = "t3code:host-release-auto-update:v1";
// Which failed publish was already reported, so a relaunch does not report it again.
const NOTIFIED_KEY = "t3code:host-release-notified:v1";

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function readQueued(): Record<string, string> {
  const value = readJson(QUEUED_KEY);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
}

function reportFailure(bridge: DesktopHostReleaseBridge, status: DesktopHostReleaseStatus): void {
  const runKey = `${status.commit}:${status.startedAt}`;
  if (readJson(NOTIFIED_KEY) === runKey) return;
  writeJson(NOTIFIED_KEY, runKey);
  const id = toastManager.add({
    type: "error",
    title: "Fork hosts were not updated",
    description: `${status.detail ?? "The host release failed."} Log: ${status.logPath}`,
    timeout: 0,
    actionProps: {
      children: "Retry",
      onClick: () => {
        toastManager.close(id);
        void bridge.retry();
      },
    },
  });
}

function usePublisherStatus(bridge: DesktopHostReleaseBridge | undefined) {
  const [status, setStatus] = useState<DesktopHostReleaseStatus | null>(null);
  const refreshTarget = useRefreshHostUpdateTarget();
  useEffect(() => {
    if (bridge === undefined) return;
    let previous: DesktopHostReleaseStatus["state"] | null = null;
    const apply = (next: DesktopHostReleaseStatus | null) => {
      setStatus(next);
      if (next === null) return;
      if (next.state === "failed") reportFailure(bridge, next);
      // The release check runs once at startup, before a release published since then.
      if (next.state === "succeeded" && previous === "running") refreshTarget();
      previous = next.state;
    };
    const unsubscribe = bridge.onStatusChange(apply);
    void bridge.getStatus().then(apply, () => undefined);
    return unsubscribe;
  }, [bridge, refreshTarget]);
  return status;
}

function useAutoQueueHostUpdates(enabled: boolean) {
  // The release can be newer than this app: it is published when the fork is pushed.
  const target = useNewestHostRelease();
  const { environments } = useEnvironments();
  const environmentIds = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const sessionStates = useAtomValue(environmentSessionStatesAtom(environmentIds));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(environmentIds));
  const machines = environments.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverConfig: environment.serverConfig,
    connected: environment.connection.phase === "connected",
    hostedByThisApp:
      isElectron &&
      (environment.entry.target._tag === "PrimaryConnectionTarget" ||
        isDesktopLocalConnectionTarget(environment.entry.target)),
    canMaintain: canUpdateServer(sessionStates[index]!),
    updateState: updateStates[index]!,
  }));
  // A desktop-managed host would relaunch someone's app, and respawn hosts install from npm.
  const due =
    enabled && target !== null
      ? collectHostUpdateTargets(machines, target).targets.filter(
          (server) => server.selfUpdate === "boot-service",
        )
      : [];
  const dueKey = due.map((server) => `${server.environmentId}=${server.targetVersion}`).join(",");

  useEffect(() => {
    if (due.length === 0) return;
    const queued = readQueued();
    let changed = false;
    for (const server of due) {
      if (queued[server.environmentId] === server.targetVersion) continue;
      enqueueUpdate({
        kind: "server",
        environmentId: server.environmentId,
        input: {
          targetVersion: server.targetVersion,
          ...(server.threadContinuation && server.continueThreadsAfterServerUpdate
            ? { continueRunningThreads: true }
            : {}),
        },
        queuedAt: Date.now(),
        notifiedAt: null,
      });
      queued[server.environmentId] = server.targetVersion;
      changed = true;
    }
    if (changed) writeJson(QUEUED_KEY, queued);
    // `due` is rebuilt each render; `dueKey` changes only when it does.
  }, [dueKey]);
}

export function HostReleaseAutoUpdate() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.hostRelease;
  const status = usePublisherStatus(bridge);
  // Only the app that publishes releases updates the hosts, so two clients never race.
  useAutoQueueHostUpdates(status !== null);
  return null;
}
