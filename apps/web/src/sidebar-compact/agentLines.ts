/**
 * The single-line sidebar sessions (subagents, Other Agents, Hermes) share one
 * dense look: 24px lines with no gap and 11px text, so long lists stay short.
 * Horizontal padding stays with each list, since subagents indent by depth.
 * Fork add-on: compact sidebar cards.
 */
export const AGENT_LINE_CLASS =
  "flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md text-left text-[11px] outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export const AGENT_LINE_ICON_CLASS = "size-3 shrink-0";
