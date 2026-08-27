import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "~/components/ui/button";

import { useRemoteAppState } from "./useRemoteAppState";

export function RemoteAppChrome() {
  const { state, bridge, goBack, goForward, reload, zoomIn, zoomOut, resetZoom, retry, clearData } =
    useRemoteAppState();
  if (bridge === undefined || state.activeSurface !== "chatgpt") return null;

  const isBusy =
    state.loadState === "loading" ||
    state.loadState === "creating" ||
    state.loadState === "recovering";
  const hasError =
    state.loadState === "failed" || state.loadState === "crashed" || state.loadState === "blocked";
  const confirmClear = () => {
    if (window.confirm("Clear the isolated ChatGPT session data on this device?")) {
      void clearData();
    }
  };

  return (
    <div
      className="pointer-events-auto ml-auto flex shrink-0 items-center gap-1 pr-[var(--workspace-controls-right)]"
      data-remote-app-chrome
    >
      <span aria-live="polite" className="sr-only">
        {isBusy ? "ChatGPT is loading" : hasError ? "ChatGPT failed to load" : state.currentTitle}
      </span>
      <div className="flex items-center gap-1" data-remote-app-control-group="navigation">
        {hasError ? (
          <Button
            aria-label="Retry ChatGPT"
            onClick={() => void retry()}
            size="icon-micro"
            variant="ghost"
          >
            <RotateCcwIcon />
          </Button>
        ) : null}
        <Button
          aria-label="Go back in ChatGPT"
          disabled={!state.canGoBack}
          onClick={() => void goBack()}
          size="icon-micro"
          variant="ghost"
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          aria-label="Go forward in ChatGPT"
          disabled={!state.canGoForward}
          onClick={() => void goForward()}
          size="icon-micro"
          variant="ghost"
        >
          <ChevronRightIcon />
        </Button>
        <Button
          aria-label="Reload ChatGPT"
          onClick={() => void reload()}
          size="icon-micro"
          variant="ghost"
        >
          <RefreshCwIcon className={isBusy ? "animate-spin" : undefined} />
        </Button>
      </div>
      <span aria-hidden className="mx-1 h-4 w-px bg-border/70" />
      <div className="flex items-center gap-1" data-remote-app-control-group="zoom">
        <Button
          aria-label="Zoom out ChatGPT"
          onClick={() => void zoomOut()}
          size="icon-micro"
          variant="ghost"
        >
          <MinusIcon />
        </Button>
        <span
          aria-label={`ChatGPT zoom ${Math.round(state.zoomFactor * 100)} percent`}
          className="min-w-8 text-center text-[10px] text-muted-foreground"
        >
          {Math.round(state.zoomFactor * 100)}%
        </span>
        <Button
          aria-label="Zoom in ChatGPT"
          onClick={() => void zoomIn()}
          size="icon-micro"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
        <Button
          aria-label="Reset ChatGPT zoom"
          onClick={() => void resetZoom()}
          size="icon-micro"
          variant="ghost"
        >
          <RotateCcwIcon />
        </Button>
      </div>
      <span aria-hidden className="mx-1 h-4 w-px bg-border/70" />
      <Button
        aria-label="Clear ChatGPT session data"
        onClick={confirmClear}
        size="icon-micro"
        variant="ghost"
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
