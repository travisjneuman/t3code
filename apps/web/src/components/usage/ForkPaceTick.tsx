import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare } from "@t3tools/shared/usageLimits";

// Hidden for the first third, fading in and back out over the other two.
const PULSE: Keyframe[] = [
  { opacity: 0, offset: 0 },
  { opacity: 0, offset: 1 / 3, easing: "ease-in-out" },
  { opacity: 1, offset: 2 / 3, easing: "ease-in-out" },
  { opacity: 0, offset: 1 },
];

// Opacity alone runs on the compositor, so the pulse never touches layout,
// paint, or JavaScript. Pinned to the document clock so every tick on the page
// pulses together, and skipped when the system asks for reduced motion.
function pulse(node: HTMLSpanElement | null) {
  if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const animation = node.animate(PULSE, { duration: 1500, iterations: Infinity });
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
