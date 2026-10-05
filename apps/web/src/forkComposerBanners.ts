/**
 * The fork's composer banners, added in ChatView through this one hook: the
 * running-elsewhere warning for continued external sessions and the way back
 * from a Compare agents thread. Fork add-on.
 *
 * @module forkComposerBanners
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { ComposerBannerStackItem } from "./components/chat/ComposerBannerStack";
import { useCompareBanner } from "./compare-agents/CompareBanner";
import { useRunningElsewhereBanner } from "./external-sessions/RunningElsewhereBanner";

export function useForkComposerBanners(
  items: ReadonlyArray<ComposerBannerStackItem>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<ComposerBannerStackItem> {
  const withRunningElsewhere = useRunningElsewhereBanner(items, environmentId, threadId);
  return useCompareBanner(withRunningElsewhere, environmentId, threadId);
}
