import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork add-on: project links. A project's link key, kept beside upstream's
 * `projection_projects` so upstream builds sharing the database ignore it.
 *
 * Rollback: `DROP TABLE IF EXISTS fork_project_links;` and
 * `DELETE FROM fork_sql_migrations WHERE migration_id = 3;`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_project_links (
      project_id TEXT PRIMARY KEY,
      link_key TEXT NOT NULL
    )
  `;
});
