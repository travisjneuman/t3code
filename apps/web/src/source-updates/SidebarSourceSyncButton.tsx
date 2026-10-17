import type { DesktopSourceSyncProgress } from "@t3tools/contracts";
import { GitMergeIcon } from "lucide-react";
import { useEffect, useState } from "react";

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

function describeProgress(progress: DesktopSourceSyncProgress): string {
  switch (progress.phase) {
    case "fetching":
      return "Fetching official T3 Code…";
    case "merging":
      return "Merging official T3 Code…";
    case "resolving":
      return progress.conflictCount === undefined
        ? "Resolving conflicts with Claude…"
        : `Resolving ${progress.conflictCount} conflict${progress.conflictCount === 1 ? "" : "s"} with Claude…`;
    case "checking":
      return "Checking fork add-ons…";
    case "repairing":
      return "Repairing fork add-ons with Claude…";
    case "committing":
      return "Committing the upstream merge…";
    case "pushing":
      return "Pushing the fork…";
  }
}

function SidebarSourceSyncControl() {
  const state = useDesktopUpdateState();
  const [isPending, setIsPending] = useState(false);
  const [progress, setProgress] = useState<DesktopSourceSyncProgress | null>(null);
  const isSyncing = isPending || progress !== null;

  useEffect(() => {
    const sourceSync = window.desktopBridge?.sourceSync;
    let disposed = false;
    let receivedEvent = false;
    const snapshot = sourceSync?.getProgress?.();
    const unsubscribe = sourceSync?.onProgress?.((next) => {
      receivedEvent = true;
      if (!disposed) setProgress(next);
    });
    // Subscribe while the snapshot is in flight; never let an older snapshot
    // overwrite a phase (or completion) already received from the main process.
    void snapshot
      ?.then((next) => {
        if (!disposed && !receivedEvent) setProgress(next);
      })
      .catch(() => {
        // Older shells may not expose the snapshot channel; keep listening for events.
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const handleSync = () => {
    const sourceSync = window.desktopBridge?.sourceSync;
    if (!sourceSync || isSyncing) return;
    setIsPending(true);
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
      .finally(() => setIsPending(false));
  };

  if (state?.sourceUpdate !== true) return null;

  const label = progress
    ? describeProgress(progress)
    : isSyncing
      ? "Syncing with official T3 Code…"
      : "Sync fork with official T3 Code";

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
