/**
 * The fork's thread action menu items, added to both thread menus (sidebar
 * row and chat header) through one hook each: Export, Save to notes, and the
 * ways back for continued threads. Fork add-on.
 *
 * @module forkThreadMenu
 */
import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

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

export type ForkThreadMenuId = ThreadExportMenuId | SaveToNotesMenuId | HandBackMenuId;

export const withForkThreadMenuItems = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  thread: Parameters<typeof withHandBackMenuItem>[1],
): ReadonlyArray<ContextMenuItem<T | ForkThreadMenuId>> =>
  withHandBackMenuItem(withSaveToNotesMenuItem(withExportMenuItem(items)), thread);

export const isForkThreadMenuId = (value: string | null): value is ForkThreadMenuId =>
  isExportMenuId(value) || isSaveToNotesMenuId(value) || isHandBackMenuId(value);

export const runForkThreadMenuItem = (
  threadRef: ScopedThreadRef,
  menuId: ForkThreadMenuId,
): Promise<void> => {
  if (isExportMenuId(menuId)) return exportThread(threadRef, menuId);
  if (isSaveToNotesMenuId(menuId)) return saveThreadToNotes(threadRef, menuId);
  return handBackThread(threadRef, menuId);
};
