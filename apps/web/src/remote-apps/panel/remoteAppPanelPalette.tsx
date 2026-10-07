import { REMOTE_APP_SITE_INFO } from "@t3tools/contracts";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "~/components/CommandPalette.logic";

import { RemoteAppSiteIcon } from "../RemoteAppSiteIcon";
import { useAvailableRemoteAppSites } from "../useRemoteAppSites";
import { readRemoteAppPanelBridge } from "./remoteAppPanelRuntime";
import { openRemoteAppInPanel } from "./remoteAppPanelTabs";
import { useActiveRemoteAppPanelThread } from "./remoteAppPanelThread";

/** "Open <app> in Side Panel" for each available web app, beside the thread on screen. */
export function useRemoteAppPanelPaletteItems(): CommandPaletteActionItem[] {
  const { sites, loaded } = useAvailableRemoteAppSites();
  const thread = useActiveRemoteAppPanelThread();
  if (!loaded || thread === null || readRemoteAppPanelBridge() === undefined) return [];
  return sites.map((site): CommandPaletteActionItem => {
    const label = REMOTE_APP_SITE_INFO[site].label;
    return {
      kind: "action",
      value: `action:remote-app-panel:${site}`,
      searchTerms: [`open ${label} in side panel`, label, "side panel", "web app", "right panel"],
      title: `Open ${label} in Side Panel`,
      icon: <RemoteAppSiteIcon site={site} className={ITEM_ICON_CLASS} />,
      run: async () => {
        openRemoteAppInPanel(site);
      },
    };
  });
}
