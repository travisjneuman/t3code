import { useAtomValue } from "@effect/atom-react";
import { REMOTE_APP_SITES, RemoteAppSiteSchema, type RemoteAppSite } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "~/hooks/useLocalStorage";
import { primaryServerConfigAtom, primaryServerProvidersAtom } from "~/state/server";

import { resolveAvailableRemoteAppSites } from "./remoteAppState";

// The hidden and background-disabled lists are opt-outs, so a provider site
// whose provider is enabled later is shown and loaded in the background by
// default. Standalone sites have no provider to follow and stay off until the
// user turns them on, so their list is an opt-in.
const HIDDEN_SITES_STORAGE_KEY = "t3code:remote-app-hidden-sites:v1";
const ENABLED_STANDALONE_SITES_STORAGE_KEY = "t3code:remote-app-enabled-standalone-sites:v1";
const BACKGROUND_DISABLED_SITES_STORAGE_KEY = "t3code:remote-app-background-disabled-sites:v1";
// The former single switch for every site; `false` carries over as all sites disabled.
const LEGACY_BACKGROUND_LOAD_STORAGE_KEY = "t3code:remote-app-background-load:v1";
// Minutes a hidden site may go unshown before the shell releases it; null is Off.
const IDLE_UNLOAD_MINUTES_STORAGE_KEY = "t3code:remote-app-idle-unload-minutes:v1";
const SiteListSchema = Schema.Array(RemoteAppSiteSchema);
const NO_SITES: ReadonlyArray<RemoteAppSite> = [];
const ALL_SITES: ReadonlyArray<RemoteAppSite> = REMOTE_APP_SITES;

function useRemoteAppSiteList(storageKey: string) {
  const [sites, setSites] = useLocalStorage(storageKey, NO_SITES, SiteListSchema);
  const setSiteListed = useCallback(
    (site: RemoteAppSite, listed: boolean) =>
      setSites((current) => {
        const others = current.filter((candidate) => candidate !== site);
        return listed ? [...others, site] : others;
      }),
    [setSites],
  );
  return [sites, setSiteListed] as const;
}

/** The provider sites the user turned off in Settings, shared by every reader. */
export function useHiddenRemoteAppSites() {
  const [hiddenSites, setSiteHidden] = useRemoteAppSiteList(HIDDEN_SITES_STORAGE_KEY);
  return { hiddenSites, setSiteHidden };
}

/** The standalone sites the user turned on in Settings. */
export function useEnabledStandaloneRemoteAppSites() {
  const [enabledStandaloneSites, setStandaloneSiteEnabled] = useRemoteAppSiteList(
    ENABLED_STANDALONE_SITES_STORAGE_KEY,
  );
  return { enabledStandaloneSites, setStandaloneSiteEnabled };
}

let legacyBackgroundLoadMigrated = false;
const migrateLegacyBackgroundLoad = () => {
  if (legacyBackgroundLoadMigrated) return;
  legacyBackgroundLoadMigrated = true;
  try {
    if (getLocalStorageItem(LEGACY_BACKGROUND_LOAD_STORAGE_KEY, Schema.Boolean) === false) {
      setLocalStorageItem(BACKGROUND_DISABLED_SITES_STORAGE_KEY, ALL_SITES, SiteListSchema);
    }
    removeLocalStorageItem(LEGACY_BACKGROUND_LOAD_STORAGE_KEY);
  } catch (error) {
    console.error("[LOCALSTORAGE] Could not carry over the web app background setting.", error);
  }
};

/** The sites the user keeps from loading in the background before their first activation. */
export function useBackgroundDisabledRemoteAppSites() {
  migrateLegacyBackgroundLoad();
  const [backgroundDisabledSites, setSiteBackgroundDisabled] = useRemoteAppSiteList(
    BACKGROUND_DISABLED_SITES_STORAGE_KEY,
  );
  return { backgroundDisabledSites, setSiteBackgroundDisabled };
}

export const REMOTE_APP_IDLE_UNLOAD_CHOICES = [null, 60, 240, 720] as const;
export type RemoteAppIdleUnloadMinutes = (typeof REMOTE_APP_IDLE_UNLOAD_CHOICES)[number];
const DEFAULT_IDLE_UNLOAD_MINUTES: RemoteAppIdleUnloadMinutes = 240;
const IdleUnloadMinutesSchema = Schema.NullOr(Schema.Literals([60, 240, 720]));

/** How long a hidden web app keeps its page before the shell releases it. */
export function useRemoteAppIdleUnloadMinutes() {
  const [idleUnloadMinutes, setIdleUnloadMinutes] = useLocalStorage(
    IDLE_UNLOAD_MINUTES_STORAGE_KEY,
    DEFAULT_IDLE_UNLOAD_MINUTES,
    IdleUnloadMinutesSchema,
  );
  return { idleUnloadMinutes, setIdleUnloadMinutes };
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
  const { enabledStandaloneSites } = useEnabledStandaloneRemoteAppSites();
  const sites = useMemo(
    () => resolveAvailableRemoteAppSites(providers, hiddenSites, enabledStandaloneSites),
    [enabledStandaloneSites, hiddenSites, providers],
  );
  return { sites, loaded };
}
