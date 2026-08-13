/**
 * M2 dep/capability store + registry snapshot tests (SPEC §6.2, §6.3):
 * `DepsStore` add/list/remove round-trips, and export → import round-tripping
 * work items + deps + capabilities faithfully with ids preserved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { FixtureAdapter } from "../src/adapter/fixture.js";
import { DepsStore } from "../src/target/deps.js";
import { WorkItemRepo } from "../src/target/work-item.js";
import { main } from "../src/cli/index.js";
import {
  exportRegistry,
  importRegistry,
  validateRegistrySnapshot,
  type RegistrySnapshot,
} from "../src/target/registry.js";

/** Fresh migrated `:memory:` adapter with three work items inserted. */
async function openSeeded(): Promise<{ adapter: SqliteAdapter; deps: DepsStore }> {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.migrate([]);
  await new FixtureAdapter([
    {
      id: "wi_a",
      kind: "function",
      lifecycle: "pending",
      status: "NOT_STARTED",
      unitId: "kyoshin/CGame",
      symbol: "fn_a",
      size: 64,
      meta: { callgraph: ["fn_b"] },
    },
    {
      id: "wi_b",
      kind: "function",
      lifecycle: "pending",
      status: "NOT_STARTED",
      unitId: "kyoshin/CGame",
      symbol: "fn_b",
      size: 128,
    },
    {
      id: "wi_c",
      kind: "function",
      lifecycle: "accepted",
      status: "FULL_MATCH",
      unitId: "kyoshin/CChar",
      symbol: "fn_c",
      size: 256,
      attempts: 3,
      exhausted: true,
      ready: true,
    },
  ]).importWorkItems({ store: adapter });
  return { adapter, deps: new DepsStore(adapter) };
}

test("DepsStore: add / list / remove dep round-trip", async () => {
  const { adapter, deps } = await openSeeded();
  try {
    // addDep inserts and is idempotent (PK (from_id, to_id, kind)).
    assert.equal(await deps.addDep("wi_a", "wi_b", "depends_on"), true);
    assert.equal(await deps.addDep("wi_a", "wi_b", "depends_on"), false);
    assert.equal(await deps.addDep("wi_a", "wi_c", "calls"), true);
    assert.equal(await deps.addDep("wi_b", "wi_c", "unresolved_calls"), true);
    assert.equal(await deps.addDep("wi_c", "wi_a", "abi_helper"), true);

    // The same (from, to) pair can coexist under different kinds.
    assert.equal(await deps.addDep("wi_a", "wi_b", "calls"), true);

    assert.deepEqual(await deps.listDeps("wi_a"), [
      { fromId: "wi_a", toId: "wi_b", kind: "calls" },
      { fromId: "wi_a", toId: "wi_b", kind: "depends_on" },
      { fromId: "wi_a", toId: "wi_c", kind: "calls" },
    ]);
    assert.deepEqual(await deps.listDeps("wi_b"), [
      { fromId: "wi_b", toId: "wi_c", kind: "unresolved_calls" },
    ]);

    // listDependents sees the same edges from the other side.
    assert.deepEqual(await deps.listDependents("wi_c"), [
      { fromId: "wi_a", toId: "wi_c", kind: "calls" },
      { fromId: "wi_b", toId: "wi_c", kind: "unresolved_calls" },
    ]);
    assert.deepEqual(await deps.listDependents("wi_b"), [
      { fromId: "wi_a", toId: "wi_b", kind: "calls" },
      { fromId: "wi_a", toId: "wi_b", kind: "depends_on" },
    ]);

    // removeDep deletes exactly one edge and reports the row count.
    assert.equal(await deps.removeDep("wi_a", "wi_b", "depends_on"), 1);
    assert.equal(await deps.removeDep("wi_a", "wi_b", "depends_on"), 0);
    assert.deepEqual(await deps.listDeps("wi_a"), [
      { fromId: "wi_a", toId: "wi_b", kind: "calls" },
      { fromId: "wi_a", toId: "wi_c", kind: "calls" },
    ]);
  } finally {
    adapter.close();
  }
});

test("DepsStore: capabilities add / list round-trip", async () => {
  const { adapter, deps } = await openSeeded();
  try {
    assert.equal(await deps.addCapability("wi_a", "multiplayer"), true);
    assert.equal(await deps.addCapability("wi_a", "multiplayer"), false); // idempotent
    assert.equal(await deps.addCapability("wi_a", "async"), true);
    assert.equal(await deps.addCapability("wi_b", "solo"), true);

    assert.deepEqual(await deps.listCapabilities("wi_a"), ["async", "multiplayer"]);
    assert.deepEqual(await deps.listCapabilities("wi_b"), ["solo"]);
    assert.deepEqual(await deps.listCapabilities("wi_c"), []);

    // Capabilities are per-work-item pairs: wi_b gets its own independent set.
    assert.equal(await deps.addCapability("wi_b", "async"), true);
    assert.deepEqual(await deps.listCapabilities("wi_b"), ["async", "solo"]);
  } finally {
    adapter.close();
  }
});

