/**
 * The desktop app's own update restarts every provider and the server on this
 * machine, so the main process holds it while sessions here are active; it
 * cannot count them, and this window tells it. Fork add-on: maintenance queue.
 *
 * @module maintenance-queue/desktopGate
 */
import type { DesktopBridge, DesktopUpdateGateState } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import {
  hasHermes,
  refreshHermesActivity,
  thisMachineBusySessionCount,
  thisMachineEnvironments,
} from "./activity";

const NO_HOLD: DesktopUpdateGateState = { queuedAt: null };

let gateState = NO_HOLD;
let watching = false;
const listeners = new Set<() => void>();

function setGateState(next: DesktopUpdateGateState): void {
  if (next.queuedAt === gateState.queuedAt) return;
  gateState = next;
  for (const listener of listeners) listener();
}

/** Starts following the main process's hold; safe to call more than once. */
export function watchDesktopUpdateGate(): void {
  const gate = typeof window === "undefined" ? undefined : window.desktopBridge?.updateGate;
  if (watching || !gate) return;
  watching = true;
  gate.onStateChange(setGateState);
  void gate.getState().then(setGateState, () => undefined);
}

function subscribeGate(listener: () => void): () => void {
  watchDesktopUpdateGate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getGateState(): DesktopUpdateGateState {
  return gateState;
}

export function useDesktopUpdateGateState(): DesktopUpdateGateState {
  return useSyncExternalStore(subscribeGate, getGateState, getGateState);
}

export { getGateState as getDesktopUpdateGateState };

/**
 * Sends the main process a fresh count of this machine's active sessions,
 * asking any Hermes Agents here first when `refreshHermes`.
 */
export async function reportThisMachineBusySessions(
  bridge: DesktopBridge,
  { refreshHermes }: { readonly refreshHermes: boolean },
): Promise<void> {
  if (!bridge.updateGate) return;
  if (refreshHermes) {
    await Promise.all(
      thisMachineEnvironments().flatMap(({ environmentId, config }) =>
        hasHermes(config) ? [refreshHermesActivity(environmentId)] : [],
      ),
    );
  }
  await bridge.updateGate.reportBusySessions(thisMachineBusySessionCount());
}

/**
 * True when the main process held the app's install because this machine has
 * active sessions; it installs by itself once they finish. False on a desktop
 * app without the gate.
 */
export async function queueDesktopInstallWhileBusy(bridge: DesktopBridge): Promise<boolean> {
  if (!bridge.updateGate) return false;
  try {
    await reportThisMachineBusySessions(bridge, { refreshHermes: true });
    return await bridge.updateGate.holdInstallIfBusy();
  } catch {
    return false;
  }
}
