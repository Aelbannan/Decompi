/**
 * Run scope tests (SPEC §6): applyScope intersects (ANDs) targetIds/unitIds
 * into a Selector, scopeToSelector folds a scope for persistence, and the
 * selector compiles filter.ids into WHERE id IN (...).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import type { Selector } from "../src/types.js";
import { compileSelector, select, validateSelector } from "../src/target/selector.js";
import { applyScope, scopeToSelector } from "../src/workflow/scope.js";

test("applyScope ANDs targetIds into filter.ids and unitIds into filter.unit", async () => {
  const selector: Selector = {
    filter: { status: ["NOT_STARTED"], kind: ["function"] },
    sort: [{ by: "size", dir: "asc" }],
    limit: 5,
  };
  const scoped = applyScope(selector, { targetIds: ["t1", "t2"], unitIds: ["u1"] });

  // Scope folds into ids/unit; the rest of the selector is preserved (AND).
  assert.deepEqual(scoped.filter?.ids, ["t1", "t2"]);
  assert.deepEqual(scoped.filter?.unit, ["u1"]);
  assert.deepEqual(scoped.filter?.status, ["NOT_STARTED"]);
  assert.deepEqual(scoped.filter?.kind, ["function"]);
  assert.deepEqual(scoped.sort, [{ by: "size", dir: "asc" }]);
  assert.equal(scoped.limit, 5);

  // The input selector is untouched.
  assert.equal(selector.filter?.ids, undefined);
  assert.equal(selector.filter?.unit, undefined);
});

test("applyScope intersects an existing ids/unit filter (AND, not union)", async () => {
  const selector: Selector = {
    filter: { ids: ["a", "b"], unit: ["u1", "u2"], status: ["ACTIVE"] },
  };
  const scoped = applyScope(selector, { targetIds: ["b", "c"], unitIds: ["u2", "u3"] });

  assert.deepEqual(scoped.filter?.ids, ["b"]); // {a,b} ∩ {b,c}
  assert.deepEqual(scoped.filter?.unit, ["u2"]); // {u1,u2} ∩ {u2,u3}
  assert.deepEqual(scoped.filter?.status, ["ACTIVE"]);
});

test("applyScope without a scope returns the selector unchanged", () => {
  const selector: Selector = { filter: { kind: ["function"] }, limit: 3 };
  const result = applyScope(selector);
  assert.deepEqual(result, selector);
  assert.equal(result.filter?.ids, undefined);
});

test("scopeToSelector folds a scope for persistence", () => {
  assert.deepEqual(scopeToSelector({ targetIds: ["t1"], unitIds: ["u1"] }), {
    filter: { ids: ["t1"], unit: ["u1"] },
  });
  assert.deepEqual(scopeToSelector({ targetIds: ["t1"] }), { filter: { ids: ["t1"] } });
  assert.deepEqual(scopeToSelector({ unitIds: ["u1"] }), { filter: { unit: ["u1"] } });
  // Empty scopes are dropped.
  assert.deepEqual(scopeToSelector({}), { filter: {} });
  assert.deepEqual(scopeToSelector({ targetIds: [], unitIds: [] }), { filter: {} });
});

test("validateSelector accepts filter.ids and rejects malformed values", () => {
  assert.deepEqual(validateSelector({ filter: { ids: ["t1", "t2"] } }), {
    filter: { ids: ["t1", "t2"] },
  });
  assert.throws(() => validateSelector({ filter: { ids: "t1" } }), /filter\.ids must be an array of strings/);
  assert.throws(() => validateSelector({ filter: { ids: [1] } }), /filter\.ids/);
});

test("compileSelector emits WHERE id IN (...) for filter.ids", () => {
  const { sql, params } = compileSelector({ filter: { ids: ["t1", "t3"], kind: ["function"] } });
  assert.match(sql, /WHERE kind IN \(\?\) AND id IN \(\?, \?\)/);
  assert.deepEqual(params, ["function", "t1", "t3"]);
});

test("select() with filter.ids returns only the allowed target ids (AND with kind)", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);
    const INSERT = `
      INSERT INTO work_items (id, kind, unit_id, lifecycle, status, meta, updated_at)
      VALUES (?, ?, ?, ?, ?, '{}', '2025-01-01T00:00:00.000Z')
    `;
    await db.execute(INSERT, ["t1", "function", "u1", "pending", "NOT_STARTED"]);
    await db.execute(INSERT, ["t2", "function", "u1", "pending", "NOT_STARTED"]);
    await db.execute(INSERT, ["t3", "object", "u1", "pending", "NOT_STARTED"]);

    const rows = await select(db, { filter: { ids: ["t1", "t3"], kind: ["function"] } });
    assert.deepEqual(rows.map((r) => r["id"]), ["t1"]); // t3 excluded by kind (AND)

    const scoped = await select(db, applyScope({ filter: { kind: ["function"] } }, { targetIds: ["t2", "t3"] }));
    assert.deepEqual(scoped.map((r) => r["id"]), ["t2"]);

    // Unit scope intersects via filter.unit.
    const byUnit = await select(db, applyScope({}, { unitIds: ["u1"] }));
    assert.deepEqual(new Set(byUnit.map((r) => r["id"])), new Set(["t1", "t2", "t3"]));
  } finally {
    db.close();
  }
});

test("scopeToSelector output is a valid selector that compiles", () => {
  const selector = scopeToSelector({ targetIds: ["t1", "t2"], unitIds: ["u1"] });
  const compiled = compileSelector(selector);
  assert.match(compiled.sql, /WHERE id IN \(\?, \?\) AND unit_id IN \(\?\)/);
  assert.deepEqual(compiled.params, ["t1", "t2", "u1"]);
});
