/**
 * Fork add-on: the fork's own schema migrations, in their own ledger.
 *
 * Upstream's migrator compares ids only and skips every id at or below the
 * highest one recorded, so a fork migration in `effect_sql_migrations` would
 * mask a future upstream migration at that id forever, and upstream builds
 * reject such a history from id 55 on (docs/internals/legacy-orchestration-migration.md,
 * "Divergent migration ids"). Fork tables are therefore migrated here, in
 * `fork_sql_migrations`, which upstream never reads. The fork shares `~/.t3`
 * with official T3 Code, so these migrations only add tables that upstream
 * builds can ignore.
 *
 * A fork-owned repository runs `runForkMigrations` when its layer is built;
 * the migrator records each id once and treats a concurrent run as done.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import ForkMigration0001 from "./ForkMigrations/001_SessionInsightsReports.ts";
import ForkMigration0002 from "./ForkMigrations/002_SessionInsightsOutputs.ts";
import ForkMigration0003 from "./ForkMigrations/003_ProjectLinks.ts";

const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

/** Key format `{id}_{name}`, as upstream's loader; ids are the fork's own sequence. */
const forkMigrationEntries = [
  [1, "SessionInsightsReports", ForkMigration0001],
  [2, "SessionInsightsOutputs", ForkMigration0002],
  [3, "ProjectLinks", ForkMigration0003],
] as const;

const loader = Migrator.fromRecord(
  Object.fromEntries(
    forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

const run = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({ loader, table: FORK_MIGRATIONS_TABLE });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
