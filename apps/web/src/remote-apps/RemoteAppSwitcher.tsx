import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { T3Wordmark } from "~/components/sidebar/SidebarChrome";
import { cn } from "~/lib/utils";

import { useRemoteAppState } from "./useRemoteAppState";

export function RemoteAppSwitcher() {
  const { state, bridge, setActiveSurface } = useRemoteAppState();
  if (bridge === undefined) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={`Switch app surface, currently ${state.activeSurface === "chatgpt" ? "ChatGPT" : "T3 Code"}`}
            className={cn(
              "pointer-events-auto relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 max-w-44 shrink-0 gap-1 rounded-md px-2 text-sm font-medium tracking-tight",
              "border-transparent bg-transparent text-foreground shadow-none hover:bg-accent",
            )}
            size="sm"
            variant="ghost"
            data-remote-app-switcher
          />
        }
      >
        {state.activeSurface === "chatgpt" ? <MessageSquareIcon /> : <T3Wordmark />}
        <span className="truncate">{state.activeSurface === "chatgpt" ? "ChatGPT" : "Code"}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="min-w-40 border border-border/70 bg-popover/95 shadow-lg backdrop-blur-md"
        data-remote-app-switcher-menu
        side="bottom"
        sideOffset={6}
      >
        <MenuRadioGroup
          value={state.activeSurface}
          onValueChange={(surface) => {
            if (surface === state.activeSurface) return;
            void setActiveSurface(surface as typeof state.activeSurface);
          }}
        >
          <MenuRadioItem value="t3code">
            <span className="flex min-w-0 items-center gap-2">
              <T3Wordmark />
              <span className="truncate">T3 Code</span>
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="chatgpt">
            <span className="flex min-w-0 items-center gap-2">
              <MessageSquareIcon className="size-3.5" />
              <span className="truncate">ChatGPT</span>
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
