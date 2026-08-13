/**
 * M0 tests for `src/target/selector.ts` and `src/target/work-item.ts`.
 *
 * The `SqlAdapter` implementation here is a minimal in-memory SQLite adapter
 * (`node:sqlite` DatabaseSync) owned by this test file — the production
 * SQLite engine lives in `src/core/store/` (separate agent). The table DDL
 * mirrors the canonical `work_items` shape from SPEC §6.2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Migration, SqlAdapter } from "../src/core/store/adapter.js";
import type { Selector, WorkItem } from "../src/types.js";
import {
  OVER_FETCH_FACTOR,
  applyMetaFilters,
  compileSelector,
  select,
  validateSelector,
} from "../src/target/selector.js";
import { WorkItemRepo } from "../src/target/work-item.js";

type SqlValue = null | number | bigint | string | Uint8Array;

class MemorySqlAdapter implements SqlAdapter {
  readonly db = new DatabaseSync(":memory:");
  /** Every SQL statement executed, in order (used to assert over-fetch/pagination). */
  readonly queryLog: string[] = [];

  constructor() {
    this.db.exec(`
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        unit_id TEXT,
        lifecycle TEXT NOT NULL,
        status TEXT NOT NULL,
        region TEXT,
        symbol TEXT,
        address TEXT,
        milestone TEXT,
        required_level TEXT,
        size INTEGER,
        source TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        exhausted INTEGER NOT NULL DEFAULT 0,
        ready INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      )
    `);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.queryLog.push(sql);
    return this.db.prepare(sql).all(...(params as SqlValue[])) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    this.queryLog.push(sql);
    const result = this.db.prepare(sql).run(...(params as SqlValue[]));
    return { changes: Number(result.changes) };
  }

  async transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const out = await fn(this);
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async insertIgnore(sql: string, params: unknown[] = []): Promise<boolean> {
    try {
      await this.execute(sql, params);
      return true;
    } catch (err) {
      if (this.isUniqueViolation(err)) return false;
      throw err;
    }
  }

  isUniqueViolation(err: unknown): boolean {
    return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
  }

  async migrate(_migrations: Migration[]): Promise<void> {
    /* DDL is applied eagerly in the constructor for these tests. */
  }
}

function sampleItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    kind: "function",
    unitId: "CGame",
    lifecycle: "pending",
    status: "NOT_STARTED",
    region: "PAL",
    symbol: undefined,
    address: undefined,
    milestone: undefined,
    requiredLevel: undefined,
    size: 10,
    source: undefined,
    attempts: 0,
    exhausted: false,
    ready: false,
    meta: {},
    ...overrides,
  };
}

// ─── compileSelector: SQL + params ───────────────────────────────────────────

test("compileSelector: status filter + sort by size asc + limit", () => {
  const compiled = compileSelector({
    filter: { status: ["FULL_MATCH", "EQUIVALENT_MATCH"] },
    sort: [{ by: "size", dir: "asc" }],
    limit: 50,
  });
  assert.equal(
    compiled.sql,
    "SELECT * FROM work_items WHERE status IN (?, ?) ORDER BY size ASC, id ASC LIMIT ?",
  );
  assert.deepEqual(compiled.params, ["FULL_MATCH", "EQUIVALENT_MATCH", 50]);
  assert.deepEqual(compiled.metaFilters, []);
});

test("compileSelector: meta filter + limit over-fetches (LIMIT × factor)", () => {
  const compiled = compileSelector({
    filter: {
      status: ["FULL_MATCH"],
      meta: [{ key: "notes", op: "contains", value: "candidate" }],
    },
    limit: 10,
  });
  assert.equal(compiled.sql, "SELECT * FROM work_items WHERE status IN (?) ORDER BY id ASC LIMIT ?");
  assert.deepEqual(compiled.params, ["FULL_MATCH", 10 * OVER_FETCH_FACTOR]);
  assert.equal(compiled.metaFilters.length, 1);
  assert.deepEqual(compiled.metaFilters[0], {
    key: "notes",
    op: "contains",
    value: "candidate",
  });
});

