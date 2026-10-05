/**
 * A comparison's action menu: the thread action menu (pin, settle, snooze,
 * rename, mark unread, export, save to notes, archive, delete) applied to
 * both of its threads at once, with one confirmation for the pair. Archived
 * comparisons get Unarchive and Delete. Fork add-on: compare agents.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  compareThreadIds,
  type ContextMenuItem,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  isForkThreadMenuId,
  runForkThreadMenuItem,
  withForkThreadMenuItems,
} from "../forkThreadMenu";
import { useClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readThreadShell,
} from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { type ComparePair, comparePromptOf, renamedCompareTitle } from "./comparePairs";

/** Thread menu items that mean nothing for a pair or name one side only. */
const LEFT_OUT: ReadonlySet<string> = new Set([
  "new-thread-on-branch",
  "filter-by-project",
  "project-settings",
  "regenerate-title",
  "copy",
]);

const forPair = <T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
): ReadonlyArray<ContextMenuItem<T>> =>
  items
    .filter((item) => !LEFT_OUT.has(item.id))
    .map((item) => ({
      ...item,
      label:
        item.id === "delete" ? "Delete comparison" : item.label.replace(/ thread$/, " comparison"),
    }));

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Runs `run` on each side in turn and toasts the first real failure. */
async function onBothSides(
  refs: ReadonlyArray<ScopedThreadRef>,
  failureTitle: string,
  run: (ref: ScopedThreadRef) => Promise<AtomCommandResult<unknown, unknown>>,
): Promise<boolean> {
  let ok = true;
  for (const ref of refs) {
    const result = await run(ref);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      if (ok) failureToast(failureTitle, squashAtomCommandFailure(result));
      ok = false;
    }
  }
  return ok;
}

const confirmed = async (message: string, destructive: boolean): Promise<boolean> => {
  const api = readLocalApi();
  if (!api) return false;
  const answer = await settlePromise(() =>
    api.dialogs.confirm(message, destructive ? { variant: "destructive" } : undefined),
  );
  return answer._tag === "Success" && answer.value;
};

const pairRefs = (environmentId: EnvironmentId, pairId: string) =>
  compareThreadIds(pairId).map((threadId) => scopeThreadRef(environmentId, threadId));

/** Renames a comparison: each side keeps its `Compare · <model> ·` prefix. */
export function useRenameComparison(environmentId: EnvironmentId) {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  return useCallback(
    (pairId: string, name: string) => {
      const trimmed = name.trim();
      if (trimmed === "") {
        toastManager.add({ type: "warning", title: "Comparison name cannot be empty" });
        return;
      }
      const sides = pairRefs(environmentId, pairId).flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell === null ? [] : [{ ref, title: shell.title }];
      });
      if (sides.every((side) => comparePromptOf(side.title) === trimmed)) return;
      void (async () => {
        for (const side of sides) {
          const result = await updateThreadMetadata({
            environmentId,
            input: {
              threadId: side.ref.threadId,
              title: renamedCompareTitle(side.title, trimmed),
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to rename comparison", squashAtomCommandFailure(result));
            return;
          }
        }
      })();
    },
    [environmentId, updateThreadMetadata],
  );
}

