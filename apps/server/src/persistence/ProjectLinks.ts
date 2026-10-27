/**
 * Fork add-on: project links. Projects on different machines that store the
 * same link key group as one project in every client. The key lives in the
 * fork's `fork_project_links` table; `ProjectStoreV2` reads it as a column and
 * writes it when a `project.meta-updated` event carries one.
 */
import type { ApplicationProjectMetaUpdatedPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runForkMigrations } from "./ForkMigrations.ts";

export const makeProjectLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A failed migration leaves every project unlinked rather than failing the store.
  const ready = yield* runForkMigrations().pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.logWarning("project-links.migration-failed", { error: error.message }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const linkKeyColumn = ready
    ? sql`(SELECT link_key FROM fork_project_links WHERE fork_project_links.project_id = projection_projects.project_id)`
    : sql`NULL`;

  /** Call inside the commit transaction, after the project row is written. */
  const apply = ({ projectId, linkKey }: ApplicationProjectMetaUpdatedPayload) =>
    !ready || linkKey === undefined
      ? Effect.void
      : linkKey === null
        ? sql`DELETE FROM fork_project_links WHERE project_id = ${projectId}`.pipe(Effect.asVoid)
        : sql`
            INSERT INTO fork_project_links (project_id, link_key)
            VALUES (${projectId}, ${linkKey})
            ON CONFLICT (project_id) DO UPDATE SET link_key = excluded.link_key
          `.pipe(Effect.asVoid);

  return { linkKeyColumn, apply } as const;
});
