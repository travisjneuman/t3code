import { useEffect } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { activeRemoteAppSite } from "./remoteAppState";
import {
  useAvailableRemoteAppSites,
  useBackgroundDisabledRemoteAppSites,
  useRemoteAppIdleUnloadMinutes,
} from "./useRemoteAppSites";
import { useRemoteAppState } from "./useRemoteAppState";

/**
 * Tells the desktop shell which sites belong in the surface menu, which of
 * them to load in the background, and how long hidden ones may idle, and
 * returns to T3 when the site on screen stops being available.
 */
export function RemoteAppSiteSync() {
  const { bridge, state, setActiveSurface } = useRemoteAppState();
  const { sites, loaded } = useAvailableRemoteAppSites();
  const { backgroundDisabledSites } = useBackgroundDisabledRemoteAppSites();
  const { idleUnloadMinutes } = useRemoteAppIdleUnloadMinutes();
  const backgroundSites = sites.filter((site) => !backgroundDisabledSites.includes(site));
  const sitesKey = sites.join(",");
  const backgroundSitesKey = backgroundSites.join(",");
  const getAvailability = useStableCallback(() => ({ sites, backgroundSites, idleUnloadMinutes }));
  const setActiveSurfaceStable = useStableCallback(setActiveSurface);
  const activeSite = activeRemoteAppSite(state);
  const activeSiteUnavailable = loaded && activeSite !== undefined && !sites.includes(activeSite);

  // Provider snapshots refresh often; only a change in either site list or
  // the idle limit crosses IPC.
  useEffect(() => {
    if (bridge === undefined || !loaded) return;
    void bridge.setAvailableSites(getAvailability()).catch(() => undefined);
  }, [backgroundSitesKey, bridge, getAvailability, idleUnloadMinutes, loaded, sitesKey]);

  // The shell keeps the active site's view; once T3 is showing, sending the
  // list again releases it.
  useEffect(() => {
    if (bridge === undefined || !activeSiteUnavailable) return;
    void setActiveSurfaceStable("t3code")
      .then(() => bridge.setAvailableSites(getAvailability()))
      .catch(() => undefined);
  }, [activeSiteUnavailable, bridge, getAvailability, setActiveSurfaceStable]);

  return null;
}