export function useComparePairMenu(input: {
  readonly environmentId: EnvironmentId;
  readonly onStartRename: (pairId: string) => void;
  /** After the pair is archived or deleted, to leave it if it is open. */
  readonly onRemoved: (pairId: string) => void;
}) {
  const { environmentId, onStartRename, onRemoved } = input;
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    archiveThread,
    unarchiveThread,
    deleteThread,
    markThreadUnread,
  } = useThreadActions();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);

  const deletePair = useCallback(
    async (refs: ReadonlyArray<ScopedThreadRef>, prompt: string) => {
      if (
        confirmThreadDelete &&
        !(await confirmed(
          [
            `Delete comparison "${prompt}"?`,
            "Both threads and their conversation history are removed for good.",
          ].join("\n"),
          true,
        ))
      ) {
        return false;
      }
      return onBothSides(refs, "Failed to delete comparison", deleteThread);
    },
    [confirmThreadDelete, deleteThread],
  );

  const openMenu = useCallback(
    (pairId: string, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const sides = pairRefs(environmentId, pairId).flatMap((ref) => {
          const shell = readThreadShell(ref);
          return shell === null ? [] : [{ ref, shell }];
        });
        const lead = sides[0]?.shell;
        if (lead === undefined) return;
        const refs = sides.map((side) => side.ref);
        const prompt = comparePromptOf(lead.title);
        const now = new Date();
        const supports = {
          settlement: readEnvironmentSupportsSettlement(environmentId),
          autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(environmentId),
          snooze: readEnvironmentSupportsSnooze(environmentId),
          pinning: readEnvironmentSupportsPinning(environmentId),
          titleRegeneration: false,
        };
        const snoozePresets = resolveSnoozePresets(now, timestampFormat);
        const items = buildThreadActionMenuItems({
          branch: null,
          projectFilter: null,
          isPinned: lead.pinnedAt != null,
          isSettled: supports.settlement && lead.settledOverride === "settled",
          autoSettleEnabled: lead.autoSettleDisabledAt == null,
          isSnoozed: supports.snooze && effectiveSnoozed(lead, { now: now.toISOString() }),
          canSnoozeNow: sides.every((side) => canSnooze(side.shell, { now: now.toISOString() })),
          isRegeneratingTitle: false,
          isRunning: sides.some((side) => !threadRuntimeCanArchive(side.shell.runtime)),
          supports,
          snoozePresets,
        });
        const clicked = await settlePromise(() =>
          api.contextMenu.show(forPair(withForkThreadMenuItems(items, lead)), position),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (isForkThreadMenuId(clicked.value)) {
          const menuId = clicked.value;
          for (const ref of refs) await runForkThreadMenuItem(ref, menuId);
          return;
        }
        const action: ThreadActionMenuId = clicked.value;
        if (action.startsWith("snooze:")) {
          const preset =
            action === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          await onBothSides(refs, "Failed to snooze comparison", (ref) =>
            snoozeThread(ref, preset.snoozedUntil),
          );
          return;
        }
        switch (action) {
          case "pin":
            await onBothSides(refs, "Failed to pin comparison", (ref) => pinThread(ref));
            return;
          case "unpin":
            await onBothSides(refs, "Failed to unpin comparison", unpinThread);
            return;
          case "settle":
            await onBothSides(refs, "Failed to settle comparison", settleThread);
            return;
          case "unsettle":
            await onBothSides(refs, "Failed to un-settle comparison", unsettleThread);
            return;
          case "unsnooze":
            await onBothSides(refs, "Failed to wake comparison", unsnoozeThread);
            return;
          case "auto-settle:enabled":
          case "auto-settle:disabled":
            await onBothSides(refs, "Failed to update auto-settle", (ref) =>
              setThreadAutoSettle(ref, action === "auto-settle:enabled"),
            );
            return;
          case "rename":
            onStartRename(pairId);
            return;
          case "mark-unread":
            for (const ref of refs) markThreadUnread(ref);
            return;
          case "archive":
            if (
              confirmThreadArchive &&
              !(await confirmed(`Archive comparison "${prompt}"?`, false))
            ) {
              return;
            }
            if (
              await onBothSides(refs, "Failed to archive comparison", (ref) => archiveThread(ref))
            )
              onRemoved(pairId);
            return;
          case "delete":
            if (await deletePair(refs, prompt)) onRemoved(pairId);
            return;
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      confirmThreadArchive,
      deletePair,
      environmentId,
      markThreadUnread,
      onRemoved,
      onStartRename,
      pinThread,
      setThreadAutoSettle,
      settleThread,
      snoozeThread,
      timestampFormat,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );

  const openArchivedMenu = useCallback(
    (pair: ComparePair, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show<"unarchive" | "delete">(
            [
              { id: "unarchive", label: "Unarchive comparison", icon: "archive" },
              { id: "delete", label: "Delete comparison", icon: "trash", destructive: true },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        // Only the archived sides: a side still in the thread list stays put.
        const refs = pair.threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
        // Both actions refresh the archived list themselves.
        if (clicked.value === "unarchive") {
          await onBothSides(refs, "Failed to unarchive comparison", (ref) => unarchiveThread(ref));
        } else {
          await deletePair(refs, pair.prompt);
        }
      })();
    },
    [deletePair, unarchiveThread],
  );

  return { openMenu, openArchivedMenu };
}
