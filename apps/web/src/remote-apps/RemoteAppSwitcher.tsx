import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { useRemoteAppState } from "./useRemoteAppState";

export function RemoteAppSwitcher() {
  const { state, bridge, setActiveSurface } = useRemoteAppState();
  if (bridge === undefined) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Switch app surface, currently ${state.activeSurface === "chatgpt" ? "ChatGPT" : "T3 Code"}`}
        className={cn(
          "pointer-events-auto relative z-10 ml-[var(--workspace-titlebar-content-left)] inline-flex h-7 max-w-44 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs",
          "border-transparent bg-transparent text-foreground shadow-none hover:bg-accent",
        )}
        data-remote-app-switcher
      >
        {state.activeSurface === "chatgpt" ? (
          <MessageSquareIcon />
        ) : (
          <span className="font-semibold">T3</span>
        )}
        <span className="truncate">{state.activeSurface === "chatgpt" ? "ChatGPT" : "Code"}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" sideOffset={6}>
        <DropdownMenuItem
          disabled={state.activeSurface === "t3code"}
          onClick={() => void setActiveSurface("t3code")}
        >
          <span className="font-semibold">T3</span>
          <span>Code</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={state.activeSurface === "chatgpt"}
          onClick={() => void setActiveSurface("chatgpt")}
        >
          <MessageSquareIcon />
          <span>ChatGPT</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => void window.desktopBridge?.openExternal("https://chatgpt.com/")}
        >
          <span>Open ChatGPT in browser</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
