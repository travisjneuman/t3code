import { isRemoteAppSite, type RemoteAppSite } from "@t3tools/contracts";

/**
 * A built-in web app shown as a right-panel tab beside a thread. One live page
 * per site serves every thread, so the id is the site. `pinned` marks a tab
 * that is there because the site is pinned to every thread; such a tab leaves
 * a thread once the site is unpinned.
 */
export interface RemoteAppPanelSurface {
  id: `remote-app:${RemoteAppSite}`;
  kind: "remote-app";
  site: RemoteAppSite;
  pinned?: boolean;
}

export const remoteAppPanelSurfaceId = (site: RemoteAppSite): RemoteAppPanelSurface["id"] =>
  `remote-app:${site}`;

export const remoteAppPanelSurface = (
  site: RemoteAppSite,
  pinned: boolean,
): RemoteAppPanelSurface => ({
  id: remoteAppPanelSurfaceId(site),
  kind: "remote-app",
  site,
  ...(pinned ? { pinned: true } : {}),
});

/** Whether a stored tab (for example one restored from a closed-view list) is well formed. */
export const isRemoteAppPanelSurface = (surface: RemoteAppPanelSurface): boolean =>
  isRemoteAppSite(surface.site) &&
  surface.id === remoteAppPanelSurfaceId(surface.site) &&
  (surface.pinned === undefined || typeof surface.pinned === "boolean");
