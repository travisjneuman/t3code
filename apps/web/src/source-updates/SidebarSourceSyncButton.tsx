import { GitMergeIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { Spinner } from "../components/ui/spinner";
import { SidebarMenuItem } from "../components/ui/sidebar";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import "./sourceSync.css";

/** Merges the official repository into a local source build's fork; shown only for those builds. */
export function SidebarSourceSyncButton() {
  return isElectron && window.desktopBridge?.sourceSync ? <SidebarSourceSyncControl /> : null;
}

function SidebarSourceSyncControl() {
  const state = useDesktopUpdateState();
  const [isSyncing, setIsSyncing] = useState(false);

  const handleSync = useCallback(() => {
    const sourceSync = window.desktopBridge?.sourceSync;
    if (!sourceSync || isSyncing) return;
    setIsSyncing(true);
    void sourceSync
      .sync()
      .then((result) => {
        toastManager.add(
          stackedThreadToast({
            type: result.ok ? "success" : "error",
            title: result.ok ? "Fork synced" : "Could not sync fork",
            description: result.message,
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not sync fork",
            description: error instanceof Error ? error.message : "Sync failed.",
          }),
        );
      })
      .finally(() => setIsSyncing(false));
  }, [isSyncing]);

  if (state?.sourceUpdate !== true) return null;

  const label = isSyncing ? "Syncing with official T3 Code…" : "Sync fork with official T3 Code";

  return (
    <SidebarMenuItem className="ml-auto shrink-0" data-source-sync="">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              aria-disabled={isSyncing || undefined}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full text-(--sidebar-icon-color) outline-hidden ring-ring transition-colors focus-visible:ring-2",
                isSyncing
                  ? "cursor-progress"
                  : "cursor-pointer hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
              onClick={handleSync}
            />
          }
        >
          {isSyncing ? <Spinner size="md" /> : <GitMergeIcon className="size-4" />}
        </TooltipTrigger>
        <TooltipPopup align="center" side="top">
          {label}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
