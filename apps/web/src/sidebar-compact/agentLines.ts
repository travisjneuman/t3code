/**
 * The single-line sidebar sessions (subagents, Other Agents, Hermes) share one
 * dense look: 20px lines with no gap and 10px text, so long lists stay short.
 * Horizontal padding stays with each list, since subagents indent by depth.
 * Fork add-on: compact sidebar cards.
 */
export const AGENT_LINE_CLASS =
  "flex h-5 w-full cursor-pointer items-center gap-1.5 rounded-md text-left text-[10px] outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export const AGENT_LINE_ICON_CLASS = "size-3 shrink-0";

/** "Show more" / "Show less" under one of those lists, the same height as a line. */
export const AGENT_MORE_BUTTON_CLASS =
  "flex h-5 w-full cursor-pointer items-center gap-1.5 rounded-md px-(--sidebar-row-content-inset) text-left text-[10px] text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground";

/** Upstream's thread-row active and selected states, light-mode ring included. */
export const AGENT_LINE_ACTIVE_CLASS =
  "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70";

export const AGENT_LINE_SELECTED_CLASS =
  "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70";
