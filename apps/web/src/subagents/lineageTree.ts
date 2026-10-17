/**
 * The thread details Lineage panel's subagents as whole trees: every subagent
 * descendant nested depth-first under its parent, not only direct children.
 * A tree never splits across sections: one with any live descendant stays
 * under Active. Fork add-on: nested lineage.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  arrayElementsEqual,
  parseThreadKey,
  threadKey,
} from "@t3tools/client-runtime/state/entities";
import {
  orderWebThreadLineageRows,
  type ThreadRelationshipEdge,
  type ThreadRelationshipGraph,
  type ThreadRelationshipWalkRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { CSSProperties } from "react";

import { environmentThreadShells } from "../state/threads";

type LineageRow = ThreadRelationshipWalkRow;

/** Deeper rows than this indent no further, like the sidebar's subagents. */
const MAX_INDENT_DEPTH = 3;
const INDENT_STYLES: ReadonlyArray<CSSProperties> = Array.from(
  { length: MAX_INDENT_DEPTH },
  (_, index) => ({ paddingInlineStart: `${(index + 1) * 0.75}rem` }),
);
/** The statuses the panel files under Previous agents; anything else is live. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "interrupted",
  "idle",
]);
const NO_SHELLS: ReadonlyArray<OrchestrationV2ThreadShell> = Object.freeze([]);

function selectSubagentDescendantShells(
  threadId: ThreadId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const childrenOf = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const thread of threads) {
    const parentId = thread.lineage.parentThreadId;
    if (parentId === null || thread.lineage.relationshipToParent !== "subagent") continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(thread);
    else childrenOf.set(parentId, [thread]);
  }
  if (!childrenOf.has(threadId)) return NO_SHELLS;
  const seen = new Set<ThreadId>([threadId]);
  const pending: ThreadId[] = [threadId];
  const descendants: OrchestrationV2ThreadShell[] = [];
  // The array iterator re-reads the length, so ids pushed here are visited too.
  for (const parentId of pending) {
    for (const child of childrenOf.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      pending.push(child.id);
    }
  }
  return descendants;
}

// The upstream relationship shells stop at direct children. This adds every
// live subagent below the thread, and keeps its array while those shells are
// unchanged so unrelated threads streaming do not re-render the panel.
const descendantShellsAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous = NO_SHELLS;
  return Atom.make((get) => {
    const next = selectSubagentDescendantShells(
      ref.threadId,
      get(environmentThreadShells.environmentThreadsAtom(ref.environmentId)),
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-thread-subagent-descendants:${key}`));
});

export function useSubagentDescendantShells(
  ref: ScopedThreadRef,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  return useAtomValue(descendantShellsAtomFamily(threadKey(ref)));
}

/**
 * Expands the panel's direct subagent rows into their trees, each descendant
 * right after its parent, newest-created first at every level. A Previous tree
 * with a live descendant moves to Active whole. Rows keep the walk's depth, 1
 * for a direct child.
 */
export function nestSubagentLineage(
  graph: ThreadRelationshipGraph,
  projection: Pick<OrchestrationV2ThreadProjection, "subagents"> | null,
  currentThreadId: ThreadId,
  active: ReadonlyArray<LineageRow>,
  previous: ReadonlyArray<LineageRow>,
): { readonly active: ReadonlyArray<LineageRow>; readonly previous: ReadonlyArray<LineageRow> } {
  const childEdgesOf = new Map<ThreadId, ThreadRelationshipEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "subagent" || edge.sourceThreadId === currentThreadId) continue;
    const edges = childEdgesOf.get(edge.sourceThreadId);
    if (edges) edges.push(edge);
    else childEdgesOf.set(edge.sourceThreadId, [edge]);
  }
  if (childEdgesOf.size === 0) return { active, previous };

  // Seeded with the thread and its direct rows so a cycle or a stray edge
  // cannot list a thread twice. Workflow members are children of their
  // coordinator's thread, but its workflow row already lists them.
  const seen = new Set<ThreadId>([currentThreadId]);
  for (const row of active) seen.add(row.threadId);
  for (const row of previous) seen.add(row.threadId);
  for (const subagent of projection?.subagents ?? []) {
    for (const member of subagent.workflow?.agents ?? []) {
      if (member.childThreadId !== undefined) seen.add(member.childThreadId);
    }
  }
  const order = (rows: ReadonlyArray<LineageRow>) =>
    orderWebThreadLineageRows({ graph, rows, currentThreadId, mergeTargetThreadId: null });
  const childRows = (parent: LineageRow): ReadonlyArray<LineageRow> => {
    const rows: LineageRow[] = [];
    for (const edge of childEdgesOf.get(parent.threadId) ?? []) {
      if (seen.has(edge.targetThreadId)) continue;
      seen.add(edge.targetThreadId);
      rows.push({
        threadId: edge.targetThreadId,
        fromThreadId: parent.threadId,
        depth: parent.depth + 1,
        edge,
      });
    }
    return rows.length > 1 ? order(rows) : rows;
  };
  const subtree = (root: LineageRow) => {
    const rows: LineageRow[] = [];
    let live = false;
    // An explicit stack instead of recursion, so a very deep chain cannot
    // overflow the call stack.
    const stack: LineageRow[] = [root];
    for (let row = stack.pop(); row !== undefined; row = stack.pop()) {
      rows.push(row);
      if (row !== root && !FINISHED_STATUSES.has(row.edge.status ?? "")) live = true;
      stack.push(...childRows(row).toReversed());
    }
    return { rows, live };
  };

  const trees = new Map<ThreadId, ReadonlyArray<LineageRow>>();
  const promoted: LineageRow[] = [];
  const stayed: LineageRow[] = [];
  for (const row of active) trees.set(row.threadId, subtree(row).rows);
  for (const row of previous) {
    const tree = subtree(row);
    trees.set(row.threadId, tree.rows);
    (tree.live ? promoted : stayed).push(row);
  }
  const expand = (rows: ReadonlyArray<LineageRow>) =>
    rows.flatMap((row) => trees.get(row.threadId) ?? [row]);
  return {
    active: expand(promoted.length === 0 ? active : order([...active, ...promoted])),
    previous: expand(stayed),
  };
}

/** Indents a nested row like the sidebar; direct children stay flush. */
export function lineageIndentStyle(depth: number): CSSProperties | undefined {
  return depth <= 1 ? undefined : INDENT_STYLES[Math.min(depth - 1, MAX_INDENT_DEPTH) - 1];
}
