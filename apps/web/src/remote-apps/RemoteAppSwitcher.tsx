import { REMOTE_APP_SITE_LABELS } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "~/components/ui/button";
import { T3Wordmark } from "~/components/T3Wordmark";
import { cn } from "~/lib/utils";

import { RemoteAppSiteIcon } from "./RemoteAppSiteIcon";
import { activeRemoteAppSite } from "./remoteAppState";
import { useAvailableRemoteAppSites } from "./useRemoteAppSites";
import { useRemoteAppState } from "./useRemoteAppState";

export function RemoteAppSwitcher() {
  const { state, bridge } = useRemoteAppState();
  const { sites } = useAvailableRemoteAppSites();
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (bridge === undefined) return null;
  const site = activeRemoteAppSite(state);
  const siteLabel = site === undefined ? undefined : REMOTE_APP_SITE_LABELS[site];
  const current = (
    <>
      {site === undefined ? (
        <T3Wordmark aria-label="T3" className="h-2.5 w-auto shrink-0" />
      ) : (
        <RemoteAppSiteIcon site={site} className="size-4 shrink-0" />
      )}
      <span className="truncate">{siteLabel ?? "Code"}</span>
    </>
  );

  // The menu never lists the active surface; T3 is always there from a site.
  if (site === undefined && sites.length === 0) {
    return (
      <div className="[&_svg]:-mx-0.5 ml-[var(--workspace-titlebar-content-left)] flex h-7 max-w-44 shrink-0 items-center gap-1 border border-transparent px-2 font-medium text-foreground text-sm tracking-tight">
        {current}
      </div>
    );
  }

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    void bridge.openSurfaceMenu({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  };

  return (
    <Button
      ref={triggerRef}
      aria-haspopup="menu"
      aria-label={`Switch app surface, currently ${siteLabel ?? "ndev.t3code"}`}
      className={cn(
        // Electron resolves drag regions in DOM order and ignores stacking, so without
        // an explicit no-drag the sidebar header's drag strip underneath eats the click.
        "pointer-events-auto relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 max-w-44 shrink-0 gap-1 rounded-md px-2 text-sm font-medium tracking-tight [-webkit-app-region:no-drag]",
        "border-transparent bg-transparent text-foreground shadow-none hover:bg-accent",
      )}
      size="sm"
      variant="ghost"
      data-remote-app-switcher
      onClick={openMenu}
    >
      {current}
      <ChevronDownIcon className="size-3 opacity-60" />
    </Button>
  );
}
