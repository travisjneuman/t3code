/**
 * The thread list's multi-select menu, given every action of a single thread's
 * menu that can apply to several threads. Upstream's menu has unpin, settle,
 * snooze, title regeneration, mark unread and delete; this adds the rest, each
 * over the selected threads it applies to. Rename stays one thread at a time.
 * Fork add-on.
 *
 * @module useBulkThreadMenu
 */
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  comparePairOf,
  type ContextMenuItem,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { openComparisonOf } from "../compare-agents/compareThreadMenu";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { handBackThread, withHandBackMenuItem } from "../external-sessions/handBack";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { readLocalApi } from "../localApi";
import { saveThreadToNotes, withSaveToNotesMenuItem } from "../save-to-notes/saveToNotes";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { readEnvironmentScope } from "../state/session";
import { exportThread } from "../thread-export/threadExport";
import { useThreadSelectionStore } from "../threadSelectionStore";
import type { SidebarThreadSummary } from "../types";

type BulkThreadMenuId = `fork-bulk:${string}`;

export const isBulkThreadMenuId = (value: string | null): value is BulkThreadMenuId =>
  value?.startsWith("fork-bulk:") === true;

type CommandResult = Parameters<typeof isAtomCommandInterrupted>[0];

interface ThreadCapabilities {
  readonly threadSettlement?: boolean;
  readonly threadSnooze?: boolean;
  readonly threadPinning?: boolean;
  readonly threadAutoSettleOptOut?: boolean;
}

/** What only the sidebar knows, read when the menu opens. */
export interface BulkThreadMenuContext {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly settledKeys: ReadonlySet<string>;
  readonly snoozedKeys: ReadonlySet<string>;
  readonly capabilitiesOf: (environmentId: EnvironmentId) => ThreadCapabilities | undefined;
  readonly projectGroupOf: (thread: SidebarThreadSummary) => SidebarProjectSnapshot | null;
  readonly projectScopeKey: string | null;
  readonly setProjectScopeKey: (key: string | null) => void;
  readonly openProjectSettings: (
    group: SidebarProjectSnapshot,
    projectRef: ScopedProjectRef,
  ) => void;
  readonly workspacePathOf: (thread: SidebarThreadSummary) => string | null;
}

const refOf = (thread: SidebarThreadSummary) => scopeThreadRef(thread.environmentId, thread.id);

const plural = (count: number) => (count === 1 ? "thread" : "threads");

const canOperate = (threads: ReadonlyArray<SidebarThreadSummary>) =>
  threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );

function reportFailures(verb: string, results: ReadonlyArray<CommandResult>) {
  const failed = results.filter(
    (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
  );
  const first = failed[0];
  if (first === undefined || first._tag !== "Failure") return;
  const error = squashAtomCommandFailure(first);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: `Failed to ${verb} ${failed.length} ${plural(failed.length)}`,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** The one value every thread shares, or null. */
function shared<T>(
  threads: ReadonlyArray<SidebarThreadSummary>,
  read: (thread: SidebarThreadSummary) => T,
) {
  const [first, ...rest] = threads.map(read);
  return first !== undefined && rest.every((value) => value === first) ? first : null;
}

function spliceIn<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  at: number,
  added: ReadonlyArray<ContextMenuItem<T>>,
): ReadonlyArray<ContextMenuItem<T>> {
  return added.length === 0 ? items : [...items.slice(0, at), ...added, ...items.slice(at)];
}

/** Just past the first of `ids` the menu has, or its end. */
function indexAfter<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  ids: ReadonlyArray<string>,
): number {
  for (const id of ids) {
    const index = items.findIndex((item) => item.id === id);
    if (index !== -1) return index + 1;
  }
  return items.length;
}