test("export → import round-trips work items, deps and capabilities faithfully (ids preserved)", async () => {
  const source = await openSeeded();
  const { adapter, deps } = source;
  try {
    await deps.addDep("wi_a", "wi_b", "depends_on");
    await deps.addDep("wi_a", "wi_c", "calls");
    await deps.addDep("wi_b", "wi_c", "unresolved_calls");
    await deps.addCapability("wi_a", "multiplayer");
    await deps.addCapability("wi_b", "async");

    const snapshot = await exportRegistry(adapter);

    // Snapshot shape: one object, three keys.
    assert.deepEqual(Object.keys(snapshot).sort(), ["capabilities", "deps", "workItems"]);
    assert.deepEqual(
      snapshot.workItems.map((item) => item.id),
      ["wi_a", "wi_b", "wi_c"],
    );
    assert.deepEqual(snapshot.deps, [
      { fromId: "wi_a", toId: "wi_b", kind: "depends_on" },
      { fromId: "wi_a", toId: "wi_c", kind: "calls" },
      { fromId: "wi_b", toId: "wi_c", kind: "unresolved_calls" },
    ]);
    assert.deepEqual(snapshot.capabilities, [
      { workItemId: "wi_a", capability: "multiplayer" },
      { workItemId: "wi_b", capability: "async" },
    ]);

    // Restore into a fresh database.
    const target = new SqliteAdapter(":memory:");
    try {
      await target.migrate([]);
      const result = await importRegistry(target, snapshot);
      assert.equal(result.inserted, 3);

      // Round-trip is byte-faithful: re-exporting the target equals the source snapshot.
      assert.deepEqual(await exportRegistry(target), snapshot);

      // Ids are preserved verbatim (the join key for deps — SPEC §6.4)…
      const repo = new WorkItemRepo(target);
      const restored = await repo.get("wi_a");
      assert.equal(restored?.symbol, "fn_a");
      assert.equal(restored?.meta?.callgraph?.[0], "fn_b");
      assert.equal(restored?.attempts, 0);
      assert.equal(restored?.exhausted, false);
      const wiC = await repo.get("wi_c");
      assert.equal(wiC?.lifecycle, "accepted");
      assert.equal(wiC?.status, "FULL_MATCH");
      assert.equal(wiC?.attempts, 3);
      assert.equal(wiC?.exhausted, true);
      assert.equal(wiC?.ready, true);

      // …and the restored edges reference exactly those ids.
      const targetDeps = new DepsStore(target);
      assert.deepEqual(await targetDeps.listDeps("wi_a"), [
        { fromId: "wi_a", toId: "wi_b", kind: "depends_on" },
        { fromId: "wi_a", toId: "wi_c", kind: "calls" },
      ]);
      assert.deepEqual(await targetDeps.listCapabilities("wi_a"), ["multiplayer"]);
      assert.deepEqual(await targetDeps.listCapabilities("wi_b"), ["async"]);
    } finally {
      target.close();
    }
  } finally {
    adapter.close();
  }
});

test("importRegistry is atomic: a duplicate id rolls the whole restore back", async () => {
  const { adapter } = await openSeeded();
  try {
    const snapshot: RegistrySnapshot = {
      workItems: [
        {
          id: "wi_a",
          kind: "function",
          lifecycle: "pending",
          status: "NOT_STARTED",
          attempts: 0,
          exhausted: false,
          ready: false,
          meta: {},
        },
        {
          id: "wi_a", // duplicate id → PK conflict mid-restore
          kind: "function",
          lifecycle: "pending",
          status: "NOT_STARTED",
          attempts: 0,
          exhausted: false,
          ready: false,
          meta: {},
        },
      ],
      deps: [{ fromId: "wi_a", toId: "wi_a", kind: "calls" }],
      capabilities: [{ workItemId: "wi_a", capability: "multiplayer" }],
    };
    await assert.rejects(
      importRegistry(adapter, snapshot),
      (err: unknown) => adapter.isUniqueViolation(err),
    );
    // The duplicate's deps/capabilities must not have been persisted either.
    const rows = await adapter.query<{ n: number }>("SELECT COUNT(*) AS n FROM work_items");
    assert.equal(Number(rows[0]?.n), 3, "no partial import may be persisted");
    const depRows = await adapter.query<{ n: number }>("SELECT COUNT(*) AS n FROM work_item_deps");
    assert.equal(Number(depRows[0]?.n), 0);
    const capRows = await adapter.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM work_item_capabilities",
    );
    assert.equal(Number(capRows[0]?.n), 0);
  } finally {
    adapter.close();
  }
});

