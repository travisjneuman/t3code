/**
 * Command palette actions for Compare agents: "Compare agents…" opens the
 * setup page, and "Open comparison" shows both sides of the comparison the
 * current thread belongs to. Fork add-on: compare agents.
 */
import { comparePairOf, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";
import { Columns2Icon } from "lucide-react";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../components/CommandPalette.logic";

export function compareAgentsPaletteItems(input: {
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly activeThread: { readonly environmentId: EnvironmentId; readonly id: string } | null;
}): CommandPaletteActionItem[] {
  const { navigate, environmentId, projectId, activeThread } = input;
  const items: CommandPaletteActionItem[] = [];
  const pair = activeThread === null ? null : comparePairOf(activeThread.id);
  if (activeThread !== null && pair !== null) {
    items.push({
      kind: "action",
      value: "action:open-comparison",
      searchTerms: ["open comparison", "compare agents", "side by side", "review swap"],
      title: "Open comparison",
      icon: <Columns2Icon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/compare/$environmentId",
          params: { environmentId: activeThread.environmentId },
          search: { pair: pair.pairId },
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
          search: projectId === null ? {} : { project: projectId },
        });
      },
    });
  }
  return items;
}
