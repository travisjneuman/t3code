import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare } from "@t3tools/shared/usageLimits";

/**
 * The even-spending line on a Limits page segment: the share of the window's
 * time still left, so a fill that ends right of it is under pace. Hidden at
 * the very start and end of a window, where it would sit on the bar's edge.
 * Fork add-on: pace line.
 */
export function ForkPaceTick({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null || elapsed < 0.02 || elapsed > 0.98) return null;
  return (
    <span
      aria-hidden
      className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground/80"
      style={{ left: `${(1 - elapsed) * 100}%` }}
    />
  );
}
