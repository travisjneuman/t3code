/**
 * Thread families: a subagent thread belongs to its nearest ancestor that is not a subagent,
 * found through `lineage.parentThreadId`. Retention, storage and the archive cascade share this.
 * Resolved in memory because the threads table has no index on the parent link.
 * Fork add-on: thread retention.
 *
 * @module thread-retention/threadFamily
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type * as SqlClient from "effect/sql/SqlClient";

export interface ThreadFamilyRow {
  readonly thread_id: string;
  readonly parent_thread_id: string | null;
  readonly relationship: string | null;
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
}

export const readThreadFamilyRows = (sql: SqlClient.SqlClient) =>
  sql<ThreadFamilyRow>`
    SELECT thread_id,
      json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
      json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
      archived_at, deleted_at
    FROM orchestration_v2_projection_threads
  `.pipe(NodeSqliteClient.readOnly);

export type FamilyLinks = Pick<ThreadFamilyRow, "thread_id" | "parent_thread_id" | "relationship">;

export interface ThreadFamilyIndex<Row extends FamilyLinks> {
  readonly rows: ReadonlyArray<Row>;
  readonly row: (threadId: string) => Row | undefined;
  /** The topmost thread reachable through subagent links; a subagent itself when its parent is gone. */
  readonly ownerOf: (threadId: string) => string;
  /** Every subagent thread below this one, at any depth. */
  readonly descendantsOf: (threadId: string) => Array<string>;
}

export function indexThreadFamilies<Row extends FamilyLinks>(
  rows: ReadonlyArray<Row>,
): ThreadFamilyIndex<Row> {
  const byId = new Map(rows.map((row) => [row.thread_id, row] as const));
  const children = new Map<string, Array<string>>();
  for (const row of rows) {
    if (row.relationship !== "subagent" || row.parent_thread_id === null) continue;
    const siblings = children.get(row.parent_thread_id);
    if (siblings === undefined) children.set(row.parent_thread_id, [row.thread_id]);
    else siblings.push(row.thread_id);
  }

  const ownerOf = (threadId: string): string => {
    const seen = new Set<string>();
    let current = byId.get(threadId);
    while (
      current !== undefined &&
      current.relationship === "subagent" &&
      current.parent_thread_id !== null &&
      !seen.has(current.thread_id)
    ) {
      seen.add(current.thread_id);
      const parent = byId.get(current.parent_thread_id);
      if (parent === undefined) break;
      current = parent;
    }
    return current?.thread_id ?? threadId;
  };

  const descendantsOf = (threadId: string): Array<string> => {
    const found: Array<string> = [];
    const seen = new Set([threadId]);
    const queue = [threadId];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const child of children.get(next) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
    return found;
  };

  return { rows, row: (threadId: string) => byId.get(threadId), ownerOf, descendantsOf };
}
