/**
 * Versioned migration runner (SPEC §6.1, §6.2).
 *
 * Pipeline:
 *  1. Create `schema_migrations` if absent.
 *  2. Apply the canonical `schema.sql` DDL once, recorded as version 0.
 *  3. Run any supplied `Migration.up` callbacks in ascending version order,
 *     each inside its own transaction, with the version row inserted in the
 *     same transaction (so a failing migration records nothing and can retry).
 */
import { readFileSync } from "node:fs";
import type { Migration, SqlAdapter } from "./adapter.js";

/**
 * Locate and read the canonical DDL (§6.2). Resolution is robust across both
 * trees the module can run from:
 *  - source tree (tsx / tests): `./schema.sql` sits beside this module;
 *  - compiled `dist` (npm run build copies schema.sql next to the emitted
 *    migrations.js): `./schema.sql` again; when that copy is absent, fall
 *    back to the source tree via `../../../src/core/store/schema.sql`.
 */
function loadSchemaSql(): string {
  const candidates = [
    new URL("./schema.sql", import.meta.url),
    new URL("../../../src/core/store/schema.sql", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("schema.sql: not found beside migrations or in the source tree");
}

/** Canonical DDL (§6.2), read from the file beside this module. */
const schemaSql: string = loadSchemaSql();

/** Version slot reserved for the base `schema.sql` application. */
const BASE_SCHEMA_VERSION = 0;

/**
 * Migration v1: `workflow_completions` → `workflow_status` (SPEC §A.2).
 *
 * v0 shipped a boolean completion table; the status ladder replaces it with
 * a status-per-scope table over the SAME UNIQUE key. Existing databases are
 * migrated in place (rename + add `status` + backfill), fresh databases
 * (whose v0 DDL now creates `workflow_status` directly) are untouched.
 *
 * Idempotence/guards:
 *  - `workflow_status` already present → no-op (fresh DB from the v0 DDL, or
 *    the migration already ran without recording its version row);
 *  - `workflow_completions` present → rename + backfill:
 *      1. rename the table (rows, UNIQUE constraint, and PK carry over);
 *      2. add `status TEXT NOT NULL DEFAULT 'DONE'` (existing rows are
 *         backfilled to 'DONE' by the column default);
 *      3. copy `completed_at` into `updated_at` (timestamp semantics), then
 *         drop the now-unneeded `completed_at`;
 *      4. recreate the three indexes under the `workflow_status` names
 *         (SQLite's ALTER TABLE RENAME leaves the old index names behind).
 *  - neither table → defensive CREATE (a store the v0 DDL somehow missed).
 */
const WORKFLOW_STATUS_DDL = `
CREATE TABLE workflow_status (
  workflow_id TEXT NOT NULL,
  unit_id TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  UNIQUE (workflow_id, unit_id, target_id)
);
CREATE INDEX idx_workflow_status_workflow ON workflow_status(workflow_id);
CREATE INDEX idx_workflow_status_unit ON workflow_status(unit_id);
CREATE INDEX idx_workflow_status_target ON workflow_status(target_id);
`;

const migrationV1: Migration = {
  version: 1,
  up: async (tx) => {
    const tables = await tx.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workflow_status', 'workflow_completions')",
    );
    const names = new Set(tables.map((row) => row.name));
    if (names.has("workflow_status")) return; // fresh DB / already migrated

    if (names.has("workflow_completions")) {
      // v0-era DB: rename in place, then backfill the new columns.
      await tx.execute("ALTER TABLE workflow_completions RENAME TO workflow_status");
      // `status` is NOT NULL with a DEFAULT 'DONE': every existing row is
      // backfilled to 'DONE' by the column default (SPEC §A.2 step 2).
      await tx.execute(
        "ALTER TABLE workflow_status ADD COLUMN status TEXT NOT NULL DEFAULT 'DONE'",
      );
      // `updated_at` does not exist in v0 — add it (NOT NULL needs a
      // constant default; the backfill below overwrites it) and copy
      // `completed_at` over, then drop the now-unneeded column (SPEC §A.2:
      // drop, not retain — the status store is the single writer and v1 is
      // immediately after v0).
      await tx.execute(
        "ALTER TABLE workflow_status ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
      );
      await tx.execute("UPDATE workflow_status SET updated_at = completed_at");
      await tx.execute("ALTER TABLE workflow_status DROP COLUMN completed_at");
      // SQLite's RENAME keeps the old index names bound to the new table;
      // recreate them under the workflow_status names for schema parity.
      await tx.execute("DROP INDEX IF EXISTS idx_workflow_completions_workflow");
      await tx.execute("DROP INDEX IF EXISTS idx_workflow_completions_unit");
      await tx.execute("DROP INDEX IF EXISTS idx_workflow_completions_target");
      await tx.execute("CREATE INDEX idx_workflow_status_workflow ON workflow_status(workflow_id)");
      await tx.execute("CREATE INDEX idx_workflow_status_unit ON workflow_status(unit_id)");
      await tx.execute("CREATE INDEX idx_workflow_status_target ON workflow_status(target_id)");
      return;
    }

    // Neither table: defensive CREATE (a store the v0 DDL somehow missed).
    await tx.execute(WORKFLOW_STATUS_DDL);
  },
};

/**
 * The versioned migrations to register at every `migrate([...])` call site
 * (serve, CLI, tests): the runner applies them in ascending version order
 * after the canonical v0 DDL.
 */
export const MIGRATIONS: readonly Migration[] = [migrationV1];

/**
 * The tracking-table DDL as it appears verbatim at the top of `schema.sql`
 * (§6.2). The runner ensures this table itself, so the statement is dropped
 * before applying the rest of the canonical DDL.
 */
const SCHEMA_MIGRATIONS_DDL =
  "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);";

function schemaWithoutTrackingTable(): string {
  return schemaSql.startsWith(SCHEMA_MIGRATIONS_DDL)
    ? schemaSql.slice(SCHEMA_MIGRATIONS_DDL.length)
    : schemaSql;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function runMigrations(
  sql: SqlAdapter,
  migrations: readonly Migration[] = [],
): Promise<void> {
  await sql.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  const appliedRows = await sql.query<{ version: number }>(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(appliedRows.map((row) => row.version));

  if (!applied.has(BASE_SCHEMA_VERSION)) {
    await sql.transaction(async (tx) => {
      await tx.execute(schemaWithoutTrackingTable());
      await tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        BASE_SCHEMA_VERSION,
        nowIso(),
      ]);
    });
    applied.add(BASE_SCHEMA_VERSION);
  }

  const pending = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    if (applied.has(migration.version)) continue;
    await sql.transaction(async (tx) => {
      await migration.up(tx);
      await tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        nowIso(),
      ]);
    });
    applied.add(migration.version);
  }
}
