import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RemoteAppSite, ScopedThreadRef } from "@t3tools/contracts";

import {
  type RightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { setRemoteAppSurface } from "../useRemoteAppState";
import { useRemoteAppPanelMemory } from "./remoteAppPanelMemory";
import { readRemoteAppPanelBridge } from "./remoteAppPanelRuntime";
import {
  type RemoteAppPanelSurface,
  remoteAppPanelSurface,
  remoteAppPanelSurfaceId,
} from "./remoteAppPanelSurface";
import { getActiveRemoteAppPanelThread } from "./remoteAppPanelThread";

/*
 * How app tabs enter and leave thread tab lists. A tab opened by the user
 * (pinned by default) or restored from the closed list goes through the store's
 * own actions, so it counts as a user choice. Pinned tabs arriving in a thread
 * on activation, and stale pinned tabs leaving it, are bookkeeping and are
 * written without touching the store's user-action or close revisions.
 */

const isAppTab = (surface: RightPanelSurface): surface is RemoteAppPanelSurface =>
  surface.kind === "remote-app";

/** Writes one thread's panel state as an automatic change. */
function editThread(
  threadKey: string,
  edit: (current: ThreadRightPanelState) => ThreadRightPanelState,
): void {
  const state = useRightPanelStore.getState();
  const current = state.byThreadKey[threadKey];
  if (current === undefined) return;
  const next = edit(current);
  if (next === current) return;
  const { [threadKey]: _previous, ...others } = state.byThreadKey;
  const empty =
    !next.isOpen &&
    next.activeSurfaceId === null &&
    next.surfaces.length === 0 &&
    !next.dismissedDeviceSurfaceIds?.length;
  const byThreadKey = empty ? others : { ...state.byThreadKey, [threadKey]: next };
  // A panel that closes hands the thread panel back to its inline place, as the
  // store's own actions do.
  let threadPanelVisibilityByThreadKey = state.threadPanelVisibilityByThreadKey;
  const visibility = threadPanelVisibilityByThreadKey[threadKey];
  if (current.isOpen && !next.isOpen && visibility?.popoverOpen && !visibility.inlineOpen) {
    threadPanelVisibilityByThreadKey = {
      ...threadPanelVisibilityByThreadKey,
      [threadKey]: { ...visibility, inlineOpen: true },
    };
  }
  useRightPanelStore.setState({ byThreadKey, threadPanelVisibilityByThreadKey });
}

/** Opens (or shows) an app tab in a thread and the panel with it. */
export function openRemoteAppPanelTab(
  ref: ScopedThreadRef,
  site: RemoteAppSite,
  options: { readonly pinned?: boolean } = {},
): void {
  const threadKey = scopedThreadKey(ref);
  const id = remoteAppPanelSurfaceId(site);
  const store = useRightPanelStore.getState();
  const existing = store.byThreadKey[threadKey]?.surfaces.some((surface) => surface.id === id);
  if (!existing) {
    const pinned = options.pinned ?? true;
    if (pinned) useRemoteAppPanelMemory.getState().setPinned(site, true);
    const current = store.byThreadKey[threadKey];
    useRightPanelStore.setState({
      byThreadKey: {
        ...store.byThreadKey,
        [threadKey]: {
          isOpen: current?.isOpen ?? false,
          activeSurfaceId: current?.activeSurfaceId ?? null,
          ...(current?.dismissedDeviceSurfaceIds
            ? { dismissedDeviceSurfaceIds: current.dismissedDeviceSurfaceIds }
            : {}),
          surfaces: [...(current?.surfaces ?? []), remoteAppPanelSurface(site, pinned)],
        },
      },
    });
  }
  // Activation opens the panel through the store, which also settles the thread panel.
  useRightPanelStore.getState().activateSurface(ref, id);
}

/** Restores a closed app tab, pinned again if it was; false where apps cannot be shown. */
export function reopenRemoteAppPanelTab(
  ref: ScopedThreadRef,
  surface: RemoteAppPanelSurface,
): boolean {
  if (readRemoteAppPanelBridge() === undefined) return false;
  openRemoteAppPanelTab(ref, surface.site, { pinned: surface.pinned === true });
  return true;
}

/**
 * Brings a thread's app tabs in line with the pinned list: tabs that were only
 * there because their site was pinned leave once it is not, and pinned sites
 * the thread lacks are added without opening the panel.
 */
export function syncPinnedRemoteAppTabs(
  threadKey: string,
  availableSites: readonly RemoteAppSite[],
): void {
  const pinned = useRemoteAppPanelMemory.getState().pinned;
  const state = useRightPanelStore.getState();
  const current = state.byThreadKey[threadKey];
  const surfaces = current?.surfaces ?? [];
  const kept = surfaces.flatMap<RightPanelSurface>((surface) => {
    if (!isAppTab(surface)) return [surface];
    const sitePinned = pinned.includes(surface.site);
    if (surface.pinned === true && !sitePinned) return [];
    return sitePinned && surface.pinned !== true
      ? [remoteAppPanelSurface(surface.site, true)]
      : [surface];
  });
  const added = pinned
    .filter(
      (site) =>
        availableSites.includes(site) &&
        !kept.some((surface) => surface.id === remoteAppPanelSurfaceId(site)),
    )
    .map((site) => remoteAppPanelSurface(site, true));
  const changed =
    added.length > 0 ||
    kept.length !== surfaces.length ||
    kept.some((surface, index) => surface !== surfaces[index]);
  if (!changed) return;
  const next = [...kept, ...added];
  const activeId = current?.activeSurfaceId ?? null;
  const activeKept = activeId !== null && next.some((surface) => surface.id === activeId);
  const activeSurfaceId = activeKept
    ? activeId
    : activeId === null
      ? (added[0]?.id ?? null)
      : (next.at(-1)?.id ?? null);
  const nextState: ThreadRightPanelState = {
    isOpen: (current?.isOpen ?? false) && next.length > 0,
    activeSurfaceId,
    surfaces: next,
    ...(current?.dismissedDeviceSurfaceIds
      ? { dismissedDeviceSurfaceIds: current.dismissedDeviceSurfaceIds }
      : {}),
  };
  if (current === undefined) {
    useRightPanelStore.setState({ byThreadKey: { ...state.byThreadKey, [threadKey]: nextState } });
    return;
  }
  editThread(threadKey, () => nextState);
}

/** Records keep-open when the thread's open panel shows a pinned app. */
function noteRemoteAppKeepOpen(state: ThreadRightPanelState | undefined): void {
  if (!state?.isOpen) return;
  const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
  if (active === undefined || !isAppTab(active)) return;
  const memory = useRemoteAppPanelMemory.getState();
  if (memory.pinned.includes(active.site)) memory.setKeepPanelOpen(active.site);
}

/**
 * On a thread's activation: reopens its panel on the kept-open app when the
 * panel is closed, or notes keep-open when it already shows a pinned app.
 */
export function applyRemoteAppKeepOpen(ref: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(ref);
  const state = useRightPanelStore.getState().byThreadKey[threadKey];
  if (state?.isOpen) {
    noteRemoteAppKeepOpen(state);
    return;
  }
  const site = useRemoteAppPanelMemory.getState().keepPanelOpen;
  if (site === null) return;
  const id = remoteAppPanelSurfaceId(site);
  if (!state?.surfaces.some((surface) => surface.id === id)) return;
  useRightPanelStore.getState().activateSurface(ref, id);
}

/** The panel menu's pin toggle; unpinning keeps the tab in this thread only. */
export function setRemoteAppPinnedFromPanel(
  site: RemoteAppSite,
  pinned: boolean,
  threadKey: string,
): void {
  useRemoteAppPanelMemory.getState().setPinned(site, pinned);
  const id = remoteAppPanelSurfaceId(site);
  editThread(threadKey, (current) => {
    const index = current.surfaces.findIndex((surface) => surface.id === id);
    if (index < 0) return current;
    const surfaces = [...current.surfaces];
    surfaces[index] = remoteAppPanelSurface(site, pinned);
    return { ...current, surfaces };
  });
}

/**
 * Follows the right-panel store: closing a pinned app's tab unpins it
 * everywhere, and the active thread's panel sets or clears keep-open.
 */
export function watchRemoteAppPanelTabs(): () => void {
  return useRightPanelStore.subscribe((next, previous) => {
    if (next.closeRevisionByThreadKey !== previous.closeRevisionByThreadKey) {
      for (const [threadKey, revision] of Object.entries(next.closeRevisionByThreadKey)) {
        if (revision === previous.closeRevisionByThreadKey[threadKey]) continue;
        const remaining = next.byThreadKey[threadKey]?.surfaces ?? [];
        for (const surface of previous.byThreadKey[threadKey]?.surfaces ?? []) {
          if (!isAppTab(surface) || surface.pinned !== true) continue;
          if (remaining.some((entry) => entry.id === surface.id)) continue;
          useRemoteAppPanelMemory.getState().setPinned(surface.site, false);
        }
      }
    }
    if (next.byThreadKey === previous.byThreadKey) return;
    const ref = getActiveRemoteAppPanelThread();
    if (ref === null) return;
    const threadKey = scopedThreadKey(ref);
    const before = previous.byThreadKey[threadKey];
    const after = next.byThreadKey[threadKey];
    if (before === after) return;
    if (after?.isOpen) {
      noteRemoteAppKeepOpen(after);
      return;
    }
    if (!before?.isOpen) return;
    const active = before.surfaces.find((surface) => surface.id === before.activeSurfaceId);
    if (active === undefined || !isAppTab(active)) return;
    const memory = useRemoteAppPanelMemory.getState();
    if (memory.keepPanelOpen === active.site) memory.setKeepPanelOpen(null);
  });
}

/** The desktop surface menu's "Open in Side Panel": the app beside the thread on screen. */
export function openRemoteAppInPanel(site: RemoteAppSite): void {
  void setRemoteAppSurface("t3code");
  const ref = getActiveRemoteAppPanelThread();
  if (ref !== null) {
    openRemoteAppPanelTab(ref, site);
    return;
  }
  // No thread on screen: pin it so the next thread opens with it showing.
  const memory = useRemoteAppPanelMemory.getState();
  memory.setPinned(site, true);
  memory.setKeepPanelOpen(site);
}