test("compileSelector: meta filter without limit does not emit LIMIT", () => {
  const compiled = compileSelector({
    filter: { meta: [{ key: "k", op: "eq", value: 1 }] },
  });
  assert.equal(compiled.sql, "SELECT * FROM work_items");
  assert.deepEqual(compiled.params, []);
  assert.equal(compiled.metaFilters.length, 1);
});

test("compileSelector: every whitelisted sort field compiles", () => {
  const compiled = compileSelector({
    sort: [
      { by: "unit", dir: "desc" },
      { by: "region", dir: "asc" },
      { by: "attempts", dir: "desc" },
      { by: "updated_at", dir: "asc" },
    ],
  });
  assert.equal(
    compiled.sql,
    "SELECT * FROM work_items ORDER BY unit_id DESC, region ASC, attempts DESC, updated_at ASC",
  );
  assert.deepEqual(compiled.params, []);
});

test("compileSelector: range, boolean and equality filters", () => {
  const compiled = compileSelector({
    filter: {
      size: { min: 100, max: 500 },
      attempts: { min: 1 },
      ready: true,
      exhausted: false,
      symbol: "symbol_1",
      unit: ["CGame", "main"],
    },
    sort: [{ by: "attempts", dir: "desc" }],
  });
  assert.equal(
    compiled.sql,
    "SELECT * FROM work_items WHERE unit_id IN (?, ?) AND symbol = ? AND ready = ? AND exhausted = ? AND attempts >= ? AND size >= ? AND size <= ? ORDER BY attempts DESC",
  );
  assert.deepEqual(compiled.params, ["CGame", "main", "symbol_1", 1, 0, 1, 100, 500]);
});

test("compileSelector: rejects non-whitelisted sort fields", () => {
  assert.throws(
    () => compileSelector({ sort: [{ by: "status", dir: "asc" }] }),
    /Invalid sort field: status/,
  );
  assert.throws(
    () => compileSelector({ sort: [{ by: "size", dir: "sideways" }] }),
    /Invalid sort direction/,
  );
});

// ─── validateSelector: shape validation (SPEC §8; adversarial CLI input) ────

test("validateSelector: array filters reject strings and objects", () => {
  assert.throws(
    () => validateSelector({ filter: { status: "FULL_MATCH" } }),
    /filter\.status must be an array of strings/,
  );
  assert.throws(
    () => validateSelector({ filter: { unit: {} } }),
    /filter\.unit must be an array of strings/,
  );
  assert.throws(
    () => validateSelector({ filter: { lifecycle: [1] } }),
    /filter\.lifecycle must be an array of strings/,
  );
  assert.throws(
    () => validateSelector({ filter: { milestone: "m1" } }),
    /filter\.milestone must be an array of strings/,
  );
  assert.deepEqual(validateSelector({ filter: { status: ["FULL_MATCH"] } }), {
    filter: { status: ["FULL_MATCH"] },
  });
});

test("validateSelector: limit must be a positive integer", () => {
  // Negative limits are especially dangerous: SQLite treats them as unlimited.
  assert.throws(() => validateSelector({ limit: -1 }), /limit must be a positive integer/);
  assert.throws(() => validateSelector({ limit: -100 }), /limit must be a positive integer/);
  assert.throws(() => validateSelector({ limit: 0 }), /limit must be a positive integer/);
  assert.throws(() => validateSelector({ limit: 1.5 }), /limit must be a positive integer/);
  assert.throws(() => validateSelector({ limit: Number.NaN }), /limit must be a positive integer/);
  assert.throws(
    () => validateSelector({ limit: JSON.parse("1e999") }),
    /limit must be a positive integer/,
  );
  assert.deepEqual(validateSelector({ limit: 10 }), { limit: 10 });
});

test("validateSelector: sort must use the whitelist and asc|desc", () => {
  assert.throws(
    () => validateSelector({ sort: [{ by: "status", dir: "asc" }] }),
    /Invalid sort field: status/,
  );
  assert.throws(
    () => validateSelector({ sort: [{ by: "size", dir: "sideways" }] }),
    /Invalid sort direction: sideways/,
  );
  assert.deepEqual(
    validateSelector({ sort: [{ by: "size", dir: "asc" }] }),
    { sort: [{ by: "size", dir: "asc" }] },
  );
});

