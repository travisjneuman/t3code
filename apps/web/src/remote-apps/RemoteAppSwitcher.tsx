import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { useRemoteAppState } from "./useRemoteAppState";

export function RemoteAppSwitcher() {
  const { state, bridge, setActiveSurface } = useRemoteAppState();
  if (bridge === undefined) return null;

  const openMenu = async () => {
    const selection = await window.desktopBridge?.showContextMenu([
      { id: "t3code", label: "T3 Code", disabled: state.activeSurface === "t3code" },
      {
        id: "chatgpt",
        label: "ChatGPT",
        disabled: state.activeSurface === "chatgpt",
      },
      {
        id: "open-chatgpt",
        label: "Open ChatGPT in browser",
        separatorBefore: true,
      },
    ]);
    if (selection === "t3code" || selection === "chatgpt") {
      await setActiveSurface(selection);
    } else if (selection === "open-chatgpt") {
      await window.desktopBridge?.openExternal("https://chatgpt.com/");
    }
  };

  return (
    <Button
      aria-label={`Switch app surface, currently ${state.activeSurface === "chatgpt" ? "ChatGPT" : "T3 Code"}`}
      className={cn(
        "pointer-events-auto relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 max-w-44 shrink-0 gap-1 rounded-md px-2 text-xs",
        "border-transparent bg-transparent text-foreground shadow-none hover:bg-accent",
      )}
      onClick={() => void openMenu()}
      size="sm"
      variant="ghost"
      data-remote-app-switcher
    >
      {state.activeSurface === "chatgpt" ? (
        <MessageSquareIcon />
      ) : (
        <span className="font-semibold">T3</span>
      )}
      <span className="truncate">{state.activeSurface === "chatgpt" ? "ChatGPT" : "Code"}</span>
      <ChevronDownIcon className="size-3 opacity-60" />
    </Button>
  );
}
