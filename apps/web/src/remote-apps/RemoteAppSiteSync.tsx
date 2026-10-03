import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { primaryServerProvidersAtom } from "~/state/server";

import { resolveAvailableRemoteAppSites } from "./remoteAppState";
import { useRemoteAppState } from "./useRemoteAppState";

/** Tells the desktop shell which sites belong in the surface menu. */
export function RemoteAppSiteSync() {
  const { bridge } = useRemoteAppState();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const sites = resolveAvailableRemoteAppSites(providers);
  const sitesKey = sites.join(",");
  const sitesRef = useRef(sites);
  sitesRef.current = sites;

  // Provider snapshots refresh often; only a change in the site list crosses IPC.
  useEffect(() => {
    if (bridge === undefined) return;
    void bridge.setAvailableSites(sitesRef.current).catch(() => undefined);
  }, [bridge, sitesKey]);

  return null;
}
