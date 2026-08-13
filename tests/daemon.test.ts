/**
 * StoreDaemon tests (SPEC §5, §6.3, §18): single-writer serialization,
 * epoch-guarded leases, on-start orphan sweep, monotonic gap-free event
 * seqs, DB-level lease CAS across two connections over one SQLite file, and
 * registry round-trip through the daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { StoreDaemon } from "../src/core/daemon.js";
import type { WorkItem } from "../src/types.js";

const TS = "2025-05-01T00:00:00.000Z";
const EPOCH_A = "epoch-aaaa-0000-0000-000000000000";
const EPOCH_B = "epoch-bbbb-0000-0000-000000000000";
const EXPIRED = new Date(Date.now() - 60_000).toISOString(); // definitively past
const LIVE = new Date(Date.now() + 60_000).toISOString(); // inside a live lease window

async function insertRun(db: SqliteAdapter, id: string): Promise<void> {
  await db.execute(
    "INSERT INTO runs (id, pipeline, adapter, model, status, created_at) VALUES (?, 'pipeline', 'adapter', 'model', 'running', ?)",
    [id, TS],
  );
}

async function insertWorkItem(db: SqliteAdapter, id: string): Promise<void> {
  await db.execute(
    "INSERT INTO work_items (id, kind, lifecycle, status, updated_at) VALUES (?, 'function', 'pending', 'NOT_STARTED', ?)",
    [id, TS],
  );
}

/** Insert a lease directly (a "previous generation's" claim), bypassing the daemon. */
async function insertClaim(
  db: SqliteAdapter,
  workItemId: string,
  owner: string,
  epoch: string,
  expiresAt: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO claims
       (work_item_id, owner, run_id, worker_seq, allowed_paths, epoch, claimed_at, expires_at, heartbeat_at)
     VALUES (?, ?, 'run1', 1, '[]', ?, ?, ?, ?)`,
    [workItemId, owner, epoch, EXPIRED, expiresAt, EXPIRED],
  );
}

async function openDb(): Promise<SqliteAdapter> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  return db;
}

function workItem(id: string): WorkItem {
  return {
    id,
    kind: "function",
    unitId: "kyoshin/CGame",
    lifecycle: "pending",
    status: "NOT_STARTED",
    size: 128,
    attempts: 0,
    exhausted: false,
    ready: false,
    meta: {},
  };
}

async function claimRows(db: SqliteAdapter): Promise<string[]> {
  const rows = await db.query<{ work_item_id: string }>(
    "SELECT work_item_id FROM claims ORDER BY work_item_id",
  );
  return rows.map((row) => row.work_item_id);
}

/** Poll `predicate` every 5ms until it holds or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor: ${label} not satisfied within ${timeoutMs}ms`);
}

test("claim through the daemon: first owner wins; different owner and different epoch lose", async () => {
  const db = await openDb();
  try {
    await insertRun(db, "run1");
    await insertRun(db, "run2");
    await insertWorkItem(db, "wi_claim");

    const a = new StoreDaemon(db, { epoch: EPOCH_A });
    const b = new StoreDaemon(db, { epoch: EPOCH_B });

    // First claim through the daemon succeeds.
    assert.equal(
      await a.claim({ workItemId: "wi_claim", owner: "run1:1", ttlMs: 60_000 }),
      true,
    );
    // Re-claim by the same owner+epoch is an idempotent no-op (still true).
    assert.equal(
      await a.claim({ workItemId: "wi_claim", owner: "run1:1", ttlMs: 60_000 }),
      true,
    );
    // A different owner through the same daemon is refused.
    assert.equal(
      await a.claim({ workItemId: "wi_claim", owner: "run2:1", ttlMs: 60_000 }),
      false,
    );
    // A different daemon generation (different epoch), even with the same
    // owner, is refused — the orphan guard.
    assert.equal(
      await b.claim({ workItemId: "wi_claim", owner: "run1:1", ttlMs: 60_000 }),
      false,
    );

    // The store holds exactly one row, owned by the first daemon's epoch.
    assert.deepEqual(await claimRows(db), ["wi_claim"]);
    const row = (
      await db.query<{ owner: string; epoch: string }>(
        "SELECT owner, epoch FROM claims WHERE work_item_id = ?",
        ["wi_claim"],
      )
    )[0]!;
    assert.equal(row.owner, "run1:1");
    assert.equal(row.epoch, EPOCH_A);
  } finally {
    db.close();
  }
});

