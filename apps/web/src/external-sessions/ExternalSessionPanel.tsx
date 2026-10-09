import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useEffect, useEffectEvent, useMemo } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { RightPanelTabs } from "../components/RightPanelTabs";
import { isElectron } from "../env";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
import { renderRemoteAppPanel } from "../remote-apps/panel/RemoteAppPanelView";
import { readRemoteAppPanelBridge } from "../remote-apps/panel/remoteAppPanelRuntime";
import { useRemoteAppPanelThread } from "../remote-apps/panel/remoteAppPanelThread";
import { useAvailableRemoteAppSites } from "../remote-apps/useRemoteAppSites";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  type RightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../state/server";

/**
 * One side panel for every Other Agents session, so its web app tabs stay put
 * while you move between sessions. It holds web apps only: the browser,
 * terminal, files, and diff need a T3 thread, which "Continue in T3" makes.
 */
const EXTERNAL_SESSIONS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("external-sessions-panel"),
  ThreadId.make("external-sessions-panel"),
);
const PANEL_KEY = scopedThreadKey(EXTERNAL_SESSIONS_PANEL_REF);

const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_PREVIEW_DESKTOP_STATE = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const EMPTY_PENDING_SURFACES = new Set<string>();
const ignore = () => undefined;

function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

/**
 * The thread view's right panel for an Other Agents session: `headerControls`
 * go inside the header while the panel is closed (a no-drag descendant beats
 * the header's drag region), `rootControls` float over the panel while it is
 * shown, and `panel` sits beside the chat column. All null outside the
 * desktop app or with no web apps turned on.
 */
export function useExternalSessionPanel(environmentId: EnvironmentId): {
  headerControls: ReactNode;
  rootControls: ReactNode;
  panel: ReactNode;
} {
  const ref = EXTERNAL_SESSIONS_PANEL_REF;
  const { sites, loaded } = useAvailableRemoteAppSites();
  const available = readRemoteAppPanelBridge() !== undefined && loaded && sites.length > 0;
  // Pinned apps, keep-open, and the "+" menu follow the published panel.
  useRemoteAppPanelThread(available ? ref : null);

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const { active: animationsActive, durationMs } = usePanelAnimationSettings();
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, ref),
  );
  const open = available && panelState.isOpen;
  const presenceValue = useMemo(
    () => ({
      activeSurface:
        panelState.surfaces.find((surface) => surface.id === panelState.activeSurfaceId) ?? null,
      surfaces: panelState.surfaces,
    }),
    [panelState.activeSurfaceId, panelState.surfaces],
  );
  const presence = usePanelPresence(open, presenceValue, animationsActive, PANEL_KEY, durationMs);
  const renderedSurface = presence.value?.activeSurface ?? null;

  const toggle = () => {
    const store = useRightPanelStore.getState();
    if (open) store.close(ref);
    else store.show(ref);
  };
  const toggleFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!available) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggle();
  });
  const closeActiveFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!open || presenceValue.activeSurface === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      useRightPanelStore.getState().closeSurface(ref, presenceValue.activeSurface.id);
    }
  });
  // No ChatView here, so this view handles the panel shortcuts itself.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: getShortcutContext(),
      });
      if (command === "rightPanel.toggle") toggleFromShortcut(event);
      if (command === "rightPanel.close") closeActiveFromShortcut(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  if (!available) return { headerControls: null, rootControls: null, panel: null };

  const toggleControl = (
    <PanelLayoutControls
      showTerminalControl={false}
      showThreadPanelControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      threadPanelOpen={false}
      threadPanelPresentation="inline"
      threadPanelShortcutLabel={null}
      onToggleThreadPanel={ignore}
      rightPanelAvailable
      rightPanelOpen={open}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      onToggleTerminal={ignore}
      onToggleRightPanel={toggle}
    />
  );
  const controls = (
    <div
      // The anchor the thread view's controls use, one shared inset from the edge.
      className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      {toggleControl}
    </div>
  );
  const store = useRightPanelStore.getState;
  const tabs = (mode: "inline" | "sheet") => (
    <RightPanelTabs
      mode={mode}
      open={open}
      keybindings={keybindings}
      getShortcutContext={getShortcutContext}
      // The sheet covers the header's toggle, so it carries its own, as a thread's does.
      layoutControls={
        mode === "sheet" && open ? (
          <div className="mr-px flex items-center">{toggleControl}</div>
        ) : null
      }
      surfaces={presence.value?.surfaces ?? []}
      environmentId={environmentId}
      activeSurfaceId={renderedSurface?.id ?? null}
      pendingSurfaceIds={EMPTY_PENDING_SURFACES}
      previewSessions={EMPTY_PREVIEW_SESSIONS}
      desktopByTabId={EMPTY_PREVIEW_DESKTOP_STATE}
      terminalLabelsById={EMPTY_TERMINAL_LABELS}
      onActivate={(surface: RightPanelSurface) => store().activateSurface(ref, surface.id)}
      onCloseSurface={(surface) => store().closeSurface(ref, surface.id)}
      onCloseOtherSurfaces={(surface) => store().closeOtherSurfaces(ref, surface.id)}
      onCloseSurfacesToRight={(surface) => store().closeSurfacesToRight(ref, surface.id)}
      onCloseAllSurfaces={() => store().closeAllSurfaces(ref)}
      onCopyFilePath={ignore}
      onAddBrowser={ignore}
      onAddBrowserInProfile={ignore}
      onAddTerminal={ignore}
      onAddDiff={ignore}
      onAddFiles={ignore}
      onAddPullRequest={ignore}
      onAddPullRequests={ignore}
      onAddDevice={ignore}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      {renderRemoteAppPanel(renderedSurface, open, ref)}
    </RightPanelTabs>
  );

  if (useSheet) {
    return {
      headerControls: controls,
      rootControls: null,
      panel: presence.present ? (
        <RightPanelSheet
          animationDurationMs={animationsActive ? durationMs : 0}
          open={open}
          onClose={() => store().close(ref)}
        >
          {tabs("sheet")}
        </RightPanelSheet>
      ) : null,
    };
  }
  return {
    headerControls: presence.present ? null : controls,
    rootControls: presence.present ? controls : null,
    panel: presence.present ? tabs("inline") : null,
  };
}
