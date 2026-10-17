/**
 * Live follow for a MessagesTimeline outside ChatView, simplified from the
 * chat view: follow the end until the reader scrolls up, offer the "Scroll to
 * end" pill while away, follow again at the end. Used by Other Agents
 * sessions and the Compare agents columns. Fork add-on.
 *
 * @module forkTimelineLiveFollow
 */
import { type LegendListRef } from "@legendapp/list/react";
import { Debouncer } from "@tanstack/react-pacer";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "./hooks/useStableCallback";

const SCROLL_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/** `hasEntries`: whether the list has rows, since it mounts only then. */
export function useTimelineLiveFollow(hasEntries: boolean) {
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const liveFollowRef = useRef(true);
  const isAtEndRef = useRef(true);
  const [showScrollToEnd, setShowScrollToEnd] = useState(false);
  // Showing is debounced so the pill does not flash while the list settles.
  const [showPillDebouncer] = useState(
    () => new Debouncer(() => setShowScrollToEnd(true), { wait: 150 }),
  );
  useEffect(() => () => showPillDebouncer.cancel(), [showPillDebouncer]);
  const setFollow = (follow: boolean) => {
    liveFollowRef.current = follow;
    setLiveFollowEnabled(follow);
  };
  const hidePill = () => {
    showPillDebouncer.cancel();
    setShowScrollToEnd(false);
  };
  const stopFollowing = useStableCallback(() => {
    if (!liveFollowRef.current) return;
    setFollow(false);
    if (!isAtEndRef.current) showPillDebouncer.maybeExecute();
  });
  const scrollToEnd = (animated: boolean) => {
    setFollow(true);
    hidePill();
    requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated });
    });
  };
  const onIsAtEndChange = (isAtEnd: boolean) => {
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      setFollow(true);
      hidePill();
    } else if (liveFollowRef.current) {
      // Streamed growth briefly leaves the end before the follow catches up.
      hidePill();
    } else {
      showPillDebouncer.maybeExecute();
    }
  };

  // Gestures that move the view away from the end stop following. The list
  // mounts once there are rows, so attach then, retrying a few frames.
  useEffect(() => {
    if (!hasEntries) return;
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;
    const attach = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const node: unknown = listRef.current?.getScrollableNode();
        if (!(node instanceof HTMLElement)) {
          if (remainingAttempts > 0) attach(remainingAttempts - 1);
          return;
        }
        const overflows = () => node.scrollHeight > node.clientHeight;
        const handleWheel = (event: WheelEvent) => {
          if (event.deltaY < 0 && overflows()) stopFollowing();
        };
        // A touch at the end that moves nothing must not break follow, since
        // no later scroll event would re-arm it.
        const handleTouchMove = () => {
          if (!isAtEndRef.current) stopFollowing();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
          if (
            SCROLL_KEYS.has(event.key) &&
            overflows() &&
            !(
              event.target instanceof Element &&
              event.target.closest("input, textarea, [contenteditable=true]")
            )
          ) {
            stopFollowing();
          }
        };
        node.addEventListener("wheel", handleWheel, { passive: true });
        node.addEventListener("touchmove", handleTouchMove, { passive: true });
        node.ownerDocument.addEventListener("keydown", handleKeyDown);
        removeListeners = () => {
          node.removeEventListener("wheel", handleWheel);
          node.removeEventListener("touchmove", handleTouchMove);
          node.ownerDocument.removeEventListener("keydown", handleKeyDown);
        };
      });
    };
    attach(10);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      removeListeners?.();
    };
  }, [hasEntries, stopFollowing]);

  return {
    listRef,
    liveFollowEnabled,
    showScrollToEnd,
    scrollToEnd,
    onIsAtEndChange,
    stopFollowing,
  };
}
