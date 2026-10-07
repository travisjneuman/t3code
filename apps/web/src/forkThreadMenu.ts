/**
 * The fork's thread action menu items, added to both thread menus (sidebar
 * row and chat header) through one hook each: Export, Save to notes, the
 * ways back for continued threads, and Open comparison. Fork add-on.
 *
 * @module forkThreadMenu
 */
import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import {
  type CompareThreadMenuId,
  isCompareThreadMenuId,
  openComparisonOf,
  withCompareMenuItem,
} from "./compare-agents/compareThreadMenu";
import {
  handBackThread,
  isHandBackMenuId,
  type HandBackMenuId,
  withHandBackMenuItem,
} from "./external-sessions/handBack";
import {
  isSaveToNotesMenuId,
  saveThreadToNotes,
  type SaveToNotesMenuId,
  withSaveToNotesMenuItem,
} from "./save-to-notes/saveToNotes";
import {
  exportThread,
  isExportMenuId,
  type ThreadExportMenuId,
  withExportMenuItem,
} from "./thread-export/threadExport";
import { buildThreadActionMenuItems } from "./components/threadActionMenu.logic";
import type { AppRouter } from "./router";

export type ForkThreadMenuId =
  | ThreadExportMenuId
  | SaveToNotesMenuId
  | HandBackMenuId
  | CompareThreadMenuId;

export const withForkThreadMenuItems = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  thread: Parameters<typeof withHandBackMenuItem>[1],
): ReadonlyArray<ContextMenuItem<T | ForkThreadMenuId>> =>
  withCompareMenuItem(
    withHandBackMenuItem(withSaveToNotesMenuItem(withExportMenuItem(items)), thread),
    thread,
  );

/**
 * `buildThreadActionMenuItems` for one thread, with the fork's items added. The
 * sidebar shadows the upstream builder with this, so its long menu call stays
 * as upstream wrote it.
 */
export const forkThreadActionMenuBuilder =
  (thread: Parameters<typeof withHandBackMenuItem>[1]) =>
  (state: Parameters<typeof buildThreadActionMenuItems>[0]) =>
    withForkThreadMenuItems(buildThreadActionMenuItems(state), thread);

export const isForkThreadMenuId = (value: string | null): value is ForkThreadMenuId =>
  isExportMenuId(value) ||
  isSaveToNotesMenuId(value) ||
  isHandBackMenuId(value) ||
  isCompareThreadMenuId(value);

export const runForkThreadMenuItem = (
  threadRef: ScopedThreadRef,
  menuId: ForkThreadMenuId,
  router: Pick<AppRouter, "navigate">,
): Promise<void> => {
  if (isExportMenuId(menuId)) return exportThread(threadRef, menuId);
  if (isSaveToNotesMenuId(menuId)) return saveThreadToNotes(threadRef, menuId);
  if (isCompareThreadMenuId(menuId)) return openComparisonOf(router, threadRef);
  return handBackThread(threadRef, menuId);
};
