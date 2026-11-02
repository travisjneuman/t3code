/**
 * Components that stand in for a block of upstream UI. The upstream file keeps its own block and
 * renders it when the slot is empty, so leaving the add-on out restores upstream's UI. An upstream
 * change to a slotted block merges into the kept block; port it into the add-on's component too.
 */
import type { EnvironmentMachineKind, UsageProviderKind } from "@t3tools/contracts";
import type { ModelTotals } from "@t3tools/shared/usageMerge";
import type { ComponentType, ReactNode } from "react";

import { usageModelSelectionKey } from "./components/usage/usageModelRows";
import { UsageModelBreakdownBody } from "./components/usage/UsageModelBreakdown";
import { ThreadCardMeta } from "./fork-sidebar/ThreadCardMeta";
import type { SidebarThreadSummary } from "./types";

interface ForkSlots {
  /** Usage → Breakdown → Model: the table body, and the key a row selects the model dialog by. */
  readonly usageModelRows?: {
    readonly Body: ComponentType<{
      readonly models: readonly ModelTotals[];
      readonly metric: "cost" | "tokens";
      readonly loadingProviders: ReadonlySet<UsageProviderKind>;
      readonly onSelectModel: (key: string) => void;
    }>;
    readonly selectionKey: (model: ModelTotals) => string;
  };
  /** The sidebar card's meta line. A filled slot always renders, so the card keeps its meta line. */
  readonly threadCardMeta?: ComponentType<{
    readonly thread: SidebarThreadSummary;
    readonly threadKey: string;
    readonly subagentCount: number;
    readonly environmentLabel: string | null;
    readonly environmentMachine: EnvironmentMachineKind;
    readonly isRemote: boolean;
    readonly terminalStatusIcon: ReactNode;
    readonly prBadge: ReactNode;
    readonly diff: { insertions: number; deletions: number } | null;
    readonly providerStack: ReactNode;
  }>;
}

export const forkSlots: ForkSlots = {
  usageModelRows: { Body: UsageModelBreakdownBody, selectionKey: usageModelSelectionKey }, // Fork add-on(usage-by-model)
  threadCardMeta: ThreadCardMeta, // Fork add-on(compact-cards)
};
