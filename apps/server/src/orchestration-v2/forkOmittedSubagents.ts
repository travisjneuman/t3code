// Fork add-on: nested subagents. See packages/contracts/src/forkShellSubagents.ts.
import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Names the subagents among `rows` that the trimmed `snapshot` leaves out, under the parent it
 * sends. Idle children of an omitted parent (an older settled thread) are not named.
 */
function withOmittedSubagents(
  snapshot: OrchestrationV2ShellSnapshot,
  rows: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "lineage">>,
  omitIdleSubagents: boolean,
): OrchestrationV2ShellSnapshot {
  if (!omitIdleSubagents) return snapshot;
  const sent = new Set<ThreadId>(snapshot.threads.map((thread) => thread.id));
  const byParent = new Map<ThreadId, ThreadId[]>();
  for (const row of rows) {
    const parentId = row.lineage.parentThreadId;
    if (row.lineage.relationshipToParent !== "subagent" || parentId === null) continue;
    if (sent.has(row.id) || !sent.has(parentId)) continue;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(row.id);
    else byParent.set(parentId, [row.id]);
  }
  if (byParent.size === 0) return snapshot;
  const omittedSubagents = Array.from(byParent, ([parentThreadId, threadIds]) => ({
    parentThreadId,
    threadIds,
  }));
  return { ...snapshot, omittedSubagents };
}

/** The one hook in `loadSubscriberShellSnapshot`: names the omitted children in its result. */
export function forkOmittedSubagents(
  rows: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "lineage">>,
  options: { readonly omitIdleSubagents: boolean },
) {
  return <T extends { readonly snapshot: OrchestrationV2ShellSnapshot }>(result: T): T => ({
    ...result,
    snapshot: withOmittedSubagents(result.snapshot, rows, options.omitIdleSubagents),
  });
}