test("validateRegistrySnapshot rejects malformed snapshots with clear errors", () => {
  const valid: RegistrySnapshot = {
    workItems: [
      {
        id: "wi_1",
        kind: "function",
        lifecycle: "pending",
        status: "NOT_STARTED",
        attempts: 0,
        exhausted: false,
        ready: false,
        meta: {},
      },
    ],
    deps: [{ fromId: "wi_1", toId: "wi_1", kind: "depends_on" }],
    capabilities: [{ workItemId: "wi_1", capability: "multiplayer" }],
  };
  // Normalizes to the full WorkItem shape (explicit undefined optional keys).
  const validated = validateRegistrySnapshot(valid);
  assert.equal(validated.workItems.length, 1);
  const wi = validated.workItems[0]!;
  assert.equal(wi.id, "wi_1");
  assert.equal(wi.kind, "function");
  assert.equal(wi.lifecycle, "pending");
  assert.equal(wi.status, "NOT_STARTED");
  assert.equal(wi.attempts, 0);
  assert.equal(wi.exhausted, false);
  assert.equal(wi.ready, false);
  assert.deepEqual(wi.meta, {});
  assert.equal(wi.unitId, undefined);
  assert.equal(wi.symbol, undefined);
  assert.equal(wi.size, undefined);
  assert.deepEqual(validated.deps, valid.deps);
  assert.deepEqual(validated.capabilities, valid.capabilities);
  assert.deepEqual(validateRegistrySnapshot(JSON.parse(JSON.stringify(valid))), validated);

  // Lenient defaults mirror the fixture adapter (absent lifecycle/attempts/…).
  const lenient = validateRegistrySnapshot({
    workItems: [{ id: "wi_1", kind: "function", status: "NOT_STARTED" }],
    deps: [],
    capabilities: [],
  });
  assert.equal(lenient.workItems[0]?.lifecycle, "pending");
  assert.equal(lenient.workItems[0]?.attempts, 0);
  assert.equal(lenient.workItems[0]?.exhausted, false);
  assert.equal(lenient.workItems[0]?.ready, false);
  assert.deepEqual(lenient.workItems[0]?.meta, {});

  assert.throws(() => validateRegistrySnapshot(null), /expected an object/);
  assert.throws(() => validateRegistrySnapshot({}), /workItems must be an array/);
  assert.throws(
    () => validateRegistrySnapshot({ workItems: [], deps: [{}], capabilities: [] }),
    /deps\[0\]\.fromId must be a non-empty string/,
  );
  assert.throws(
    () =>
      validateRegistrySnapshot({
        workItems: [],
        deps: [{ fromId: "a", toId: "b", kind: "bogus" }],
        capabilities: [],
      }),
    /deps\[0\]\.kind must be one of depends_on\|calls\|unresolved_calls\|abi_helper/,
  );
  assert.throws(
    () =>
      validateRegistrySnapshot({
        workItems: [{ id: "w", kind: "function", status: "NOT_STARTED", attempts: "3" }],
        deps: [],
        capabilities: [],
      }),
    /attempts must be a number/,
  );
  assert.throws(
    () =>
      validateRegistrySnapshot({
        workItems: [],
        deps: [],
        capabilities: [{ workItemId: "w", capability: "" }],
      }),
    /capabilities\[0\]\.capability must be a non-empty string/,
  );
});