test("validateSelector: meta ops must be eq|neq|in|contains|regex", () => {
  assert.throws(
    () => validateSelector({ filter: { meta: [{ key: "k", op: "bogus", value: 1 }] } }),
    /filter\.meta\[0\]\.op must be one of eq\|neq\|in\|contains\|regex/,
  );
  assert.throws(
    () => validateSelector({ filter: { meta: [{ key: "k", op: 5, value: 1 }] } }),
    /filter\.meta\[0\]\.op/,
  );
  assert.throws(
    () => validateSelector({ filter: { meta: [{ key: "k", op: "contains" }] } }),
    /filter\.meta\[0\]\.value is required/,
  );
  assert.deepEqual(
    validateSelector({ filter: { meta: [{ key: "k", op: "eq", value: 1 }] } }),
    { filter: { meta: [{ key: "k", op: "eq", value: 1 }] } },
  );
});

test("compileSelector never silently filters everything out on a bad meta op", () => {
  assert.throws(
    () => compileSelector({ filter: { meta: [{ key: "k", op: "bogus", value: 1 }] } }),
    /filter\.meta\[0\]\.op/,
  );
});

test("validateSelector: attempts/size range bounds must be numbers", () => {
  assert.throws(
    () => validateSelector({ filter: { attempts: { min: "3" } } }),
    /filter\.attempts\.min must be a number/,
  );
  assert.throws(
    () => validateSelector({ filter: { size: { max: true } } }),
    /filter\.size\.max must be a number/,
  );
  assert.throws(
    () => validateSelector({ filter: { attempts: [1, 2] } }),
    /filter\.attempts must be an object/,
  );
  assert.deepEqual(
    validateSelector({ filter: { size: { min: 1, max: 10 } } }),
    { filter: { size: { min: 1, max: 10 } } },
  );
});

test("compileSelector: empty selector compiles to a bare SELECT", () => {
  const compiled = compileSelector({});
  assert.equal(compiled.sql, "SELECT * FROM work_items");
  assert.deepEqual(compiled.params, []);
  assert.deepEqual(compiled.metaFilters, []);
});

// ─── pagination determinism: `id` tiebreaker (SPEC §8) ──────────────────────

test("compileSelector: paged queries append id as the final sort tiebreaker", () => {
  const withSort = compileSelector({ sort: [{ by: "size", dir: "asc" }], limit: 10 });
  assert.equal(withSort.sql, "SELECT * FROM work_items ORDER BY size ASC, id ASC LIMIT ?");

  const noSort = compileSelector({ limit: 5 });
  assert.equal(noSort.sql, "SELECT * FROM work_items ORDER BY id ASC LIMIT ?");
  assert.deepEqual(noSort.params, [5]);

  // No limit → no tiebreaker injected.
  const noLimit = compileSelector({ sort: [{ by: "size", dir: "asc" }] });
  assert.equal(noLimit.sql, "SELECT * FROM work_items ORDER BY size ASC");
});

// ─── applyMetaFilters: app-side post-filter ──────────────────────────────────

test("applyMetaFilters: contains/eq/neq/in/regex on parsed meta", () => {
  const rows = [
    { id: "a", meta: { notes: "good candidate", level: 3, tags: ["x", "y"] } },
    { id: "b", meta: { notes: "meh", level: 3 } },
    { id: "c", meta: { notes: "good one", level: 5 } },
  ];
  const and = applyMetaFilters(rows, [
    { key: "notes", op: "contains", value: "good" },
    { key: "level", op: "eq", value: 3 },
  ]);
  assert.deepEqual(and.map((r) => r.id), ["a"]);

  const regex = applyMetaFilters(rows, [{ key: "notes", op: "regex", value: "^meh$" }]);
  assert.deepEqual(regex.map((r) => r.id), ["b"]);

  // `in`: the scalar meta value is contained in the provided list.
  const inOp = applyMetaFilters(rows, [{ key: "level", op: "in", value: [5, 9] }]);
  assert.deepEqual(inOp.map((r) => r.id), ["c"]);

  // neq passes when the key is absent ("not equal" semantics).
  const neq = applyMetaFilters(rows, [{ key: "missing", op: "neq", value: 1 }]);
  assert.equal(neq.length, 3);

  // Missing key fails eq/contains/regex.
  assert.equal(applyMetaFilters(rows, [{ key: "missing", op: "eq", value: 1 }]).length, 0);
  assert.equal(applyMetaFilters(rows, [{ key: "missing", op: "contains", value: "x" }]).length, 0);
});

