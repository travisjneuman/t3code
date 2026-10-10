import { REMOTE_APP_SITE_INFO } from "@t3tools/contracts";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "~/components/CommandPalette.logic";

import { RemoteAppSiteIcon } from "../RemoteAppSiteIcon";
import { remoteAppTextSizeLabel } from "../remoteAppState";
import { useAvailableRemoteAppSites } from "../useRemoteAppSites";
import { setRemoteAppSiteTextSize, useRemoteAppTextSizes } from "../useRemoteAppState";
import { readRemoteAppPanelBridge } from "./remoteAppPanelRuntime";
import { openRemoteAppInPanel } from "./remoteAppPanelTabs";
import { useActiveRemoteAppPanelThread } from "./remoteAppPanelThread";

/**
 * "Open <app> in Side Panel" for each available web app, beside the thread on
 * screen, and a way back to T3's text size for each app whose text was changed.
 */
export function useRemoteAppPanelPaletteItems(): CommandPaletteActionItem[] {
  const { sites, loaded } = useAvailableRemoteAppSites();
  const thread = useActiveRemoteAppPanelThread();
  const textSizes = useRemoteAppTextSizes();
  if (!loaded || readRemoteAppPanelBridge() === undefined) return [];
  const textSizeItems = sites.flatMap((site): CommandPaletteActionItem[] => {
    const size = textSizes?.[site];
    if (size === undefined) return [];
    const label = REMOTE_APP_SITE_INFO[site].label;
    return [
      {
        kind: "action",
        value: `action:remote-app-text-size:${site}`,
        searchTerms: [`match ${label} text to T3`, label, "text size", "web app", "font size"],
        title: `Match ${label} Text to T3 (now ${remoteAppTextSizeLabel(size)})`,
        icon: <RemoteAppSiteIcon site={site} className={ITEM_ICON_CLASS} />,
        run: async () => {
          await setRemoteAppSiteTextSize(site, null);
        },
      },
    ];
  });
  if (thread === null) return textSizeItems;
  const panelItems = sites.map((site): CommandPaletteActionItem => {
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
  return [...panelItems, ...textSizeItems];
}
