import { useEffect, useRef } from "react";

import { activeRemoteAppSite } from "./remoteAppState";
import { useAvailableRemoteAppSites, useRemoteAppBackgroundLoad } from "./useRemoteAppSites";
import { useRemoteAppState } from "./useRemoteAppState";

/**
 * Tells the desktop shell which sites belong in the surface menu and whether
 * to load them in the background, and returns to T3 when the site on screen
 * stops being available.
 */
export function RemoteAppSiteSync() {
  const { bridge, state, setActiveSurface } = useRemoteAppState();
  const { sites, loaded } = useAvailableRemoteAppSites();
  const [backgroundLoad] = useRemoteAppBackgroundLoad();
  const sitesKey = sites.join(",");
  const availabilityRef = useRef({ sites, backgroundLoad });
  availabilityRef.current = { sites, backgroundLoad };
  const setActiveSurfaceRef = useRef(setActiveSurface);
  setActiveSurfaceRef.current = setActiveSurface;
  const activeSite = activeRemoteAppSite(state);
  const activeSiteUnavailable = loaded && activeSite !== undefined && !sites.includes(activeSite);

  // Provider snapshots refresh often; only a change in the site list or the
  // background-load setting crosses IPC.
  useEffect(() => {
    if (bridge === undefined || !loaded) return;
    void bridge.setAvailableSites(availabilityRef.current).catch(() => undefined);
  }, [backgroundLoad, bridge, loaded, sitesKey]);

  // The shell keeps the active site's view; once T3 is showing, sending the
  // list again releases it.
  useEffect(() => {
    if (bridge === undefined || !activeSiteUnavailable) return;
    void setActiveSurfaceRef
      .current("t3code")
      .then(() => bridge.setAvailableSites(availabilityRef.current))
      .catch(() => undefined);
  }, [activeSiteUnavailable, bridge]);

  return null;
}
