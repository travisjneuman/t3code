/**
 * Window lengths for providers that report a weekly or monthly reset but not
 * how long the window is (Grok, Cursor), so their bars get the even-spending
 * line too. Fork add-on: pace line.
 *
 * @module forkUsagePeriods
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const MINUTE = 60_000;
const WEEK_MINS = 7 * 24 * 60;

/** The window with its length filled in from its kind and reset, when the provider left it out. */
export function withForkPeriodLength(window: ServerProviderUsageWindow): ServerProviderUsageWindow {
  if (window.windowDurationMins !== undefined || window.resetsAt === undefined) return window;
  const resetsAt = new Date(window.resetsAt);
  if (!Number.isFinite(resetsAt.getTime())) return window;
  if (window.kind === "weekly") return { ...window, windowDurationMins: WEEK_MINS };
  if (window.kind !== "monthly") return window;
  // A billing month started on the same day one calendar month earlier, or on
  // that month's last day when it is shorter (a cycle renewing on the 31st).
  const start = new Date(resetsAt);
  start.setUTCMonth(start.getUTCMonth() - 1);
  if (start.getUTCDate() !== resetsAt.getUTCDate()) start.setUTCDate(0);
  return {
    ...window,
    windowDurationMins: Math.round((resetsAt.getTime() - start.getTime()) / MINUTE),
  };
}
