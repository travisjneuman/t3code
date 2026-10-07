import { isRemoteAppSite, REMOTE_APP_SITE_INFO, type RemoteAppSite } from "@t3tools/contracts";

import { MenuItem, MenuSeparator } from "~/components/ui/menu";

import { RemoteAppSiteIcon } from "../RemoteAppSiteIcon";
import { useAvailableRemoteAppSites } from "../useRemoteAppSites";
import { readRemoteAppPanelBridge } from "./remoteAppPanelRuntime";
import type { RemoteAppPanelSurface } from "./remoteAppPanelSurface";
import { openRemoteAppPanelTab } from "./remoteAppPanelTabs";
import {
  getActiveRemoteAppPanelThread,
  useActiveRemoteAppPanelThread,
} from "./remoteAppPanelThread";

/** The apps a new tab can open beside the thread on screen; none outside the desktop app. */
function useOfferedSites(): readonly RemoteAppSite[] {
  const { sites, loaded } = useAvailableRemoteAppSites();
  const thread = useActiveRemoteAppPanelThread();
  if (!loaded || thread === null || readRemoteAppPanelBridge() === undefined) return [];
  return sites;
}

function openTab(site: RemoteAppSite): void {
  const thread = getActiveRemoteAppPanelThread();
  if (thread !== null) openRemoteAppPanelTab(thread, site);
}

function RemoteAppTabIcon({ surface }: { readonly surface: RemoteAppPanelSurface }) {
  if (!isRemoteAppSite(surface.site)) return null;
  return <RemoteAppSiteIcon site={surface.site} className="size-3" />;
}

/** Rows for the tab bar's "+" menu. */
function RemoteAppMenuItems() {
  const sites = useOfferedSites();
  if (sites.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      {sites.map((site) => (
        <MenuItem key={site} onClick={() => openTab(site)}>
          <RemoteAppSiteIcon site={site} />
          {REMOTE_APP_SITE_INFO[site].label}
        </MenuItem>
      ))}
    </>
  );
}

/** Rows for the empty panel's "Open a surface" list. */
function RemoteAppLauncherItems() {
  const sites = useOfferedSites();
  return (
    <>
      {sites.map((site) => (
        <button
          key={site}
          type="button"
          onClick={() => openTab(site)}
          className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors hover:bg-accent/60"
        >
          <RemoteAppSiteIcon site={site} />
          <span className="min-w-0 flex-1 truncate">{REMOTE_APP_SITE_INFO[site].label}</span>
        </button>
      ))}
    </>
  );
}

/** What the right panel's tab bar and launchers show for app tabs. */
export const RemoteAppPanelTab = {
  title: (surface: RemoteAppPanelSurface): string =>
    isRemoteAppSite(surface.site) ? REMOTE_APP_SITE_INFO[surface.site].label : "Web app",
  Icon: RemoteAppTabIcon,
  MenuItems: RemoteAppMenuItems,
  LauncherItems: RemoteAppLauncherItems,
};
