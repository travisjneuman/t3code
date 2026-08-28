import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "~/components/ui/button";
import { T3Wordmark } from "~/components/sidebar/SidebarChrome";
import { cn } from "~/lib/utils";

import { useRemoteAppState } from "./useRemoteAppState";

export function RemoteAppSwitcher() {
  const { state, bridge } = useRemoteAppState();
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (bridge === undefined) return null;

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
      aria-label={`Switch app surface, currently ${state.activeSurface === "chatgpt" ? "ChatGPT" : "T3 Code"}`}
      className={cn(
        "pointer-events-auto relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 max-w-44 shrink-0 gap-1 rounded-md px-2 text-sm font-medium tracking-tight",
        "border-transparent bg-transparent text-foreground shadow-none hover:bg-accent",
      )}
      size="sm"
      variant="ghost"
      data-remote-app-switcher
      onClick={openMenu}
    >
      {state.activeSurface === "chatgpt" ? <MessageSquareIcon /> : <T3Wordmark />}
      <span className="truncate">{state.activeSurface === "chatgpt" ? "ChatGPT" : "Code"}</span>
      <ChevronDownIcon className="size-3 opacity-60" />
    </Button>
  );
}
