/**
 * Store tests (SPEC §6.1, §6.2): migrations, insert/query, transaction,
 * insertIgnore, isUniqueViolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import type { Migration } from "../src/core/store/adapter.js";

const WORK_ITEM = {
  id: "wi_0001",
  kind: "function",
  unitId: "kyoshin/CGame",
  lifecycle: "pending",
  status: "NOT_STARTED",
  size: 128,
  attempts: 0,
  exhausted: false,
  ready: false,
  meta: { callgraph: ["fn_0001"] },
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const INSERT_WORK_ITEM_SQL = `
  INSERT INTO work_items
    (id, kind, unit_id, lifecycle, status, size, attempts, exhausted, ready, meta, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function workItemParams(id: string): unknown[] {
  return [
    id,
    WORK_ITEM.kind,
    WORK_ITEM.unitId,
    WORK_ITEM.lifecycle,
    WORK_ITEM.status,
    WORK_ITEM.size,
    WORK_ITEM.attempts,
    WORK_ITEM.exhausted ? 1 : 0,
    WORK_ITEM.ready ? 1 : 0,
    JSON.stringify(WORK_ITEM.meta),
    WORK_ITEM.updatedAt,
  ];
}

test("migrate applies the canonical schema (all tables and indexes)", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);

    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const tableNames = tables.map((t) => t.name);
    for (const expected of [
      "schema_migrations",
      "work_items",
      "units",
      "work_item_deps",
      "work_item_capabilities",
      "claims",
      "runs",
      "run_workers",
      "run_worker_items",
      "events",
      "counters",
      "spans",
      "models",
      "auth_tokens",
      "style_guides",
      "prompts",
      "artifacts",
      "drafts",
      "proposals",
      "audit_log",
    ]) {
      assert.ok(tableNames.includes(expected), `missing table ${expected}`);
    }

    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const indexNames = indexes.map((i) => i.name);
    for (const expected of [
      "idx_work_items_unit",
      "idx_work_items_status",
      "idx_work_items_lifecycle",
      "idx_work_items_region",
      "idx_work_items_kind",
      "idx_work_items_size",
      "idx_work_items_ready",
      "idx_work_items_symbol",
      "idx_work_items_updated_at",
      "idx_deps_to",
      "idx_claims_owner",
      "idx_claims_run",
      "idx_claims_expires",
      "idx_events_run",
      "idx_events_type",
      "idx_events_work",
      "idx_spans_run",
      "idx_spans_prompt",
      "idx_artifacts_run",
      "idx_drafts_work",
    ]) {
      assert.ok(indexNames.includes(expected), `missing index ${expected}`);
    }

    // The base schema application is tracked as version 0.
    const versions = await db.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((v) => v.version), [0]);
  } finally {
    db.close();
  }
});

test("insert + query a work_item row", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams(WORK_ITEM.id));

    const rows = await db.query<{
      id: string;
      kind: string;
      unit_id: string;
      lifecycle: string;
      status: string;
      size: number;
      ready: number;
      meta: string;
    }>(
      "SELECT id, kind, unit_id, lifecycle, status, size, ready, meta FROM work_items WHERE id = ?",
      [WORK_ITEM.id],
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.id, WORK_ITEM.id);
    assert.equal(row.kind, "function");
    assert.equal(row.unit_id, "kyoshin/CGame");
    assert.equal(row.lifecycle, "pending");
    assert.equal(row.status, "NOT_STARTED");
    assert.equal(row.size, 128);
    assert.equal(row.ready, 0);
    assert.deepEqual(JSON.parse(row.meta), WORK_ITEM.meta);

    const none = await db.query<{ id: string }>(
      "SELECT id FROM work_items WHERE id = ?",
      ["wi_missing"],
    );
    assert.equal(none.length, 0);
  } finally {
    db.close();
  }
});

test("transaction commits on success and rolls back on error", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams(WORK_ITEM.id));

    const result = await db.transaction(async (tx) => {
      await tx.execute("UPDATE work_items SET status = ? WHERE id = ?", [
        "FULL_MATCH",
        WORK_ITEM.id,
      ]);
      const rows = await tx.query<{ status: string }>(
        "SELECT status FROM work_items WHERE id = ?",
        [WORK_ITEM.id],
      );
      return rows[0]?.status;
    });
    assert.equal(result, "FULL_MATCH");

    const committed = await db.query<{ status: string }>(
      "SELECT status FROM work_items WHERE id = ?",
      [WORK_ITEM.id],
    );
    assert.equal(committed[0]?.status, "FULL_MATCH");

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute("UPDATE work_items SET status = ? WHERE id = ?", [
          "REJECTED",
          WORK_ITEM.id,
        ]);
        throw new Error("boom");
      }),
      /boom/,
    );

    const afterRollback = await db.query<{ status: string }>(
      "SELECT status FROM work_items WHERE id = ?",
      [WORK_ITEM.id],
    );
    assert.equal(afterRollback[0]?.status, "FULL_MATCH");
  } finally {
    db.close();
  }
});

test("nested transaction joins the outer transaction", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams(WORK_ITEM.id));

    await db.transaction(async (outer) => {
      await outer.execute("UPDATE work_items SET status = ? WHERE id = ?", [
        "ACTIVE",
        WORK_ITEM.id,
      ]);
      const inner = await outer.transaction(async (tx) => {
        await tx.execute("UPDATE work_items SET status = ? WHERE id = ?", [
          "VERIFIED",
          WORK_ITEM.id,
        ]);
        return "ok";
      });
      assert.equal(inner, "ok");
    });

    const rows = await db.query<{ status: string }>(
      "SELECT status FROM work_items WHERE id = ?",
      [WORK_ITEM.id],
    );
    assert.equal(rows[0]?.status, "VERIFIED");
  } finally {
    db.close();
  }
});

test("nested transaction rollback is isolated from the outer transaction", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams(WORK_ITEM.id));

    await db.transaction(async (outer) => {
      await outer.execute("UPDATE work_items SET status = ? WHERE id = ?", [
        "OUTER_SET",
        WORK_ITEM.id,
      ]);
      // Inner failure must only undo the inner region (ROLLBACK TO sp_1).
      await assert.rejects(
        outer.transaction(async (inner) => {
          await inner.execute("UPDATE work_items SET status = ? WHERE id = ?", [
            "INNER_SET",
            WORK_ITEM.id,
          ]);
          throw new Error("inner boom");
        }),
        /inner boom/,
      );
      const status = await outer.query<{ status: string }>(
        "SELECT status FROM work_items WHERE id = ?",
        [WORK_ITEM.id],
      );
      assert.equal(status[0]?.status, "OUTER_SET"); // outer write survives
    });

    const rows = await db.query<{ status: string }>(
      "SELECT status FROM work_items WHERE id = ?",
      [WORK_ITEM.id],
    );
    assert.equal(rows[0]?.status, "OUTER_SET");
  } finally {
    db.close();
  }
});

test("concurrent transactions are serialized: one rollback cannot wipe another's commit", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams("wi_t1"));
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams("wi_t2"));

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const t1 = db.transaction(async (tx) => {
      await tx.execute("UPDATE work_items SET status = ? WHERE id = ?", [
        "T1_PENDING",
        "wi_t1",
      ]);
      await delay(20); // overlap window: t2 starts while t1 is in flight
      throw new Error("t1 rollback");
    });
    const t2 = db.transaction(async (tx) => {
      await delay(5);
      await tx.execute("UPDATE work_items SET status = ? WHERE id = ?", [
        "T2_COMMITTED",
        "wi_t2",
      ]);
      return "committed";
    });
    // Attach a handler to t1 immediately so its (expected) rejection is never
    // an unhandled rejection while we await t2.
    const t1Outcome = t1.then(
      () => null,
      (err: unknown) => err,
    );

    assert.equal(await t2, "committed");
    const t1Error = await t1Outcome;
    assert.ok(t1Error instanceof Error);
    assert.match(t1Error.message, /t1 rollback/);

    const rows = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM work_items ORDER BY id",
    );
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    // t1's rollback undoes only its own work…
    assert.equal(byId.get("wi_t1"), "NOT_STARTED");
    // …and never the work of the concurrently-started transaction.
    assert.equal(byId.get("wi_t2"), "T2_COMMITTED");
  } finally {
    db.close();
  }
});

test("execute with no params runs DML through a prepared statement (real changes)", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams("wi_0001"));
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams("wi_0002"));
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams("wi_0003"));

    // Param-less single-statement DML reports the real change count.
    const result = await db.execute("UPDATE work_items SET status = 'FULL_MATCH'");
    assert.equal(result.changes, 3);

    // Param-less multi-statement DDL still routes through exec() (prepared
    // statements would silently drop every statement after the first).
    await db.execute("CREATE TABLE extra1 (x INTEGER); CREATE TABLE extra2 (x INTEGER);");
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name IN ('extra1', 'extra2') ORDER BY name",
    );
    assert.deepEqual(
      tables.map((t) => t.name),
      ["extra1", "extra2"],
    );
  } finally {
    db.close();
  }
});

test("insertIgnore returns true on first insert and false on conflict", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);

    const first = await db.insertIgnore(INSERT_WORK_ITEM_SQL, workItemParams(WORK_ITEM.id));
    assert.equal(first, true);

    // Second identical insert → false (PK conflict).
    const second = await db.insertIgnore(INSERT_WORK_ITEM_SQL, workItemParams(WORK_ITEM.id));
    assert.equal(second, false);

    // A different id still inserts.
    const other = await db.insertIgnore(INSERT_WORK_ITEM_SQL, workItemParams("wi_0002"));
    assert.equal(other, true);

    const count = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM work_items");
    assert.equal(Number(count[0]?.n), 2);
  } finally {
    db.close();
  }
});

test("file-backed adapters enable WAL + busy_timeout; :memory: skips them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-pragma-"));
  const file = join(dir, "store.db");
  try {
    // File-backed: cross-process claim CAS (SPEC §6.3) must block-and-retry
    // (busy_timeout) instead of throwing SQLITE_BUSY, which needs WAL too.
    const fileDb = new SqliteAdapter(file);
    await fileDb.migrate([]);
    const filePragmas = await fileDb.query<{ journal_mode: string }>(
      "PRAGMA journal_mode",
    );
    assert.equal(filePragmas[0]!.journal_mode, "wal");
    const busy = await fileDb.query<{ timeout: number }>("PRAGMA busy_timeout");
    assert.equal(Number(busy[0]!.timeout), 5000);
    fileDb.close();

    // In-memory: pragmas are skipped (no cross-process contention possible).
    const memDb = new SqliteAdapter(":memory:");
    await memDb.migrate([]);
    const memPragmas = await memDb.query<{ journal_mode: string }>("PRAGMA journal_mode");
    assert.equal(memPragmas[0]!.journal_mode, "memory");
    memDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isUniqueViolation classifies PK/UNIQUE errors and rejects others", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.migrate([]);
    await db.execute(INSERT_WORK_ITEM_SQL, workItemParams(WORK_ITEM.id));

    // Duplicate PK via plain execute throws a unique violation.
    await assert.rejects(
      db.execute(INSERT_WORK_ITEM_SQL, workItemParams(WORK_ITEM.id)),
      (err: unknown) => db.isUniqueViolation(err),
    );

    // Duplicate UNIQUE column (units.name).
    await db.execute("INSERT INTO units (id, name) VALUES (?, ?)", ["u1", "UnitA"]);
    await assert.rejects(
      db.execute("INSERT INTO units (id, name) VALUES (?, ?)", ["u2", "UnitA"]),
      (err: unknown) => db.isUniqueViolation(err),
    );

    // NOT NULL violation is not a unique violation.
    await assert.rejects(
      db.execute("INSERT INTO units (id) VALUES (?)", ["u3"]),
      (err: unknown) => !db.isUniqueViolation(err),
    );

    assert.equal(db.isUniqueViolation(new Error("boom")), false);
    assert.equal(db.isUniqueViolation("not an error"), false);
    assert.equal(db.isUniqueViolation(null), false);
  } finally {
    db.close();
  }
});

test("migrations run in ascending order, are tracked, and are idempotent", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    const order: number[] = [];
    const migrations: Migration[] = [
      {
        version: 2,
        up: async (tx) => {
          order.push(2);
          await tx.execute("CREATE TABLE m2 (v INTEGER)");
        },
      },
      {
        version: 1,
        up: async (tx) => {
          order.push(1);
          await tx.execute("CREATE TABLE m1 (v INTEGER)");
        },
      },
    ];

    await db.migrate(migrations);
    assert.deepEqual(order, [1, 2]); // ascending regardless of input order

    let versions = await db.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((v) => v.version), [0, 1, 2]);

    // Re-running is a no-op (idempotent).
    await db.migrate(migrations);
    versions = await db.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((v) => v.version), [0, 1, 2]);

    // A failing migration records nothing (transaction rollback).
    await assert.rejects(
      db.migrate([{ version: 3, up: async () => { throw new Error("migration failed"); } }]),
      /migration failed/,
    );
    versions = await db.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((v) => v.version), [0, 1, 2]);

    // After fixing, version 3 applies cleanly.
    await db.migrate([{ version: 3, up: async (tx) => { await tx.execute("CREATE TABLE m3 (v INTEGER)"); } }]);
    versions = await db.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((v) => v.version), [0, 1, 2, 3]);
  } finally {
    db.close();
  }
});
