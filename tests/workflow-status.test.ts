/**
 * Workflow status store tests (SPEC §A.2–§A.3): `setStatus` UPSERT
 * idempotency (re-set replaces, never stacks), `resolveStatus` precedence
 * (target-within-unit > target-scoped > unit-scoped — never an OR),
 * `isDone` against `doneStatuses`, scoped `unsetStatus`, `list`, plus the
 * migration-v1 path: an in-memory store seeded with the OLD
 * `workflow_completions` schema migrates to `workflow_status` with rows
 * backfilled (status 'DONE', `updated_at` from `completed_at`), and a fresh
 * DB skips the rename.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { WorkflowStatusStore } from "../src/workflow/status.js";
import { MIGRATIONS } from "../src/core/store/migrations.js";

async function openStore(): Promise<{ db: SqliteAdapter; store: WorkflowStatusStore }> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([...MIGRATIONS]); // canonical schema.sql + migration v1
  return { db, store: new WorkflowStatusStore(db) };
}

test("setStatus UPSERTs: re-setting the same (workflow, unit, target) replaces the row", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_upsert";

    await store.setStatus({ workflowId: WF, unitId: "u1", targetId: "t1", status: "CODE_MATCH", actor: "run_1" });
    // Re-set the exact row: status/actor/reason replaced, updated_at bumped,
    // still ONE row (the UNIQUE key is the identity — no stacking).
    await store.setStatus({ workflowId: WF, unitId: "u1", targetId: "t1", status: "FULL_MATCH", actor: "run_2", reason: "re-verified" });

    const rows = await store.list(WF);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.unitId, "u1");
    assert.equal(rows[0]!.targetId, "t1");
    assert.equal(rows[0]!.status, "FULL_MATCH");
    assert.equal(rows[0]!.actor, "run_2");
    assert.equal(rows[0]!.reason, "re-verified");

    // Distinct rows still insert: different target / different unit.
    await store.setStatus({ workflowId: WF, targetId: "t2", status: "DONE", actor: "manual" });
    await store.setStatus({ workflowId: WF, unitId: "u2", status: "DONE", actor: "manual" });
    const forms = new Set((await store.list(WF)).map((r) => `${r.unitId}|${r.targetId}`));
    assert.deepEqual(forms, new Set(["u1|t1", "|t2", "u2|"]));
  } finally {
    db.close();
  }
});

test("resolveStatus precedence: precise > target-scoped > unit-scoped (resolve-then-test, not OR)", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_precedence";

    // Precise row (wf, u1, t1) wins over the target-scoped and unit rows.
    await store.setStatus({ workflowId: WF, unitId: "u1", targetId: "t1", status: "REJECTED", actor: "run_1" });
    await store.setStatus({ workflowId: WF, targetId: "t1", status: "FULL_MATCH", actor: "manual" });
    await store.setStatus({ workflowId: WF, unitId: "u1", status: "DONE", actor: "manual" });
    assert.equal(await store.resolveStatus(WF, { id: "t1", unitId: "u1" }), "REJECTED");

    // Target-scoped row (wf, '', t2) wins over the unit row.
    await store.setStatus({ workflowId: WF, targetId: "t2", status: "DONE", actor: "manual" });
    await store.setStatus({ workflowId: WF, unitId: "u1", status: "REJECTED", actor: "run_2" });
    assert.equal(await store.resolveStatus(WF, { id: "t2", unitId: "u1" }), "DONE");

    // Unit-scoped row (wf, u3, '') is the fallback for a target of u3.
    await store.setStatus({ workflowId: WF, unitId: "u3", status: "DONE", actor: "manual" });
    assert.equal(await store.resolveStatus(WF, { id: "t9", unitId: "u3" }), "DONE");

    // No row anywhere → null.
    assert.equal(await store.resolveStatus(WF, { id: "t9", unitId: "u9" }), null);
    assert.equal(await store.resolveStatus(WF, { id: "t9" }), null);
  } finally {
    db.close();
  }
});

test("isDone resolves then tests against doneStatuses (target wins over a DONE unit row)", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_isdone";

    // A DONE unit row covers every target of the unit…
    await store.setStatus({ workflowId: WF, unitId: "u1", status: "DONE", actor: "manual" });
    assert.equal(await store.isDone(WF, { id: "tX", unitId: "u1" }, ["DONE"]), true);

    // …but a re-broken target's precise row resolves first: never an OR that
    // lets the DONE unit row hide it (SPEC §A.3).
    await store.setStatus({ workflowId: WF, unitId: "u1", targetId: "tX", status: "REJECTED", actor: "run_1" });
    assert.equal(await store.isDone(WF, { id: "tX", unitId: "u1" }, ["DONE"]), false);
    assert.equal(await store.isDone(WF, { id: "tX", unitId: "u1" }, ["DONE", "REJECTED"]), true);

    // Target-scoped row; a target without a unit reads it.
    await store.setStatus({ workflowId: WF, targetId: "tY", status: "DONE", actor: "manual" });
    assert.equal(await store.isDone(WF, { id: "tY" }, ["DONE"]), true);
    assert.equal(await store.isDone(WF, { id: "tY", unitId: "u1" }, ["DONE"]), true); // unit row would also match

    // Empty doneStatuses never matches (never a silent catch-all).
    await store.setStatus({ workflowId: WF, targetId: "tZ", status: "DONE", actor: "manual" });
    assert.equal(await store.isDone(WF, { id: "tZ" }, []), false);
    assert.equal(await store.isDone(WF, { id: "tZ" }, ["DONE"]), true);
  } finally {
    db.close();
  }
});

test("unsetStatus: target-scoped deletes precise + target rows; unit-scoped deletes unit rows; neither clears all", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_unset";
    // Run-time finalize writes the precise form; a manual target reset must remove it.
    await store.setStatus({ workflowId: WF, unitId: "u1", targetId: "t1", status: "DONE", actor: "run_1" });
    await store.setStatus({ workflowId: WF, targetId: "t1", status: "DONE", actor: "manual" });
    await store.setStatus({ workflowId: WF, unitId: "u1", status: "DONE", actor: "manual" });
    // Another unit's precise row must survive.
    await store.setStatus({ workflowId: WF, unitId: "u2", targetId: "t9", status: "DONE", actor: "run_1" });

    assert.equal(await store.unsetStatus({ workflowId: WF, targetId: "t1" }), 2);
    const remaining = await store.list(WF);
    assert.equal(remaining.length, 2); // (u1, '') and (u2, t9)
    assert.deepEqual(new Set(remaining.map((r) => `${r.unitId}|${r.targetId}`)), new Set(["u1|", "u2|t9"]));

    assert.equal(await store.unsetStatus({ workflowId: WF, unitId: "u2" }), 1);
    assert.equal((await store.list(WF)).length, 1);
    assert.equal((await store.list(WF))[0]!.unitId, "u1");

    assert.equal(await store.unsetStatus({ workflowId: WF }), 1);
    assert.deepEqual(await store.list(WF), []);
  } finally {
    db.close();
  }
});

test("list returns camelCase rows with status/actor/reason; workflow-scoped isolation", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_list";
    await store.setStatus({ workflowId: WF, unitId: "u1", status: "DONE", actor: "token_a", reason: "unit done" });
    await store.setStatus({ workflowId: WF, targetId: "t1", status: "FULL_MATCH", actor: "manual" });
    await store.setStatus({ workflowId: "wf_list_other", targetId: "t1", status: "DONE", actor: "manual" });

    const rows = await store.list(WF);
    assert.equal(rows.length, 2);
    const byForm = new Map(rows.map((r) => [`${r.unitId}|${r.targetId}`, r]));
    const unitRow = byForm.get("u1|")!;
    assert.equal(unitRow.workflowId, WF);
    assert.equal(unitRow.unitId, "u1");
    assert.equal(unitRow.targetId, "");
    assert.equal(unitRow.status, "DONE");
    assert.equal(unitRow.actor, "token_a");
    assert.equal(unitRow.reason, "unit done");
    assert.match(unitRow.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    const targetRow = byForm.get("|t1")!;
    assert.equal(targetRow.status, "FULL_MATCH");
    assert.equal(targetRow.actor, "manual");
    assert.equal(targetRow.reason, null);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Migration v1: workflow_completions → workflow_status
// ---------------------------------------------------------------------------

/** Create the v0-era `workflow_completions` table exactly as shipped. */
function createOldCompletionsSchema(db: SqliteAdapter): Promise<{ changes: number }> {
  return db.execute(`
    CREATE TABLE workflow_completions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      unit_id TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL,
      actor TEXT NOT NULL,                 -- token id, "manual", or run_id
      reason TEXT,
      UNIQUE (workflow_id, unit_id, target_id)
    );
    CREATE INDEX idx_workflow_completions_workflow ON workflow_completions(workflow_id);
    CREATE INDEX idx_workflow_completions_unit ON workflow_completions(unit_id);
    CREATE INDEX idx_workflow_completions_target ON workflow_completions(target_id);
  `);
}