test("applyMetaFilters: tolerates meta as raw TEXT", () => {
  const rows = [{ id: "z", meta: JSON.stringify({ flag: true }) }];
  const kept = applyMetaFilters(rows, [{ key: "flag", op: "eq", value: true }]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.id, "z");
});

// ─── WorkItemRepo against :memory: ───────────────────────────────────────────

test("WorkItemRepo.list: status filter + size asc + limit", async () => {
  const adapter = new MemorySqlAdapter();
  const repo = new WorkItemRepo(adapter);
  for (let i = 1; i <= 6; i++) {
    await repo.insert(
      sampleItem({
        id: `fn_${String(i).padStart(7, "0")}`,
        status: i % 2 === 0 ? "FULL_MATCH" : "NOT_STARTED",
        size: i * 10,
        ready: i > 1,
        meta: { notes: `n${i}` },
      }),
    );
  }

  const items = await repo.list({
    filter: { status: ["FULL_MATCH"] },
    sort: [{ by: "size", dir: "asc" }],
    limit: 2,
  });

  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((x) => x.id),
    ["fn_0000002", "fn_0000004"],
  );
  assert.equal(items[0]?.unitId, "CGame");
  assert.equal(items[0]?.ready, true);
  assert.equal(items[0]?.exhausted, false);
  assert.equal(items[0]?.attempts, 0);
  assert.deepEqual(items[0]?.meta, { notes: "n2" });
  assert.equal(items[0]?.size, 20);
});

test("WorkItemRepo.list: meta post-filter with limit over-fetches and paginates", async () => {
  const adapter = new MemorySqlAdapter();
  const repo = new WorkItemRepo(adapter);
  // 200 rows; meta.batch === "keep" for i ≡ 1 (mod 31): 1, 32, 63, 94, 125, 156, 187.
  for (let i = 1; i <= 200; i++) {
    await repo.insert(
      sampleItem({
        id: `item_${String(i).padStart(3, "0")}`,
        status: "CODE_MATCH",
        size: i,
        meta: { batch: i % 31 === 1 ? "keep" : "drop" },
      }),
    );
  }

  const items = await repo.list({
    filter: { meta: [{ key: "batch", op: "eq", value: "keep" }] },
    sort: [{ by: "size", dir: "asc" }],
    limit: 3,
  });

  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((x) => x.size),
    [1, 32, 63],
  );
  // First SELECT page over-fetches (LIMIT ?), and matches are rarer than 1/10
  // so a continuation page (LIMIT ? OFFSET ?) was required.
  const selects = adapter.queryLog.filter((sql) => sql.startsWith("SELECT"));
  assert.ok(selects.length >= 2);
  assert.match(selects[0] ?? "", /LIMIT \?/);
  assert.ok(selects.some((sql) => /LIMIT \? OFFSET \?/.test(sql)));
});

test("WorkItemRepo.list: meta filter without limit returns all matches", async () => {
  const adapter = new MemorySqlAdapter();
  const repo = new WorkItemRepo(adapter);
  await repo.insert(sampleItem({ id: "a1", status: "FULL_MATCH", meta: { keep: true } }));
  await repo.insert(sampleItem({ id: "a2", status: "FULL_MATCH", meta: { keep: false } }));
  await repo.insert(sampleItem({ id: "a3", status: "NOT_STARTED", meta: { keep: true } }));

  const items = await repo.list({
    filter: {
      status: ["FULL_MATCH"],
      meta: [{ key: "keep", op: "eq", value: true }],
    },
  });
  assert.deepEqual(
    items.map((x) => x.id),
    ["a1"],
  );
});

