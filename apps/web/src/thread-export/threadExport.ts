/**
 * "Export…" in the thread action menus (sidebar row and chat header): asks
 * the thread's environment to render it as Markdown or JSON, then saves the
 * file through a Blob download. Electron shows its native Save dialog for the
 * same download, so desktop needs nothing extra.
 * Fork add-on: thread export.
 *
 * @module thread-export/threadExport
 */
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ContextMenuItem,
  type ScopedThreadRef,
  THREAD_EXPORT_WS_METHODS,
  type ThreadExportFormat,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const threadExportCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread-export",
  tag: THREAD_EXPORT_WS_METHODS.export,
});

export type ThreadExportMenuId = "export" | "export:markdown" | "export:json";

const FORMAT_BY_MENU_ID: Readonly<Record<ThreadExportMenuId, ThreadExportFormat | null>> = {
  export: null,
  "export:markdown": "markdown",
  "export:json": "json",
};

export const isExportMenuId = (value: string | null): value is ThreadExportMenuId =>
  value !== null && Object.hasOwn(FORMAT_BY_MENU_ID, value);

const exportMenuItem: ContextMenuItem<ThreadExportMenuId> = {
  id: "export",
  label: "Export…",
  icon: "download",
  children: [
    { id: "export:markdown", label: "Markdown (.md)" },
    { id: "export:json", label: "JSON (.json)" },
  ],
};

/** Adds "Export…" right after the "Copy" submenu, or last when a menu has none. */
export const withExportMenuItem = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
): ReadonlyArray<ContextMenuItem<T | ThreadExportMenuId>> => {
  const copyIndex = items.findIndex((item) => item.id === "copy");
  if (copyIndex === -1) return [...items, exportMenuItem];
  return [...items.slice(0, copyIndex + 1), exportMenuItem, ...items.slice(copyIndex + 1)];
};

// Revoking in the same tick can cancel the download before the browser (or
// Electron's Save dialog) has read the Blob.
const REVOKE_DELAY_MS = 30_000;

const saveFile = (fileName: string, mimeType: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
};

/** Runs the export picked from a thread action menu. The "Export…" parent itself does nothing. */
export const exportThread = async (
  threadRef: ScopedThreadRef,
  menuId: ThreadExportMenuId,
): Promise<void> => {
  const format = FORMAT_BY_MENU_ID[menuId];
  if (format === null) return;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadExportCommand,
    { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, format } },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to export thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return;
  }
  saveFile(result.value.fileName, result.value.mimeType, result.value.content);
};
