/**
 * "Open comparison" in a compare thread's own action menu (sidebar row and
 * chat header), the way back to both sides. Fork add-on: compare agents,
 * added through forkThreadMenu.
 */
import {
  comparePairOf,
  type ContextMenuItem,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import type { AppRouter } from "../router";

export type CompareThreadMenuId = "open-comparison";

export const isCompareThreadMenuId = (value: string | null): value is CompareThreadMenuId =>
  value === "open-comparison";

/** Puts "Open comparison" first in a compare thread's menu; other menus are unchanged. */
export const withCompareMenuItem = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  thread: { readonly id: ThreadId },
): ReadonlyArray<ContextMenuItem<T | CompareThreadMenuId>> => {
  if (comparePairOf(thread.id) === null) return items;
  const added: ContextMenuItem<CompareThreadMenuId> = {
    id: "open-comparison",
    label: "Open comparison",
  };
  const [first, ...rest] = items;
  return first === undefined ? [added] : [added, { ...first, separatorBefore: true }, ...rest];
};

export const openComparisonOf = async (
  router: Pick<AppRouter, "navigate">,
  threadRef: ScopedThreadRef,
): Promise<void> => {
  const pair = comparePairOf(threadRef.threadId);
  if (pair === null) return;
  await router.navigate({
    to: "/compare/$environmentId",
    params: { environmentId: threadRef.environmentId },
    search: { pair: pair.pairId },
  });
};
