import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare } from "@t3tools/shared/usageLimits";

// Over 3 s: a slow 1.5 s fade up, 0.9 s at full, a quick 0.3 s fade down, 0.3 s
// dim. It never fades below a quarter, so the line is always there.
const PULSE: Keyframe[] = [
  { opacity: 0.25, offset: 0, easing: "ease-out" },
  { opacity: 1, offset: 0.5 },
  { opacity: 1, offset: 0.8, easing: "ease-in" },
  { opacity: 0.25, offset: 0.9 },
  { opacity: 0.25, offset: 1 },
];

// Opacity alone runs on the compositor, so the pulse never touches layout,
// paint, or JavaScript. Pinned to the document clock so every tick on the page
// pulses together, and skipped when the system asks for reduced motion.
function pulse(node: HTMLSpanElement | null) {
  if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const animation = node.animate(PULSE, { duration: 3000, iterations: Infinity });
  animation.startTime = 0;
  return () => animation.cancel();
}

/**
 * The even-spending line on a Limits page segment: the share of the window's
 * time still left, so a fill that ends right of it is under pace. Hidden at
 * the very start and end of a window, where it would sit on the bar's edge.
 * Fork add-on: pace line.
 */
export function ForkPaceTick({
  window: usageWindow,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const elapsed = elapsedShare(usageWindow, now);
  if (elapsed === null || elapsed < 0.02 || elapsed > 0.98) return null;
  return (
    <span
      ref={pulse}
      aria-hidden
      className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
      style={{ left: `${(1 - elapsed) * 100}%` }}
    />
  );
}
