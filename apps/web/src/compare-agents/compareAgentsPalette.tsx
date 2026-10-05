/**
 * Command palette actions for Compare agents: "Compare agents…" opens the
 * setup page, "Compare this thread's prompt…" opens it prefilled from the
 * current thread, and for the comparison on screen (its page, or one of its
 * threads) "Open comparison", "Rename comparison", "Archive comparison" and
 * "Delete comparison". Fork add-on: compare agents.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { comparePairOf, compareThreadIds, type EnvironmentId } from "@t3tools/contracts";
import { useMatch, type useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, Columns2Icon, PencilIcon, Trash2Icon } from "lucide-react";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../components/CommandPalette.logic";
import { useThreadShell } from "../state/entities";
import { startCompareRename } from "./compareRenameStore";
import { readComparePairSides, useComparePairRemoval } from "./useComparePairMenu";

export function useCompareAgentsPaletteItems(input: {
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly environmentId: EnvironmentId | null;
  readonly activeThread: { readonly environmentId: EnvironmentId; readonly id: string } | null;
}): CommandPaletteActionItem[] {
  const { navigate, environmentId, activeThread } = input;
  const comparePage = useMatch({ from: "/_chat/compare/$environmentId", shouldThrow: false });
  const { archivePair, deletePair } = useComparePairRemoval();
  const threadPair = activeThread === null ? null : comparePairOf(activeThread.id);
  const current =
    comparePage?.search.pair !== undefined
      ? {
          environmentId: comparePage.params.environmentId as EnvironmentId,
          pairId: comparePage.search.pair,
        }
      : activeThread !== null && threadPair !== null
        ? { environmentId: activeThread.environmentId, pairId: threadPair.pairId }
        : null;
  // Either side still in the thread list means the comparison can be managed.
  const [leftId, rightId] = current === null ? [null, null] : compareThreadIds(current.pairId);
  const left = useThreadShell(
    current === null || leftId === null ? null : scopeThreadRef(current.environmentId, leftId),
  );
  const right = useThreadShell(
    current === null || rightId === null ? null : scopeThreadRef(current.environmentId, rightId),
  );

  const items: CommandPaletteActionItem[] = [];
  if (current !== null && (left !== null || right !== null)) {
    const { environmentId: pairEnvironmentId, pairId } = current;
    const onItsPage = comparePage?.search.pair === pairId;
    const openPair = () =>
      navigate({
        to: "/compare/$environmentId",
        params: { environmentId: pairEnvironmentId },
        search: { pair: pairId },
      });
    const leavePage = async () => {
      if (!onItsPage) return;
      await navigate({
        to: "/compare/$environmentId",
        params: { environmentId: pairEnvironmentId },
        search: {},
      });
    };
    const remove = async (removePair: typeof archivePair) => {
      const pair = readComparePairSides(pairEnvironmentId, pairId);
      if (pair === null) return;
      const refs = pair.sides.map((side) => side.ref);
      if (await removePair(refs, pair.prompt)) await leavePage();
    };
    if (!onItsPage) {
      items.push({
        kind: "action",
        value: "action:open-comparison",
        searchTerms: ["open comparison", "compare agents", "side by side", "review swap"],
        title: "Open comparison",
        icon: <Columns2Icon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await openPair();
        },
      });
    }
    items.push(
      {
        kind: "action",
        value: "action:rename-comparison",
        searchTerms: ["rename comparison", "compare agents", "name comparison"],
        title: "Rename comparison",
        icon: <PencilIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await openPair();
          startCompareRename(pairId, pairId);
        },
      },
      {
        kind: "action",
        value: "action:archive-comparison",
        searchTerms: ["archive comparison", "compare agents", "hide comparison"],
        title: "Archive comparison",
        icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
        run: () => remove(archivePair),
      },
      {
        kind: "action",
        value: "action:delete-comparison",
        searchTerms: ["delete comparison", "compare agents", "remove comparison"],
        title: "Delete comparison",
        icon: <Trash2Icon className={ITEM_ICON_CLASS} />,
        run: () => remove(deletePair),
      },
    );
  }
  if (activeThread !== null && threadPair === null) {
    items.push({
      kind: "action",
      value: "action:compare-this-thread",
      searchTerms: ["compare agents", "compare this thread", "try another agent", "second opinion"],
      title: "Compare this thread's prompt…",
      icon: <Columns2Icon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/compare/$environmentId",
          params: { environmentId: activeThread.environmentId },
          search: { from: activeThread.id },
        });
      },
    });
  }
  if (environmentId !== null) {
    items.push({
      kind: "action",
      value: "action:compare-agents",
      searchTerms: ["compare agents", "compare models", "side by side", "same prompt", "versus"],
      title: "Compare agents…",
      icon: <Columns2Icon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/compare/$environmentId",
          params: { environmentId },
          search: {},
        });
      },
    });
  }
  return items;
}
