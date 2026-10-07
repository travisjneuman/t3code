import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type DesktopRemoteAppBridge,
  REMOTE_APP_PARTITIONS,
  type RemoteAppSite,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { resolveHostedBrowserWebviewWrapperStyle } from "~/browser/hostedBrowserWebviewStyle";
import { isMacPlatform } from "~/lib/utils";
import { type RightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

import { useAvailableRemoteAppSites } from "../useRemoteAppSites";
import { useRemoteAppActiveSurface } from "../useRemoteAppState";
import { effectiveRemoteAppChatMode, useRemoteAppPanelMemory } from "./remoteAppPanelMemory";
import {
  readRemoteAppPanelBridge,
  recordRemoteAppPanelNavigation,
  refreshRemoteAppPanelNavigation,
  type RemoteAppPanelWebview as PanelWebviewElement,
  remoteAppPanelSlotId,
  showRemoteAppPanelFor,
  startRemoteAppPanel,
  stopRemoteAppPanel,
} from "./remoteAppPanelRuntime";
import {
  applyRemoteAppKeepOpen,
  openRemoteAppInPanel,
  syncPinnedRemoteAppTabs,
  watchRemoteAppPanelTabs,
} from "./remoteAppPanelTabs";
import {
  getActiveRemoteAppPanelThread,
  useActiveRemoteAppPanelThread,
} from "./remoteAppPanelThread";

const ignore = () => undefined;

/** Sites with a tab some thread keeps for itself (not only because the site is pinned). */
function ownTabSitesKey(byThreadKey: Readonly<Record<string, { surfaces: RightPanelSurface[] }>>) {
  const sites = new Set<string>();
  for (const state of Object.values(byThreadKey)) {
    for (const surface of state.surfaces) {
      if (surface.kind === "remote-app" && surface.pinned !== true) sites.add(surface.site);
    }
  }
  return [...sites].toSorted().join(",");
}

/**
 * The side panel's web app pages, one per site in use, mounted once for the
 * whole app so a page survives thread switches and panel closes. Each page is
 * placed over its panel slot while one is on screen and parked offscreen
 * otherwise.
 */
export function RemoteAppPanelHost() {
  const bridge = readRemoteAppPanelBridge();
  return bridge === undefined ? null : <PanelHost bridge={bridge} />;
}

function PanelHost({ bridge }: { readonly bridge: DesktopRemoteAppBridge }) {
  const { sites, loaded } = useAvailableRemoteAppSites();
  const pinned = useRemoteAppPanelMemory((state) => state.pinned);
  const ownTabSites = useRightPanelStore((state) => ownTabSitesKey(state.byThreadKey));
  const activeThread = useActiveRemoteAppPanelThread();
  const surfaceActive = useRemoteAppActiveSurface() === "t3code";
  const availableKey = sites.join(",");
  const pinnedKey = pinned.join(",");
  const sitesRef = useRef(sites);
  useEffect(() => {
    sitesRef.current = sites;
  }, [sites]);

  useEffect(() => {
    const stopWatching = watchRemoteAppPanelTabs();
    const stopNavigated = bridge.onPanelNavigated(({ site, url }) =>
      recordRemoteAppPanelNavigation(site, url),
    );
    const stopOpen = bridge.onOpenInPanel((site) => {
      if (sitesRef.current.includes(site)) openRemoteAppInPanel(site);
    });
    return () => {
      stopWatching();
      stopNavigated();
      stopOpen();
    };
  }, [bridge]);

  // Pinned tabs join the thread on screen; keep-open applies once per activation,
  // and leaving the chat view (for Settings, say) ends the activation.
  const activatedThreadKey = useRef<string | null>(null);
  useEffect(() => {
    if (activeThread === null) activatedThreadKey.current = null;
    if (!loaded || activeThread === null) return;
    const threadKey = scopedThreadKey(activeThread);
    syncPinnedRemoteAppTabs(threadKey, sitesRef.current);
    if (activatedThreadKey.current === threadKey) return;
    activatedThreadKey.current = threadKey;
    applyRemoteAppKeepOpen(activeThread);
  }, [activeThread, availableKey, loaded, pinnedKey]);

  const ownTabSiteList = ownTabSites.split(",");
  const inUse = sites.filter((site) => pinned.includes(site) || ownTabSiteList.includes(site));
  const threadKey = activeThread === null ? null : scopedThreadKey(activeThread);
  return (
    <>
      {inUse.map((site) => (
        <PanelWebview
          key={site}
          site={site}
          bridge={bridge}
          threadKey={threadKey}
          surfaceActive={surfaceActive}
        />
      ))}
    </>
  );
}

function activeThreadKey(): string | null {
  const ref = getActiveRemoteAppPanelThread();
  return ref === null ? null : scopedThreadKey(ref);
}

function PanelWebview(props: {
  readonly site: RemoteAppSite;
  readonly bridge: DesktopRemoteAppBridge;
  readonly threadKey: string | null;
  readonly surfaceActive: boolean;
}) {
  const { site, bridge, threadKey, surfaceActive } = props;
  const slotId = remoteAppPanelSlotId(site);
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[slotId];
      return {
        rect: current?.rect ?? null,
        visible: current?.visible ?? false,
        zIndex: current?.zIndex ?? 30,
        cornerRadius: current?.cornerRadius ?? 0,
      };
    }),
  );
  const mode = useRemoteAppPanelMemory((state) =>
    effectiveRemoteAppChatMode(state, threadKey, site),
  );
  const [attached, setAttached] = useState(false);
  const webviewRef = useRef<PanelWebviewElement | null>(null);
  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as PanelWebviewElement | null;
  }, []);
  // Hidden while the window shows a web app full size: that is the same app's other page.
  const shown = surfaceActive && presentation.visible && presentation.rect !== null;

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    let disposed = false;
    let attaching = false;
    const attach = () => {
      if (attaching) return;
      let webContentsId: number;
      try {
        webContentsId = webview.getWebContentsId();
      } catch {
        return;
      }
      attaching = true;
      bridge
        .attachPanel(site, webContentsId)
        .then(() => {
          if (disposed) return;
          startRemoteAppPanel(site, webview, bridge, activeThreadKey());
          setAttached(true);
        })
        .catch(() => {
          attaching = false;
        });
    };
    const refresh = () => refreshRemoteAppPanelNavigation(site);
    // A click inside the guest only reaches this document as a webview focus,
    // so replay it as a pointerdown to dismiss open host menus and popovers.
    const dismissHostPopups = () => {
      webview.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
      );
    };
    webview.addEventListener("did-attach", attach);
    webview.addEventListener("dom-ready", attach);
    webview.addEventListener("did-navigate", refresh);
    webview.addEventListener("did-navigate-in-page", refresh);
    webview.addEventListener("focus", dismissHostPopups);
    return () => {
      disposed = true;
      webview.removeEventListener("did-attach", attach);
      webview.removeEventListener("dom-ready", attach);
      webview.removeEventListener("did-navigate", refresh);
      webview.removeEventListener("did-navigate-in-page", refresh);
      webview.removeEventListener("focus", dismissHostPopups);
      stopRemoteAppPanel(site, webview);
    };
  }, [bridge, site]);

  useEffect(() => {
    if (!attached || !shown) return;
    void bridge.setPanelVisible(site, true).catch(ignore);
    return () => void bridge.setPanelVisible(site, false).catch(ignore);
  }, [attached, bridge, shown, site]);

  // The thread on screen and its chat mode decide which chat the page shows.
  useEffect(() => {
    if (!attached || !shown || threadKey === null) return;
    showRemoteAppPanelFor(site, threadKey);
  }, [attached, mode, shown, site, threadKey]);

  const rect = presentation.rect;
  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active: shown,
    renderingActive: false,
    // Electron can permanently blank a macOS webview after `visibility: hidden`,
    // so hidden macOS pages stay paintable offscreen, as upstream's browser does.
    keepPaintableWhenInactive: isMacPlatform(navigator.platform),
    cornerRadius: presentation.cornerRadius,
    zIndex: presentation.zIndex,
    rect,
    hiddenSize: { width: rect?.width ?? 1280, height: rect?.height ?? 800 },
  });

  return (
    <div
      className="fixed overflow-hidden"
      style={{ ...wrapperStyle, overscrollBehavior: "contain" }}
      data-remote-app-panel={site}
    >
      <webview
        ref={setWebviewRef}
        // Electron reads `allowpopups` when the guest attaches, so it has to be an
        // attribute from the start; the string is spread past React's boolean type.
        {...({ allowpopups: "true" } as unknown as { readonly allowpopups?: boolean })}
        src="about:blank"
        partition={REMOTE_APP_PARTITIONS[site]}
        aria-hidden={shown ? undefined : true}
        className="absolute inset-0 flex size-full"
      />
    </div>
  );
}