test("migration v1: an existing DB (v0 schema) is renamed + backfilled to workflow_status", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    // Simulate a shipped v0 DB: the old completion table with data, and
    // version 0 recorded so the canonical DDL does not re-run.
    await createOldCompletionsSchema(db);
    await db.execute(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    await db.execute(
      `INSERT INTO workflow_completions (id, workflow_id, unit_id, target_id, completed_at, actor, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "c1",
        "wf_old",
        "u1",
        "t1",
        "2025-01-01T00:00:00.000Z",
        "manual",
        "unit done",
      ],
    );
    await db.execute(
      `INSERT INTO workflow_completions (id, workflow_id, unit_id, target_id, completed_at, actor, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["c2", "wf_old", "", "t2", "2025-01-02T00:00:00.000Z", "run_1", null],
    );
    await db.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (0, ?)", [
      new Date().toISOString(),
    ]);

    // The v0-era table exists; workflow_status does not (yet).
    const before = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workflow_completions', 'workflow_status')",
    );
    assert.deepEqual(new Set(before.map((r) => r.name)), new Set(["workflow_completions"]));

    await db.migrate([...MIGRATIONS]);

    // workflow_completions is gone; workflow_status carries the rows.
    const after = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workflow_completions', 'workflow_status')",
    );
    assert.deepEqual(new Set(after.map((r) => r.name)), new Set(["workflow_status"]));

    // Backfilled: status = 'DONE', updated_at = completed_at, actor/reason copied.
    const rows = await db.query<{
      workflow_id: string;
      unit_id: string;
      target_id: string;
      status: string;
      updated_at: string;
      actor: string;
      reason: string | null;
    }>("SELECT * FROM workflow_status ORDER BY updated_at");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => ({
        unit: r.unit_id,
        target: r.target_id,
        status: r.status,
        updatedAt: r.updated_at,
        actor: r.actor,
        reason: r.reason,
      })),
      [
        { unit: "u1", target: "t1", status: "DONE", updatedAt: "2025-01-01T00:00:00.000Z", actor: "manual", reason: "unit done" },
        { unit: "", target: "t2", status: "DONE", updatedAt: "2025-01-02T00:00:00.000Z", actor: "run_1", reason: null },
      ],
    );

    // The UNIQUE key survived the rename: the status store can upsert over it.
    const store = new WorkflowStatusStore(db);
    await store.setStatus({ workflowId: "wf_old", unitId: "u1", targetId: "t1", status: "FULL_MATCH", actor: "run_2" });
    const upserted = await store.list("wf_old");
    assert.equal(upserted.length, 2);
    assert.equal(upserted.find((r) => r.targetId === "t1")!.status, "FULL_MATCH");

    // The three indexes are present under the workflow_status names.
    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_workflow_%'",
    );
    assert.deepEqual(
      new Set(indexes.map((i) => i.name)),
      new Set(["idx_workflow_status_workflow", "idx_workflow_status_unit", "idx_workflow_status_target"]),
    );

    // The migration records version 1; re-running is a no-op.
    const versions = await db.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((v) => v.version), [0, 1]);
    await db.migrate([...MIGRATIONS]);
    assert.equal((await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM workflow_status"))[0]!.n, 2);
  } finally {
    db.close();
  }
});

