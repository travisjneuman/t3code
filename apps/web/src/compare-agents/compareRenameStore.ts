/**
 * The comparison whose name is being edited, and the compare page it is
 * edited on (`onPage`: the open pair, or undefined for the start page). The
 * pair menu, the header and the command palette start it; the page that owns
 * it shows the field. Fork add-on: compare agents.
 */
import { create } from "zustand";

interface CompareRename {
  readonly pairId: string | null;
  readonly onPage: string | undefined;
}

export const useCompareRenameStore = create<CompareRename>(() => ({
  pairId: null,
  onPage: undefined,
}));

export const startCompareRename = (pairId: string, onPage: string | undefined) =>
  useCompareRenameStore.setState({ pairId, onPage });

export const stopCompareRename = () =>
  useCompareRenameStore.setState({ pairId: null, onPage: undefined });