test("importRegistry rejects dangling dep/capability references", async () => {
  const { adapter } = await openSeeded();
  try {
    const item = {
      id: "wi_a",
      kind: "function",
      lifecycle: "pending",
      status: "NOT_STARTED",
      attempts: 0,
      exhausted: false,
      ready: false,
      meta: {},
    };

    // A dep pointing at an item that is not part of the snapshot is a
    // dangling edge: rejected before anything is written.
    await assert.rejects(
      importRegistry(adapter, {
        workItems: [item],
        deps: [{ fromId: "wi_a", toId: "wi_ghost", kind: "depends_on" }],
        capabilities: [],
      }),
      /deps\[0\]\.toId references unknown work item "wi_ghost"/,
    );
    await assert.rejects(
      importRegistry(adapter, {
        workItems: [],
        deps: [{ fromId: "wi_ghost", toId: "wi_ghost", kind: "calls" }],
        capabilities: [],
      }),
      /deps\[0\]\.fromId references unknown work item "wi_ghost"/,
    );
    // Same rule for capabilities.
    await assert.rejects(
      importRegistry(adapter, {
        workItems: [item],
        deps: [],
        capabilities: [{ workItemId: "wi_ghost", capability: "multiplayer" }],
      }),
      /capabilities\[0\]\.workItemId references unknown work item "wi_ghost"/,
    );

    // The rejections are validation errors, not partial writes: the seeded
    // registry is untouched.
    const rows = await adapter.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM work_items",
    );
    assert.equal(Number(rows[0]?.n), 3);
    const depRows = await adapter.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM work_item_deps",
    );
    assert.equal(Number(depRows[0]?.n), 0);
  } finally {
    adapter.close();
  }
});

test("validateRegistrySnapshot rejects out-of-vocab lifecycles (SPEC §8)", () => {
  assert.throws(
    () =>
      validateRegistrySnapshot({
        workItems: [
          {
            id: "w",
            kind: "function",
            lifecycle: "BACKLOG",
            status: "NOT_STARTED",
          },
        ],
        deps: [],
        capabilities: [],
      }),
    /workItems\[0\]\.lifecycle must be one of pending\|claimed\|active\|verified\|accepted\|rejected\|revalidation_required\|blocked\|not_required/,
  );
  // Every member of the core vocab is accepted.
  const snapshots = [
    "pending",
    "claimed",
    "active",
    "verified",
    "accepted",
    "rejected",
    "revalidation_required",
    "blocked",
    "not_required",
  ].map((lifecycle) => ({
    workItems: [{ id: "w", kind: "function", lifecycle, status: "NOT_STARTED" }],
    deps: [],
    capabilities: [],
  }));
  for (const snapshot of snapshots) {
    assert.equal(validateRegistrySnapshot(snapshot).workItems[0]!.lifecycle, snapshot.workItems[0]!.lifecycle);
  }
});

test("CLI: export registry --out and import round-trip through main()", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-deps-cli-"));
  try {
    const snapshotPath = join(dir, "snapshot.json");
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        workItems: [
          {
            id: "wi_a",
            kind: "function",
            lifecycle: "pending",
            status: "NOT_STARTED",
            unitId: "kyoshin/CGame",
            symbol: "fn_a",
            size: 64,
            attempts: 0,
            exhausted: false,
            ready: false,
            meta: { callgraph: ["fn_b"] },
          },
          {
            id: "wi_b",
            kind: "function",
            lifecycle: "pending",
            status: "NOT_STARTED",
            unitId: "kyoshin/CGame",
            attempts: 0,
            exhausted: false,
            ready: false,
            meta: {},
          },
        ],
        deps: [
          { fromId: "wi_a", toId: "wi_b", kind: "depends_on" },
          { fromId: "wi_a", toId: "wi_b", kind: "calls" },
        ],
        capabilities: [{ workItemId: "wi_a", capability: "multiplayer" }],
      }),
    );

    const chunks: string[] = [];
    const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
    const original = stdout.write.bind(process.stdout);
    stdout.write = (chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      const dbA = join(dir, "a.db");
      const dbB = join(dir, "b.db");
      const exported = join(dir, "exported.json");
      const reexported = join(dir, "reexported.json");
      await main(["import", snapshotPath, "--db", dbA]);
      await main(["export", "registry", "--db", dbA, "--out", exported]);
      // Export to stdout (default) is the same document as --out.
      await main(["export", "registry", "--db", dbA]);
      // Import the exported snapshot into a fresh db and re-export.
      await main(["import", exported, "--db", dbB]);
      await main(["export", "registry", "--db", dbB, "--out", reexported]);

      assert.match(chunks.join(""), /imported 2 work items/);
      // Deterministic ordering makes the two exports byte-identical.
      assert.equal(readFileSync(reexported, "utf8"), readFileSync(exported, "utf8"));
      // The stdout export (default when no --out) is the same document.
      const stdoutDoc = chunks.find((chunk) => {
        try {
          return JSON.parse(chunk) !== null && typeof JSON.parse(chunk) === "object";
        } catch {
          return false;
        }
      });
      assert.ok(stdoutDoc !== undefined, "expected an export JSON chunk on stdout");
      assert.equal(stdoutDoc.trim(), readFileSync(exported, "utf8").trim());
    } finally {
      stdout.write = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
