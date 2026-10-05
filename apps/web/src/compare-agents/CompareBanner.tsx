/**
 * Composer note in a Compare agents thread, with the way back to both sides.
 * Fork add-on: compare agents, mounted through forkComposerBanners.
 */
import { comparePairOf, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Columns2Icon } from "lucide-react";
import { useMemo } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";

/** `items` plus the note in a compare thread; `items` itself in any other thread. */
export function useCompareBanner(
  items: ReadonlyArray<ComposerBannerStackItem>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<ComposerBannerStackItem> {
  const navigate = useNavigate();
  const pairId = comparePairOf(threadId)?.pairId ?? null;
  return useMemo<ReadonlyArray<ComposerBannerStackItem>>(
    () =>
      pairId === null
        ? items
        : [
            ...items,
            {
              id: `compare-agents:${threadId}`,
              variant: "info",
              compact: true,
              icon: <Columns2Icon />,
              title: "Part of a comparison. Messages sent here go to this agent only.",
              actions: (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    void navigate({
                      to: "/compare/$environmentId",
                      params: { environmentId },
                      search: { pair: pairId },
                    })
                  }
                >
                  Open comparison
                </Button>
              ),
            },
          ],
    [environmentId, items, navigate, pairId, threadId],
  );
}