/** Groups threads by the menu ids an item builder offers each of them. */
function byOfferedId(
  threads: ReadonlyArray<SidebarThreadSummary>,
  offered: (thread: SidebarThreadSummary) => ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<SidebarThreadSummary>> {
  const groups = new Map<string, Array<SidebarThreadSummary>>();
  for (const thread of threads) {
    for (const id of offered(thread)) groups.set(id, [...(groups.get(id) ?? []), thread]);
  }
  return groups;
}

export function useBulkThreadMenu() {
  const router = useRouter();
  const { pinThread, unsettleThread, unsnoozeThread, setThreadAutoSettle, archiveThread } =
    useThreadActions();
  const { handleNewThread } = useHandleNewThread();
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const { copyToClipboard } = useCopyToClipboard<{ title: string }>({
    onCopy: ({ title }) => toastManager.add({ type: "success", title }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });

  return (context: BulkThreadMenuContext) => {
    const { threads } = context;
    const keyOf = (thread: SidebarThreadSummary) => scopedThreadKey(refOf(thread));
    const supports = (thread: SidebarThreadSummary) =>
      context.capabilitiesOf(thread.environmentId) ?? {};
    const pinnable = threads.filter(
      (thread) => supports(thread).threadPinning === true && thread.pinnedAt == null,
    );
    const unsettlable = threads.filter(
      (thread) =>
        supports(thread).threadSettlement === true && context.settledKeys.has(keyOf(thread)),
    );
    const wakeable = threads.filter(
      (thread) => supports(thread).threadSnooze === true && context.snoozedKeys.has(keyOf(thread)),
    );
    const autoSettling = threads.filter(
      (thread) => supports(thread).threadAutoSettleOptOut === true,
    );
    const autoSettleEnabled = shared(autoSettling, (thread) => thread.autoSettleDisabledAt == null);
    const archivable = threads.filter((thread) => threadRuntimeCanArchive(thread.runtime));
    const paths = [...new Set(threads.flatMap((thread) => context.workspacePathOf(thread) ?? []))];
    const branches = [...new Set(threads.flatMap((thread) => thread.branch ?? []))];
    const projectGroup = shared(threads, (thread) => context.projectGroupOf(thread));
    // A new thread needs one home: the same project, branch and worktree for all.
    const branchHome =
      shared(threads, (thread) =>
        thread.branch == null
          ? null
          : `${thread.environmentId}\u0000${thread.projectId}\u0000${thread.branch}\u0000${thread.worktreePath ?? ""}`,
      ) === null
        ? null
        : (threads[0] ?? null);
    const comparison =
      shared(threads, (thread) => comparePairOf(thread.id)?.pairId ?? null) === null
        ? null
        : (threads[0] ?? null);
    const waysBack = byOfferedId(threads, (thread) =>
      withHandBackMenuItem([], thread).map((item) => item.id),
    );
    const handingBack = waysBack.get("hand-back") ?? [];
    const movingBack = waysBack.get("move-back") ?? [];
    const notes = byOfferedId(threads, (thread) =>
      withSaveToNotesMenuItem([], thread.environmentId).flatMap(
        (item) => item.children?.map((child) => child.id) ?? [],
      ),
    );
    const summarizing = notes.get("save-to-notes:summary") ?? [];
    const copying = notes.get("save-to-notes:copy") ?? [];

    const withItems = <T extends string>(
      items: ReadonlyArray<ContextMenuItem<T>>,
    ): ReadonlyArray<ContextMenuItem<T | BulkThreadMenuId>> => {
      const lead: Array<ContextMenuItem<BulkThreadMenuId>> = [
        ...(comparison
          ? [{ id: "fork-bulk:open-comparison" as const, label: "Open comparison" }]
          : []),
        ...(handingBack.length > 0
          ? [{ id: "fork-bulk:hand-back" as const, label: `Hand back (${handingBack.length})` }]
          : []),
        ...(movingBack.length > 0
          ? [
              {
                id: "fork-bulk:move-back" as const,
                label: `Move back to Other Agents (${movingBack.length})`,
              },
            ]
          : []),
      ];
      const first: Array<ContextMenuItem<BulkThreadMenuId>> = [
        ...(branchHome?.branch
          ? [
              {
                id: "fork-bulk:new-thread-on-branch" as const,
                label: `New thread on ${branchHome.branch}`,
                separatorBefore: lead.length > 0,
              },
            ]
          : []),
        ...(pinnable.length > 0
          ? [
              {
                id: "fork-bulk:pin" as const,
                label: `Pin (${pinnable.length})`,
                disabled: !canOperate(pinnable),
              },
            ]
          : []),
      ];
      const unsettle: Array<ContextMenuItem<BulkThreadMenuId>> =
        unsettlable.length > 0
          ? [
              {
                id: "fork-bulk:unsettle",
                label: `Un-settle (${unsettlable.length})`,
                disabled: !canOperate(unsettlable),
              },
            ]
          : [];
      const wake: Array<ContextMenuItem<BulkThreadMenuId>> =
        wakeable.length > 0
          ? [
              {
                id: "fork-bulk:wake",
                label: `Wake (${wakeable.length})`,
                disabled: !canOperate(wakeable),
              },
            ]
          : [];
      const afterMarkUnread: Array<ContextMenuItem<BulkThreadMenuId>> = [
        ...(projectGroup
          ? [
              {
                id: "fork-bulk:filter-by-project" as const,
                label:
                  context.projectScopeKey === projectGroup.projectKey
                    ? "Show all projects"
                    : `Filter by ${projectGroup.displayName}`,
              },
            ]
          : []),
        ...(autoSettling.length > 0
          ? [
              {
                id: "fork-bulk:auto-settle" as const,
                label: `Auto-settle behavior (${autoSettling.length})`,
                disabled: !canOperate(autoSettling),
                children: [
                  {
                    id: "fork-bulk:auto-settle:enabled" as const,
                    label: "Enabled",
                    checked: autoSettleEnabled === true,
                  },
                  {
                    id: "fork-bulk:auto-settle:disabled" as const,
                    label: "Disabled",
                    checked: autoSettleEnabled === false,
                  },
                ],
              },
            ]
          : []),
        {
          id: "fork-bulk:copy",
          label: "Copy",
          separatorBefore: true,
          children: [
            ...(paths.length > 0
              ? [{ id: "fork-bulk:copy-paths" as const, label: `Paths (${paths.length})` }]
              : []),
            ...(branches.length > 0
              ? [{ id: "fork-bulk:copy-branches" as const, label: `Branches (${branches.length})` }]
              : []),
            { id: "fork-bulk:copy-thread-ids", label: `Thread IDs (${threads.length})` },
          ],
        },
        {
          id: "fork-bulk:export",
          label: `Export (${threads.length})…`,
          children: [
            { id: "fork-bulk:export:markdown", label: "Markdown (.md)" },
            { id: "fork-bulk:export:json", label: "JSON (.json)" },
          ],
        },
        ...(summarizing.length > 0 || copying.length > 0
          ? [
              {
                id: "fork-bulk:save-to-notes" as const,
                label: "Save to notes…",
                children: [
                  ...(summarizing.length > 0
                    ? [
                        {
                          id: "fork-bulk:save-to-notes:summary" as const,
                          label: `Summaries (${summarizing.length})`,
                        },
                      ]
                    : []),
                  ...(copying.length > 0
                    ? [
                        {
                          id: "fork-bulk:save-to-notes:copy" as const,
                          label: `Full copies (${copying.length})`,
                        },
                      ]
                    : []),
                ],
              },
            ]
          : []),
        ...(projectGroup
          ? [{ id: "fork-bulk:project-settings" as const, label: "Project settings" }]
          : []),
      ];
      const archive: ContextMenuItem<BulkThreadMenuId> = {
        id: "fork-bulk:archive",
        label: `Archive (${archivable.length})`,
        separatorBefore: true,
        disabled: archivable.length === 0 || !canOperate(archivable),
      };

      let next: ReadonlyArray<ContextMenuItem<T | BulkThreadMenuId>> = items;
      next = spliceIn(next, indexAfter(next, ["mark-unread"]), afterMarkUnread);
      const deleteIndex = next.findIndex((item) => item.id === "delete");
      next = spliceIn(next, deleteIndex === -1 ? next.length : deleteIndex, [archive]);
      next = spliceIn(next, indexAfter(next, ["snooze", "settle"]), wake);
      next = spliceIn(next, indexAfter(next, ["settle"]), unsettle);
      next = spliceIn(next, 0, first);
      const [head, ...rest] = next;
      return lead.length === 0 || head === undefined
        ? next
        : [...lead, { ...head, separatorBefore: true }, ...rest];
    };

    const runEach = async (
      verb: string,
      targets: ReadonlyArray<SidebarThreadSummary>,
      action: (thread: SidebarThreadSummary) => Promise<CommandResult>,
    ) => {
      clearSelection();
      const results: Array<CommandResult> = [];
      for (const thread of targets) results.push(await action(thread));
      reportFailures(verb, results);
    };

    const checkOperate = (targets: ReadonlyArray<SidebarThreadSummary>) => {
      if (canOperate(targets)) return true;
      toastManager.add({
        type: "error",
        title: "Thread action unavailable",
        description: "This connection cannot change one or more selected threads.",
      });
      return false;
    };

    const run = async (id: BulkThreadMenuId): Promise<void> => {
      switch (id) {
        case "fork-bulk:open-comparison":
          if (comparison) await openComparisonOf(router, refOf(comparison));
          return;
        case "fork-bulk:hand-back":
        case "fork-bulk:move-back": {
          const action = id === "fork-bulk:hand-back" ? "hand-back" : "move-back";
          clearSelection();
          for (const thread of action === "hand-back" ? handingBack : movingBack) {
            await handBackThread(refOf(thread), action);
          }
          return;
        }
        case "fork-bulk:new-thread-on-branch": {
          if (branchHome === null) return;
          try {
            await handleNewThread(scopeProjectRef(branchHome.environmentId, branchHome.projectId), {
              branch: branchHome.branch,
              worktreePath: branchHome.worktreePath,
              envMode: branchHome.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
            });
          } catch (error) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not create thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        case "fork-bulk:pin":
          if (checkOperate(pinnable)) {
            await runEach("pin", pinnable, (thread) => pinThread(refOf(thread)));
          }
          return;
        case "fork-bulk:unsettle":
          if (checkOperate(unsettlable)) {
            await runEach("un-settle", unsettlable, (thread) => unsettleThread(refOf(thread)));
          }
          return;
        case "fork-bulk:wake":
          if (checkOperate(wakeable)) {
            await runEach("wake", wakeable, (thread) => unsnoozeThread(refOf(thread)));
          }
          return;
        case "fork-bulk:auto-settle:enabled":
        case "fork-bulk:auto-settle:disabled":
          if (checkOperate(autoSettling)) {
            const enabled = id === "fork-bulk:auto-settle:enabled";
            await runEach("update auto-settle for", autoSettling, (thread) =>
              setThreadAutoSettle(refOf(thread), enabled),
            );
          }
          return;
        case "fork-bulk:filter-by-project":
          if (projectGroup) {
            context.setProjectScopeKey(
              context.projectScopeKey === projectGroup.projectKey ? null : projectGroup.projectKey,
            );
          }
          return;
        case "fork-bulk:project-settings": {
          const thread = threads[0];
          if (projectGroup && thread) {
            context.openProjectSettings(
              projectGroup,
              scopeProjectRef(thread.environmentId, thread.projectId),
            );
          }
          return;
        }
        case "fork-bulk:copy-paths":
          copyToClipboard(paths.join("\n"), {
            title: paths.length === 1 ? "Path copied" : `${paths.length} paths copied`,
          });
          return;
        case "fork-bulk:copy-branches":
          copyToClipboard(branches.join("\n"), {
            title: branches.length === 1 ? "Branch copied" : `${branches.length} branches copied`,
          });
          return;
        case "fork-bulk:copy-thread-ids":
          copyToClipboard(threads.map((thread) => thread.id).join("\n"), {
            title: `${threads.length} thread IDs copied`,
          });
          return;
        case "fork-bulk:export:markdown":
        case "fork-bulk:export:json":
          for (const thread of threads) {
            await exportThread(
              refOf(thread),
              id === "fork-bulk:export:json" ? "export:json" : "export:markdown",
            );
          }
          return;
        case "fork-bulk:save-to-notes:summary":
        case "fork-bulk:save-to-notes:copy": {
          const summary = id === "fork-bulk:save-to-notes:summary";
          clearSelection();
          for (const thread of summary ? summarizing : copying) {
            await saveThreadToNotes(
              refOf(thread),
              summary ? "save-to-notes:summary" : "save-to-notes:copy",
            );
          }
          return;
        }
        case "fork-bulk:archive": {
          if (!checkOperate(archivable)) return;
          const api = readLocalApi();
          if (confirmThreadArchive && api) {
            const count = archivable.length;
            const confirmed = await api.dialogs
              .confirm(`Archive ${count} ${plural(count)}?`)
              .catch(() => false);
            if (!confirmed) return;
          }
          await runEach("archive", archivable, (thread) => archiveThread(refOf(thread)));
          return;
        }
        default:
          return;
      }
    };

    return { withItems, run };
  };
}
