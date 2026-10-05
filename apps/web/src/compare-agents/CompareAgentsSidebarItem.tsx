/**
 * The sidebar footer's way into Compare agents: one icon beside Settings and
 * Usage that opens the start page, where earlier comparisons are listed too.
 * Fork add-on; see docs/user/compare-agents.md.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Columns2Icon } from "lucide-react";
import { useCallback } from "react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useRemoteAppState } from "../remote-apps/useRemoteAppState";
import { usePrimaryEnvironmentId } from "../state/environments";

const LABEL = "Compare agents";

export function CompareAgentsSidebarItem() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const { setActiveSurface } = useRemoteAppState();
  const { isMobile, setOpenMobile } = useSidebar();
  const isActive = useLocation({ select: (location) => location.pathname.startsWith("/compare/") });

  const open = useCallback(() => {
    if (environmentId === null) return;
    if (isMobile) setOpenMobile(false);
    void setActiveSurface("t3code").then(() => {
      void navigate({
        to: "/compare/$environmentId",
        params: { environmentId },
        search: {},
      });
    });
  }, [environmentId, isMobile, navigate, setActiveSurface, setOpenMobile]);

  if (environmentId === null) return null;

  // SidebarUtilityItem's markup, plus the active state while a comparison is open.
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={LABEL} isActive={isActive} onClick={open} size="icon">
              <Columns2Icon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{LABEL}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
