import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";

import { REMOTE_APP_SITE_LABELS } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";

import { activeRemoteAppSite } from "./remoteAppState";
import { useRemoteAppState } from "./useRemoteAppState";

export function RemoteAppChrome() {
  const { state, bridge, goBack, goForward, reload, zoomIn, zoomOut, resetZoom, retry, clearData } =
    useRemoteAppState();
  const site = activeRemoteAppSite(state);
  if (bridge === undefined || site === undefined) return null;
  const label = REMOTE_APP_SITE_LABELS[site];

  const isBusy =
    state.loadState === "loading" ||
    state.loadState === "creating" ||
    state.loadState === "recovering";
  const hasError =
    state.loadState === "failed" || state.loadState === "crashed" || state.loadState === "blocked";
  const confirmClear = () => {
    if (window.confirm(`Clear the isolated ${label} session data on this device?`)) {
      void clearData();
    }
  };

  return (
    <div
      className="pointer-events-auto ml-auto flex shrink-0 items-center gap-1 pr-[var(--workspace-controls-right)]"
      data-remote-app-chrome
    >
      <span aria-live="polite" className="sr-only">
        {isBusy ? `${label} is loading` : hasError ? `${label} failed to load` : state.currentTitle}
      </span>
      <div
        className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/45 p-0.5 shadow-xs"
        data-remote-app-control-group="navigation"
      >
        {hasError ? (
          <Button
            aria-label={`Retry ${label}`}
            onClick={() => void retry()}
            size="icon-micro"
            variant="ghost"
          >
            <RotateCcwIcon />
          </Button>
        ) : null}
        <Button
          aria-label={`Go back in ${label}`}
          disabled={!state.canGoBack}
          onClick={() => void goBack()}
          size="icon-micro"
          variant="ghost"
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          aria-label={`Go forward in ${label}`}
          disabled={!state.canGoForward}
          onClick={() => void goForward()}
          size="icon-micro"
          variant="ghost"
        >
          <ChevronRightIcon />
        </Button>
        <Button
          aria-label={`Reload ${label}`}
          onClick={() => void reload()}
          size="icon-micro"
          variant="ghost"
        >
          <RefreshCwIcon className={isBusy ? "animate-spin" : undefined} />
        </Button>
      </div>
      <div
        className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/45 p-0.5 shadow-xs"
        data-remote-app-control-group="zoom"
      >
        <Button
          aria-label={`Zoom out ${label}`}
          onClick={() => void zoomOut()}
          size="icon-micro"
          variant="ghost"
        >
          <MinusIcon />
        </Button>
        <span
          aria-label={`${label} zoom ${Math.round(state.zoomFactor * 100)} percent`}
          className="min-w-8 text-center text-[10px] text-muted-foreground"
        >
          {Math.round(state.zoomFactor * 100)}%
        </span>
        <Button
          aria-label={`Zoom in ${label}`}
          onClick={() => void zoomIn()}
          size="icon-micro"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
        <Button
          aria-label={`Reset ${label} zoom`}
          onClick={() => void resetZoom()}
          size="icon-micro"
          variant="ghost"
        >
          <RotateCcwIcon />
        </Button>
      </div>
      <div className="rounded-lg border border-border/60 bg-background/45 p-0.5 shadow-xs">
        <Button
          aria-label={`Clear ${label} session data`}
          onClick={confirmClear}
          size="icon-micro"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}