test("start() reaps expired leases once: an expired lease is gone, a live lease survives", async () => {
  const db = await openDb();
  try {
    await insertRun(db, "run1");
    await insertWorkItem(db, "wi_expired");
    await insertWorkItem(db, "wi_live");

    // Leases left behind by a previous daemon generation: one already
    // expired, one still within its lease window.
    await insertClaim(db, "wi_expired", "run1:1", EPOCH_A, EXPIRED);
    await insertClaim(db, "wi_live", "run1:2", EPOCH_A, LIVE);

    // A brand-new daemon generation starts up and sweeps.
    const daemon = new StoreDaemon(db, { epoch: EPOCH_B });
    await daemon.start();

    // The expired lease is gone; the live one is untouched.
    assert.deepEqual(await claimRows(db), ["wi_live"]);

    // Starting again is a no-op (the sweep runs exactly once).
    await daemon.start();
    assert.deepEqual(await claimRows(db), ["wi_live"]);
  } finally {
    db.close();
  }
});

test("reapExpired reports how many expired leases were swept", async () => {
  const db = await openDb();
  try {
    await insertRun(db, "run1");
    await insertWorkItem(db, "wi_1");
    await insertWorkItem(db, "wi_2");
    await insertWorkItem(db, "wi_3");

    await insertClaim(db, "wi_1", "run1:1", EPOCH_A, EXPIRED);
    await insertClaim(db, "wi_2", "run1:2", EPOCH_A, EXPIRED);
    // A fresh lease claimed through the daemon must survive the sweep.
    const daemon = new StoreDaemon(db, { epoch: EPOCH_B });
    assert.equal(
      await daemon.claim({ workItemId: "wi_3", owner: "run1:1", ttlMs: 60_000 }),
      true,
    );

    assert.equal(await daemon.reapExpired(), 2);
    assert.deepEqual(await claimRows(db), ["wi_3"]);
  } finally {
    db.close();
  }
});

test("reapNow sweeps expired leases on demand, without a restart", async () => {
  const db = await openDb();
  try {
    await insertRun(db, "run1");
    await insertWorkItem(db, "wi_reap_now");
    const daemon = new StoreDaemon(db, { epoch: EPOCH_B, reapIntervalMs: 60_000 });
    await daemon.start();

    // A lease that expires AFTER start()'s one-shot sweep: only a demand
    // sweep (or the timer) can free it — no restart involved.
    await insertClaim(db, "wi_reap_now", "run1:1", EPOCH_A, EXPIRED);
    assert.deepEqual(await claimRows(db), ["wi_reap_now"]);

    assert.equal(await daemon.reapNow(), 1);
    assert.deepEqual(await claimRows(db), []);
    assert.equal(await daemon.reapNow(), 0); // idempotent
    await daemon.close();
  } finally {
    db.close();
  }
});

test("continuous reap: the start() timer sweeps expired leases without a restart", async () => {
  const db = await openDb();
  try {
    await insertRun(db, "run1");
    await insertWorkItem(db, "wi_timed");
    const daemon = new StoreDaemon(db, { epoch: EPOCH_B, reapIntervalMs: 25 });
    await daemon.start();

    // Expire AFTER start()'s one-shot sweep, so only the timer can reap it.
    await insertClaim(db, "wi_timed", "run1:1", EPOCH_A, EXPIRED);
    assert.deepEqual(await claimRows(db), ["wi_timed"]);

    // The interval timer reaps it within ~25ms, with no restart or manual
    // sweep call.
    await waitFor(
      async () => (await claimRows(db)).length === 0,
      5_000,
      "timer must reap the expired lease",
    );
    await daemon.close();
  } finally {
    db.close();
  }
});

test("concurrent emits through the daemon assign strictly monotonic, gap-free seqs", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db, { epoch: EPOCH_A });
    const N = 120;
    // Fire everything before awaiting anything: all writes are in flight at
    // once and must still be serialized by the daemon's write queue in
    // enqueue order.
    const emits: Promise<number>[] = [];
    for (let i = 0; i < N; i++) {
      emits.push(daemon.emit({ ts: TS, type: "daemon.test", data: { i } }));
    }
    const seqs = await Promise.all(emits);

    // Enqueue order == flush order == seq assignment order.
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));

    // The store itself is gapless and payloads line up with their positions.
    const rows = await db.query<{ seq: number; data: string }>(
      "SELECT seq, data FROM events ORDER BY seq",
    );
    const stored = rows.map((r) => Number(r.seq));
    assert.deepEqual(stored, Array.from({ length: N }, (_, i) => i + 1));
    assert.equal(new Set(stored).size, N);
    assert.deepEqual(
      rows.map((r) => JSON.parse(r.data)),
      Array.from({ length: N }, (_, i) => ({ i })),
    );
  } finally {
    db.close();
  }
});