test("WorkItemRepo.list: paging with duplicate sort keys is deterministic (no drops/dups)", async () => {
  const adapter = new MemorySqlAdapter();
  const repo = new WorkItemRepo(adapter);
  // 300 rows all sharing the same sort key (size); matches are rarer than
  // 1/OVER_FETCH_FACTOR so multiple OFFSET pages are fetched. Without the
  // `id` tiebreaker, OFFSET pages over tied sort keys can drop or duplicate
  // rows.
  for (let i = 1; i <= 300; i++) {
    await repo.insert(
      sampleItem({
        id: `tie_${String(i).padStart(3, "0")}`,
        status: "CODE_MATCH",
        size: 100,
        meta: { batch: i % 51 === 1 ? "keep" : "drop" },
      }),
    );
  }

  const items = await repo.list({
    filter: { meta: [{ key: "batch", op: "eq", value: "keep" }] },
    sort: [{ by: "size", dir: "asc" }],
    limit: 3,
  });

  assert.equal(items.length, 3);
  const ids = items.map((x) => x.id);
  assert.equal(new Set(ids).size, 3, "paged ids must be distinct (no dup/drop)");
  // Deterministic order: sort key ties broken by ascending id.
  assert.deepEqual(ids, ["tie_001", "tie_052", "tie_103"]);
  // Pagination really happened (OFFSET continuation pages were required).
  const selects = adapter.queryLog.filter((sql) => sql.startsWith("SELECT"));
  assert.ok(selects.length >= 2);
  assert.ok(selects.some((sql) => /ORDER BY size ASC, id ASC LIMIT \? OFFSET \?/.test(sql)));
});

test("WorkItemRepo.get and update round-trip", async () => {
  const adapter = new MemorySqlAdapter();
  const repo = new WorkItemRepo(adapter);
  await repo.insert(sampleItem({ id: "x1", kind: "object" }));

  const got = await repo.get("x1");
  assert.ok(got);
  assert.equal(got.kind, "object");
  assert.equal(got.status, "NOT_STARTED");

  const changes = await repo.update("x1", {
    status: "FULL_MATCH",
    attempts: 2,
    exhausted: true,
    size: 42,
    meta: { ok: true },
  });
  assert.equal(changes, 1);

  const after = await repo.get("x1");
  assert.equal(after?.status, "FULL_MATCH");
  assert.equal(after?.attempts, 2);
  assert.equal(after?.exhausted, true);
  assert.equal(after?.size, 42);
  assert.deepEqual(after?.meta, { ok: true });

  // Non-mutating update still bumps updated_at and reports 1 affected row.
  const noop = await repo.update("x1", {});
  assert.equal(noop, 1);

  assert.equal(await repo.get("missing"), undefined);
  assert.equal(await repo.update("missing", { status: "X" }), 0);
});

test("WorkItemRepo.update rejects patching the id (primary key)", async () => {
  const adapter = new MemorySqlAdapter();
  const repo = new WorkItemRepo(adapter);
  await repo.insert(sampleItem({ id: "x1" }));

  await assert.rejects(
    repo.update("x1", { id: "x2" }),
    /cannot update immutable field "id"/,
  );
  // The PK is untouched and the stolen id was never created.
  assert.equal((await repo.get("x1"))?.id, "x1");
  assert.equal(await repo.get("x2"), undefined);
});

test("select returns raw rows with meta as TEXT (parsed downstream)", async () => {
  const adapter = new MemorySqlAdapter();
  const repo = new WorkItemRepo(adapter);
  await repo.insert(sampleItem({ id: "m1", meta: { tags: ["a"] } }));

  const rows = await select(adapter, { filter: { status: ["NOT_STARTED"] } });
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(String(rows[0]?.["meta"])) as unknown, { tags: ["a"] });
});