test("migration v1: a fresh DB (workflow_status from the v0 DDL) skips the rename", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([...MIGRATIONS]);

    // Fresh DDL created workflow_status directly; no workflow_completions.
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workflow_completions', 'workflow_status')",
    );
    assert.deepEqual(new Set(tables.map((r) => r.name)), new Set(["workflow_status"]));

    // The store works end-to-end on the fresh schema.
    const store = new WorkflowStatusStore(db);
    await store.setStatus({ workflowId: "wf_fresh", targetId: "t1", status: "DONE", actor: "manual" });
    assert.equal(await store.resolveStatus("wf_fresh", { id: "t1" }), "DONE");

    const versions = await db.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((v) => v.version), [0, 1]);
  } finally {
    db.close();
  }
});

test("migration v1: idempotent re-run after a partial state leaves rows intact", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    // Migrate once (fresh), then simulate a re-run from a bare state where
    // the version row was lost but workflow_status exists: the guard skips.
    await db.migrate([...MIGRATIONS]);
    const store = new WorkflowStatusStore(db);
    await store.setStatus({ workflowId: "wf_re", unitId: "u1", targetId: "t1", status: "DONE", actor: "manual" });
    await db.execute("DELETE FROM schema_migrations WHERE version = 1");

    await db.migrate([...MIGRATIONS]); // must not error or clobber
    assert.equal((await store.list("wf_re")).length, 1);
    assert.equal((await store.list("wf_re"))[0]!.status, "DONE");
  } finally {
    db.close();
  }
});