test("two daemons over the same SQLite file race a claim: exactly one wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-daemon-"));
  const file = join(dir, "store.db");
  const a = new SqliteAdapter(file);
  const b = new SqliteAdapter(file);
  try {
    await a.migrate([]);
    await b.migrate([]);
    await insertRun(a, "run1");
    await insertWorkItem(a, "wi_race");

    const daemonA = new StoreDaemon(a, { epoch: EPOCH_A });
    const daemonB = new StoreDaemon(b, { epoch: EPOCH_B });

    // Two independent connections (two processes, in the real world) race
    // the same PK. The CAS is a DB-level unique constraint: one insert wins.
    const results = await Promise.all([
      daemonA.claim({ workItemId: "wi_race", owner: "run1:1", ttlMs: 60_000 }),
      daemonB.claim({ workItemId: "wi_race", owner: "run1:2", ttlMs: 60_000 }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);

    // The survivor is one full claim row, owned by exactly one daemon.
    const rows = await a.query<{ owner: string; epoch: string }>(
      "SELECT owner, epoch FROM claims WHERE work_item_id = ?",
      ["wi_race"],
    );
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.epoch === EPOCH_A || rows[0]!.epoch === EPOCH_B);

    // The loser's daemon cannot heartbeat or release the winner's lease; the
    // winner's daemon can (epoch guard holds across connections).
    const winnerEpoch = rows[0]!.epoch;
    const winner = winnerEpoch === EPOCH_A ? daemonA : daemonB;
    const loser = winner === daemonA ? daemonB : daemonA;
    const winnerOwner = winner === daemonA ? "run1:1" : "run1:2";
    assert.equal(await loser.heartbeat("wi_race", winnerOwner, 60_000), false);
    assert.equal(await loser.release("wi_race", winnerOwner), false);
    assert.equal(await winner.heartbeat("wi_race", winnerOwner, 60_000), true);
    assert.equal(await winner.release("wi_race", winnerOwner), true);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two REAL processes race claims on one SQLite file: exactly one winner per item, loser gets false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-proc-"));
  const file = join(dir, "store.db");
  const goFile = join(dir, "go");
  const ITEMS = 50;
  try {
    // Parent migrates + seeds, then closes: the two children are the only
    // writers, racing over the same file like two daemon processes would.
    const seed = new SqliteAdapter(file);
    await seed.migrate([]);
    await insertRun(seed, "run1");
    for (let i = 0; i < ITEMS; i++) await insertWorkItem(seed, `wi_${i}`);
    seed.close();

    const childPath = fileURLToPath(
      new URL("./helpers/claim-race-child.ts", import.meta.url),
    );
    const readyA = join(dir, "ready-a");
    const readyB = join(dir, "ready-b");
    const spawnChild = (ready: string, owner: string, epoch: string) =>
      spawn(
        process.execPath,
        ["--import", "tsx", childPath, file, goFile, ready, owner, epoch, String(ITEMS)],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
    const collect = (child: ChildProcess): Promise<string> =>
      new Promise((resolve, reject) => {
        let out = "";
        child.stdout!.on("data", (chunk) => {
          out += String(chunk);
        });
        child.on("error", reject);
        child.on("exit", () => resolve(out));
      });

    const childA = spawnChild(readyA, "run1:1", EPOCH_A);
    const childB = spawnChild(readyB, "run1:2", EPOCH_B);
    const outA = collect(childA);
    const outB = collect(childB);

    // Release both children at the same instant once both are ready.
    await waitFor(
      () => existsSync(readyA) && existsSync(readyB),
      15_000,
      "both children ready",
    );
    writeFileSync(goFile, "go");

    const resultA = JSON.parse(await outA) as { ok?: boolean[]; error?: string };
    const resultB = JSON.parse(await outB) as { ok?: boolean[]; error?: string };

    // Neither child may crash with SQLITE_BUSY (or anything else): the loser
    // of each item's race must get `false`, not an exception.
    assert.equal(resultA.error, undefined, `child A: ${resultA.error ?? ""}`);
    assert.equal(resultB.error, undefined, `child B: ${resultB.error ?? ""}`);
    const okA = resultA.ok!;
    const okB = resultB.ok!;
    assert.equal(okA.length, ITEMS);
    assert.equal(okB.length, ITEMS);

    // Per item, exactly one process won the claim (the other got false).
    for (let i = 0; i < ITEMS; i++) {
      assert.notEqual(okA[i], okB[i], `wi_${i} must have exactly one winner`);
    }
    assert.equal(okA.filter(Boolean).length + okB.filter(Boolean).length, ITEMS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat and release are epoch-guarded through the daemon", async () => {
  const db = await openDb();
  try {
    await insertRun(db, "run1");
    await insertRun(db, "run2");
    await insertWorkItem(db, "wi_hb");

    const a = new StoreDaemon(db, { epoch: EPOCH_A });
    const b = new StoreDaemon(db, { epoch: EPOCH_B });

    assert.equal(
      await a.claim({ workItemId: "wi_hb", owner: "run1:1", ttlMs: 60_000 }),
      true,
    );

    // A different daemon generation cannot heartbeat or release the lease.
    assert.equal(await b.heartbeat("wi_hb", "run1:1", 60_000), false);
    assert.equal(await b.release("wi_hb", "run1:1"), false);

    // The owning daemon extends the lease expiry.
    const before = (
      await db.query<{ expires_at: string }>(
        "SELECT expires_at FROM claims WHERE work_item_id = ?",
        ["wi_hb"],
      )
    )[0]!.expires_at;
    await new Promise((resolve) => setTimeout(resolve, 5)); // clock must advance
    assert.equal(await a.heartbeat("wi_hb", "run1:1", 60_000), true);
    const after = (
      await db.query<{ expires_at: string }>(
        "SELECT expires_at FROM claims WHERE work_item_id = ?",
        ["wi_hb"],
      )
    )[0]!.expires_at;
    assert.ok(new Date(after).getTime() > new Date(before).getTime());

    // The owner releases; a second release is a no-op.
    assert.equal(await a.release("wi_hb", "run1:1"), true);
    assert.equal(await a.release("wi_hb", "run1:1"), false);
    assert.deepEqual(await claimRows(db), []);
  } finally {
    db.close();
  }
});

test("importWorkItems then exportRegistry round-trips the registry", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db, { epoch: EPOCH_A });
    assert.equal(
      await daemon.importWorkItems([workItem("wi_a"), workItem("wi_b")]),
      2,
    );

    const snapshot = await daemon.exportRegistry();
    assert.deepEqual(
      snapshot.workItems.map((item) => item.id).sort(),
      ["wi_a", "wi_b"],
    );
    const item = snapshot.workItems.find((entry) => entry.id === "wi_a")!;
    assert.equal(item.kind, "function");
    assert.equal(item.status, "NOT_STARTED");
    assert.equal(item.lifecycle, "pending");
    assert.equal(item.unitId, "kyoshin/CGame");

    // Duplicate ids are rejected, never silently overwritten…
    await assert.rejects(
      daemon.importWorkItems([workItem("wi_a")]),
      /UNIQUE constraint failed|PRIMARY KEY constraint failed/i,
    );
    // …and the failed batch rolled back: the store is unchanged.
    assert.equal((await daemon.exportRegistry()).workItems.length, 2);
  } finally {
    db.close();
  }
});

