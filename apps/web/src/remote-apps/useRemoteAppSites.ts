import { useAtomValue } from "@effect/atom-react";
import { RemoteAppSiteSchema, type RemoteAppSite } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { primaryServerConfigAtom, primaryServerProvidersAtom } from "~/state/server";

import { resolveAvailableRemoteAppSites } from "./remoteAppState";

// Opt-out, so a site whose provider is enabled later shows up by default.
const HIDDEN_SITES_STORAGE_KEY = "t3code:remote-app-hidden-sites:v1";
const HiddenSitesSchema = Schema.Array(RemoteAppSiteSchema);
const NO_HIDDEN_SITES: ReadonlyArray<RemoteAppSite> = [];
const BACKGROUND_LOAD_STORAGE_KEY = "t3code:remote-app-background-load:v1";

/** The sites the user turned off in Settings, shared by every component that reads them. */
export function useHiddenRemoteAppSites() {
  const [hiddenSites, setHiddenSites] = useLocalStorage(
    HIDDEN_SITES_STORAGE_KEY,
    NO_HIDDEN_SITES,
    HiddenSitesSchema,
  );
  const setSiteHidden = useCallback(
    (site: RemoteAppSite, hidden: boolean) =>
      setHiddenSites((current) => {
        const others = current.filter((candidate) => candidate !== site);
        return hidden ? [...others, site] : others;
      }),
    [setHiddenSites],
  );
  return { hiddenSites, setSiteHidden };
}

/** Whether the desktop shell loads available sites before their first activation. */
export function useRemoteAppBackgroundLoad() {
  return useLocalStorage(BACKGROUND_LOAD_STORAGE_KEY, true, Schema.Boolean);
}

/**
 * The sites the surface menu offers. `loaded` stays false until the primary
 * server has sent its providers, so an empty list at startup is not mistaken
 * for every provider being disabled.
 */
export function useAvailableRemoteAppSites() {
  const loaded = useAtomValue(primaryServerConfigAtom) !== null;
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { hiddenSites } = useHiddenRemoteAppSites();
  const sites = useMemo(
    () => resolveAvailableRemoteAppSites(providers, hiddenSites),
    [hiddenSites, providers],
  );
  return { sites, loaded };
}
