/**
 * "Save to notes…" in the thread action menus (sidebar row and chat header).
 * "Summary" asks the thread's agent to write a summary note into the notes
 * folder; "Full copy" has the server write the prompts and final answers to
 * the saved-threads folder. Both folders are set in Settings, General.
 * Fork add-on: save to notes.
 *
 * @module save-to-notes/saveToNotes
 */
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ContextMenuItem,
  type EnvironmentId,
  SAVE_TO_NOTES_WS_METHODS,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const saveCopyCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:save-to-notes:copy",
  tag: SAVE_TO_NOTES_WS_METHODS.saveCopy,
});

const requestSummaryCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:save-to-notes:summary",
  tag: SAVE_TO_NOTES_WS_METHODS.requestSummary,
});

export type SaveToNotesMenuId = "save-to-notes" | "save-to-notes:summary" | "save-to-notes:copy";

export const isSaveToNotesMenuId = (value: string | null): value is SaveToNotesMenuId =>
  value === "save-to-notes" || value === "save-to-notes:summary" || value === "save-to-notes:copy";

const SUMMARY_ITEM = {
  id: "save-to-notes:summary",
  label: "Summary (the agent writes it)",
} as const;
const COPY_ITEM = { id: "save-to-notes:copy", label: "Full copy (prompts and answers)" } as const;

/**
 * Adds "Save to notes…" right after "Export…", or last when a menu has none.
 * Each child shows only when this connection may run it, and the parent goes
 * when neither may. Menus are built on open, so a click-time read is current.
 */
export const withSaveToNotesMenuItem = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  environmentId: EnvironmentId,
): ReadonlyArray<ContextMenuItem<T | SaveToNotesMenuId>> => {
  const children = [
    ...(appAtomRegistry.get(requestSummaryCommand.permissionAtom(environmentId))
      ? [SUMMARY_ITEM]
      : []),
    ...(appAtomRegistry.get(saveCopyCommand.permissionAtom(environmentId)) ? [COPY_ITEM] : []),
  ];
  if (children.length === 0) return items;
  const item: ContextMenuItem<SaveToNotesMenuId> = {
    id: "save-to-notes",
    label: "Save to notes…",
    icon: "folder",
    children,
  };
  const exportIndex = items.findIndex((entry) => entry.id === "export");
  if (exportIndex === -1) return [...items, item];
  return [...items.slice(0, exportIndex + 1), item, ...items.slice(exportIndex + 1)];
};

const failureToast = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );

/** Runs the item picked from a thread action menu. The parent itself does nothing. */
export const saveThreadToNotes = async (
  threadRef: ScopedThreadRef,
  menuId: SaveToNotesMenuId,
): Promise<void> => {
  const request = {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  };
  if (menuId === "save-to-notes:copy") {
    const result = await runAtomCommand(appAtomRegistry, saveCopyCommand, request, {
      reportFailure: false,
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        failureToast("Failed to save a copy", squashAtomCommandFailure(result));
      }
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Saved a copy to notes",
        description: result.value.path,
      }),
    );
    return;
  }
  if (menuId !== "save-to-notes:summary") return;
  const result = await runAtomCommand(appAtomRegistry, requestSummaryCommand, request, {
    reportFailure: false,
  });
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      failureToast("Failed to ask for a summary", squashAtomCommandFailure(result));
    }
    return;
  }
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: "Asked the agent for a summary",
      description: "It writes the note in your notes folder and replies with its path.",
    }),
  );
};