test("select through the daemon returns mapped work items", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db, { epoch: EPOCH_A });
    await daemon.importWorkItems([
      { ...workItem("wi_big"), size: 256, status: "FULL_MATCH" },
      { ...workItem("wi_small"), size: 16, status: "CODE_MATCH" },
      { ...workItem("wi_other"), size: 32, status: "FULL_MATCH" },
    ]);

    const items = await daemon.select({
      filter: { status: ["FULL_MATCH"] },
      sort: [{ by: "size", dir: "desc" }],
      limit: 50,
    });
    assert.deepEqual(
      items.map((item) => item.id),
      ["wi_big", "wi_other"],
    );
    assert.equal(items[0]!.size, 256);
  } finally {
    db.close();
  }
});

test("select through the daemon never observes a partial import (read-after-write)", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db, { epoch: EPOCH_A });
    const N = 3000;
    const items = Array.from({ length: N }, (_, i) => workItem(`wi_batch_${i}`));

    // Kick off a large import: its transaction stays open across thousands
    // of awaited inserts. A select issued while it is in flight must
    // serialize behind it on the daemon's write queue (read-after-write
    // consistency) and see the WHOLE registry — never a partial one.
    const importing = daemon.importWorkItems(items);
    const selected = daemon.select({ limit: N + 10 });

    assert.equal(await importing, N);
    const seen = await selected;
    assert.equal(seen.length, N, "select must not observe a partial registry");
    assert.equal(new Set(seen.map((item) => item.id)).size, N);
  } finally {
    db.close();
  }
});

test("close() drains the write queue and rejects further writes", async () => {
  const db = await openDb();
  try {
    await insertRun(db, "run1");
    await insertWorkItem(db, "wi_close");
    const daemon = new StoreDaemon(db, { epoch: EPOCH_A });

    // A write in flight when close() is called still completes.
    const pending = daemon.emit({ ts: TS, type: "daemon.test", data: {} });
    const closed = daemon.close();
    assert.equal(await pending, 1);
    await closed;

    await assert.rejects(
      daemon.claim({ workItemId: "wi_close", owner: "run1:1", ttlMs: 60_000 }),
      /closed/,
    );
    await assert.rejects(daemon.reapExpired(), /closed/);
  } finally {
    db.close();
  }
});
