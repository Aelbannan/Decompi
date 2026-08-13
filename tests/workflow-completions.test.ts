/**
 * Workflow completion store tests (SPEC §5): complete/uncomplete/isComplete
 * round-trips across the target-scoped, unit-scoped, and precise row forms;
 * insert-or-ignore idempotency; scoped deletes; list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { WorkflowCompletionStore } from "../src/workflow/completions.js";

async function openStore(): Promise<{ db: SqliteAdapter; store: WorkflowCompletionStore }> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]); // canonical schema.sql, applied fresh
  return { db, store: new WorkflowCompletionStore(db) };
}

test("complete/isComplete/uncomplete round-trip: target, unit, and precise forms", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_roundtrip";

    // Target-scoped (wf, '', T).
    assert.equal(await store.complete({ workflowId: WF, targetId: "t1", actor: "manual" }), true);
    assert.equal(await store.isComplete(WF, { id: "t1" }), true);
    assert.equal(await store.isComplete(WF, { id: "t2" }), false);

    // Unit-scoped (wf, U, '') — any target of the unit reads as complete.
    assert.equal(await store.complete({ workflowId: WF, unitId: "u1", actor: "manual" }), true);
    assert.equal(await store.isComplete(WF, { id: "tX", unitId: "u1" }), true);
    assert.equal(await store.isComplete(WF, { id: "tX" }), false); // no unit info, no target row

    // Precise (wf, U, T).
    assert.equal(
      await store.complete({ workflowId: WF, unitId: "u1", targetId: "t1", actor: "run_1" }),
      true,
    );

    // Target-scoped uncomplete removes the precise row AND the target-scoped
    // row (matches target_id regardless of unit), keeps the unit row.
    assert.equal(await store.uncomplete({ workflowId: WF, targetId: "t1" }), 2);
    assert.equal(await store.isComplete(WF, { id: "t1" }), false);
    assert.equal(await store.isComplete(WF, { id: "t1", unitId: "u1" }), true); // unit row remains

    // Unit-scoped uncomplete removes the remaining unit row.
    assert.equal(await store.uncomplete({ workflowId: WF, unitId: "u1" }), 1);
    assert.equal(await store.isComplete(WF, { id: "t1", unitId: "u1" }), false);
    assert.equal(await store.isComplete(WF, { id: "tX", unitId: "u1" }), false);
  } finally {
    db.close();
  }
});

test("double-complete returns false for the exact row; distinct rows still insert", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_idempotent";
    const params = { workflowId: WF, unitId: "u1", targetId: "t1", actor: "manual", reason: "done" };

    assert.equal(await store.complete(params), true);
    assert.equal(await store.complete(params), false); // insert-or-ignore
    assert.equal(await store.complete({ ...params, reason: "re-run" }), false); // exact row, reason ignored

    // Distinct rows still insert: different target / different unit.
    assert.equal(await store.complete({ workflowId: WF, targetId: "t2", actor: "manual" }), true);
    assert.equal(await store.complete({ workflowId: WF, unitId: "u2", actor: "manual" }), true);

    const rows = await store.list(WF);
    assert.equal(rows.length, 3);
    const forms = new Set(rows.map((r) => `${r.unitId}|${r.targetId}`));
    assert.deepEqual(forms, new Set(["u1|t1", "|t2", "u2|"]));
  } finally {
    db.close();
  }
});

test("target-scoped uncomplete removes the precise row", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_precise";
    // Run-time finalize writes the precise form; a manual target delete must remove it.
    assert.equal(await store.complete({ workflowId: WF, unitId: "u1", targetId: "t1", actor: "run_1" }), true);
    assert.equal(await store.complete({ workflowId: WF, targetId: "t1", actor: "manual" }), true);

    assert.equal(await store.uncomplete({ workflowId: WF, targetId: "t1" }), 2);
    assert.deepEqual(await store.list(WF), []);
    assert.equal(await store.isComplete(WF, { id: "t1" }), false);
    assert.equal(await store.isComplete(WF, { id: "t1", unitId: "u1" }), false);
  } finally {
    db.close();
  }
});

test("unit-scoped uncomplete removes unit-scoped and precise rows for that unit only", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_unit";
    assert.equal(await store.complete({ workflowId: WF, unitId: "u1", targetId: "t1", actor: "run_1" }), true);
    assert.equal(await store.complete({ workflowId: WF, unitId: "u1", actor: "manual" }), true);
    // Another unit's precise row must survive.
    assert.equal(await store.complete({ workflowId: WF, unitId: "u2", targetId: "t9", actor: "run_1" }), true);

    assert.equal(await store.uncomplete({ workflowId: WF, unitId: "u1" }), 2);
    const remaining = await store.list(WF);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.unitId, "u2");
    assert.equal(remaining[0]!.targetId, "t9");
  } finally {
    db.close();
  }
});

test("uncomplete with neither unit nor target clears all rows for the workflow", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_all";
    await store.complete({ workflowId: WF, targetId: "t1", actor: "manual" });
    await store.complete({ workflowId: WF, unitId: "u1", actor: "manual" });
    await store.complete({ workflowId: "wf_other", targetId: "t1", actor: "manual" });

    assert.equal(await store.uncomplete({ workflowId: WF }), 2);
    assert.equal((await store.list(WF)).length, 0);
    assert.equal((await store.list("wf_other")).length, 1); // untouched
  } finally {
    db.close();
  }
});

test("list returns camelCase rows with actor/reason; workflow-scoped isolation", async () => {
  const { db, store } = await openStore();
  try {
    const WF = "wf_list";
    await store.complete({ workflowId: WF, unitId: "u1", actor: "token_a", reason: "unit done" });
    await store.complete({ workflowId: WF, targetId: "t1", actor: "manual" });
    await store.complete({ workflowId: "wf_list_other", targetId: "t1", actor: "manual" });

    const rows = await store.list(WF);
    assert.equal(rows.length, 2);
    const byForm = new Map(rows.map((r) => [`${r.unitId}|${r.targetId}`, r]));
    const unitRow = byForm.get("u1|")!;
    assert.ok(unitRow.id);
    assert.equal(unitRow.workflowId, WF);
    assert.equal(unitRow.unitId, "u1");
    assert.equal(unitRow.targetId, "");
    assert.equal(unitRow.actor, "token_a");
    assert.equal(unitRow.reason, "unit done");
    assert.match(unitRow.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    const targetRow = byForm.get("|t1")!;
    assert.equal(targetRow.actor, "manual");
    assert.equal(targetRow.reason, null);
  } finally {
    db.close();
  }
});
