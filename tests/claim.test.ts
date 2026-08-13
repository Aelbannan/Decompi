/**
 * ClaimStore tests (SPEC §6.3): CAS claim semantics, idempotent re-claim,
 * owner+epoch-guarded heartbeat/release, expiry reap, and lookup/decoding.
 *
 * FKs are enforced by `node:sqlite`, so every fixture inserts its `work_items`
 * and `runs` rows first (claims references both — `runs` via `ON DELETE
 * SET NULL`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { ClaimStore } from "../src/target/claim.js";

const OWNER_A = "run1:1";
const OWNER_B = "run2:1";
const EPOCH_A = "epoch-aaaa-0000-0000-000000000000";
const EPOCH_B = "epoch-bbbb-0000-0000-000000000000";
const EPOCH_Z = "epoch-zzzz-0000-0000-000000000000"; // stale-generation epoch

const FIXED_ISO = "2025-05-01T00:00:00.000Z";

async function insertWorkItem(db: SqliteAdapter, id: string): Promise<void> {
  await db.execute(
    "INSERT INTO work_items (id, kind, lifecycle, status, updated_at) VALUES (?, 'function', 'pending', 'NOT_STARTED', ?)",
    [id, FIXED_ISO],
  );
}

async function insertRun(db: SqliteAdapter, id: string): Promise<void> {
  await db.execute(
    "INSERT INTO runs (id, pipeline, adapter, model, status, created_at) VALUES (?, 'pipeline', 'adapter', 'model', 'running', ?)",
    [id, FIXED_ISO],
  );
}

const WORK_ITEM_IDS = [
  "wi_race",
  "wi_idem",
  "wi_diff",
  "wi_hb",
  "wi_short",
  "wi_long",
  "wi_rel",
  "wi_paths",
  "wi_no_paths",
  "wi_f1",
  "wi_f2",
  "wi_f3",
  "wi_swp",
] as const;

async function setup(now?: () => Date): Promise<{ db: SqliteAdapter; store: ClaimStore }> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  await insertRun(db, "run1");
  await insertRun(db, "run2");
  for (const id of WORK_ITEM_IDS) await insertWorkItem(db, id);
  const store = new ClaimStore(db, now === undefined ? {} : { now });
  return { db, store };
}

function claimArgs(
  workItemId: string,
  owner: string,
  epoch: string,
  ttlMs = 60_000,
  allowedPaths?: string[],
) {
  return { workItemId, owner, epoch, ttlMs, ...(allowedPaths === undefined ? {} : { allowedPaths }) };
}

test("claim: two owners racing for one item — exactly one wins", async () => {
  const { db, store } = await setup();
  try {
    // Sequential: the first owner wins, the second is refused.
    assert.equal(await store.claim(claimArgs("wi_race", OWNER_A, EPOCH_A)), true);
    assert.equal(await store.claim(claimArgs("wi_race", OWNER_B, EPOCH_B)), false);

    // A fresh item contested by two concurrent claims: exactly one true.
    const [a, b] = await Promise.all([
      store.claim(claimArgs("wi_f1", OWNER_A, EPOCH_A)),
      store.claim(claimArgs("wi_f1", OWNER_B, EPOCH_B)),
    ]);
    assert.equal(a !== b, true);

    // The winner's claim on wi_f1 is durable (findByOwner may also return
    // this owner's other claims, so locate the row by item).
    const winnerOwner = a ? OWNER_A : OWNER_B;
    const winner = (await store.findByOwner(winnerOwner)).find((c) => c.workItemId === "wi_f1")!;
    assert.equal(winner.workItemId, "wi_f1");
    assert.equal(winner.owner, winnerOwner);
    // The loser cannot subsequently claim the same item.
    assert.equal(
      await store.claim(claimArgs("wi_f1", a ? OWNER_B : OWNER_A, a ? EPOCH_B : EPOCH_A)),
      false,
    );
  } finally {
    db.close();
  }
});

test("claim: same-owner re-claim re-arms a live lease (extends expiry)", async () => {
  const { db, store } = await setup();
  try {
    assert.equal(await store.claim(claimArgs("wi_idem", OWNER_A, EPOCH_A, 10_000, ["src/a.c"])), true);
    const before = (await store.findByOwner(OWNER_A))[0]!;

    // Same owner+epoch, longer ttl: returns true AND extends the lease
    // (guarded UPDATE — never a silent no-op, per the two-active-workers fix).
    assert.equal(await store.claim(claimArgs("wi_idem", OWNER_A, EPOCH_A, 60_000, ["src/b.c"])), true);

    const after = (await store.findByOwner(OWNER_A))[0]!;
    assert.equal(after.workItemId, "wi_idem");
    assert.equal(after.owner, OWNER_A);
    assert.equal(after.epoch, EPOCH_A);
    // claimed_at is the original claim time; the lease was re-armed.
    assert.equal(after.claimedAt, before.claimedAt);
    assert.ok(
      new Date(after.expiresAt).getTime() > new Date(before.expiresAt).getTime(),
      "re-claim must extend expires_at",
    );
    assert.ok(
      new Date(after.heartbeatAt).getTime() >= new Date(before.heartbeatAt).getTime(),
    );
    // allowed_paths is refreshed on re-claim (SPEC §6.3 write-scope allowlist).
    assert.deepEqual(after.allowedPaths, ["src/b.c"]);
  } finally {
    db.close();
  }
});

test("claim: a different owner or epoch cannot re-claim a held item", async () => {
  const { db, store } = await setup();
  try {
    assert.equal(await store.claim(claimArgs("wi_diff", OWNER_A, EPOCH_A)), true);

    // Different owner, different epoch.
    assert.equal(await store.claim(claimArgs("wi_diff", OWNER_B, EPOCH_B)), false);
    // Same owner, stale epoch (daemon restart with the same run/worker).
    assert.equal(await store.claim(claimArgs("wi_diff", OWNER_A, EPOCH_Z)), false);
    // Same epoch, different owner string.
    assert.equal(await store.claim(claimArgs("wi_diff", "run3:1", EPOCH_A)), false);

    // The original holder still owns it; a different item is claimable.
    assert.equal((await store.findByOwner(OWNER_A))[0]?.workItemId, "wi_diff");
    assert.equal(await store.claim(claimArgs("wi_f2", OWNER_B, EPOCH_B)), true);
  } finally {
    db.close();
  }
});

test("heartbeat extends expiry only when owner+epoch match", async () => {
  const { db, store } = await setup();
  try {
    assert.equal(await store.claim(claimArgs("wi_hb", OWNER_A, EPOCH_A, 10_000)), true);
    const before = (await store.findByOwner(OWNER_A))[0]!;

    // Wrong owner and wrong epoch: refused, row untouched.
    assert.equal(await store.heartbeat("wi_hb", OWNER_B, EPOCH_B, 60_000), false);
    assert.equal(await store.heartbeat("wi_hb", OWNER_A, EPOCH_Z, 60_000), false);
    const afterFailed = (await store.findByOwner(OWNER_A))[0]!;
    assert.equal(afterFailed.expiresAt, before.expiresAt);
    assert.equal(afterFailed.heartbeatAt, before.heartbeatAt);

    // Matching owner+epoch: lease extends 10s → 60s.
    assert.equal(await store.heartbeat("wi_hb", OWNER_A, EPOCH_A, 60_000), true);
    const after = (await store.findByOwner(OWNER_A))[0]!;
    const beforeMs = new Date(before.expiresAt).getTime();
    const afterMs = new Date(after.expiresAt).getTime();
    assert.ok(afterMs > beforeMs + 40_000, "expiry should extend by ~50s");
    assert.ok(new Date(after.heartbeatAt).getTime() >= new Date(before.heartbeatAt).getTime());

    // Unknown item: refused.
    assert.equal(await store.heartbeat("wi_missing", OWNER_A, EPOCH_A, 60_000), false);
  } finally {
    db.close();
  }
});

test("reapExpired removes only expired leases", async () => {
  // Deterministic clock: claim writes use the injected `now`.
  const fakeNow = new Date("2025-06-01T00:00:00.000Z");
  const { db, store } = await setup(() => fakeNow);
  try {
    await store.claim(claimArgs("wi_short", OWNER_A, EPOCH_A, 1_000)); // expires 00:00:01
    await store.claim(claimArgs("wi_long", OWNER_B, EPOCH_B, 60_000)); // expires 00:01:00

    fakeNow.setTime(Date.parse("2025-06-01T00:00:30.000Z"));
    const reaped = await store.reapExpired(fakeNow.toISOString());
    assert.equal(reaped, 1);

    assert.equal((await store.findByOwner(OWNER_A)).length, 0); // expired → gone
    assert.equal((await store.findByOwner(OWNER_B)).length, 1); // live → kept

    // Reaping again is a no-op.
    assert.equal(await store.reapExpired(fakeNow.toISOString()), 0);
  } finally {
    db.close();
  }
});

test("release frees the row only when owner+epoch match", async () => {
  const { db, store } = await setup();
  try {
    assert.equal(await store.claim(claimArgs("wi_rel", OWNER_A, EPOCH_A)), true);

    // Wrong owner / wrong epoch: refused, still held.
    assert.equal(await store.release("wi_rel", OWNER_B, EPOCH_B), false);
    assert.equal(await store.release("wi_rel", OWNER_A, EPOCH_Z), false);
    assert.equal((await store.findByOwner(OWNER_A)).length, 1);

    // Matching owner+epoch: released.
    assert.equal(await store.release("wi_rel", OWNER_A, EPOCH_A), true);
    assert.equal((await store.findByOwner(OWNER_A)).length, 0);
    assert.equal((await store.findByRunId("run1")).length, 0);

    // Releasing an already-gone claim is a no-op false.
    assert.equal(await store.release("wi_rel", OWNER_A, EPOCH_A), false);
  } finally {
    db.close();
  }
});

test("allowed_paths round-trips as a JSON array", async () => {
  const { db, store } = await setup();
  try {
    const paths = ["src/a.c", "src/sub/b.h", "include/g.h"];
    await store.claim(claimArgs("wi_paths", OWNER_A, EPOCH_A, 60_000, paths));
    const [row] = await store.findByOwner(OWNER_A);
    assert.deepEqual(row.allowedPaths, paths);

    // Raw column is a JSON array (portable TEXT, no JSON operators).
    const raw = await db.query<{ allowed_paths: string }>(
      "SELECT allowed_paths FROM claims WHERE work_item_id = ?",
      ["wi_paths"],
    );
    assert.deepEqual(JSON.parse(raw[0]!.allowed_paths), paths);

    // Omitted allowlist defaults to [].
    await store.claim(claimArgs("wi_no_paths", OWNER_B, EPOCH_B));
    assert.deepEqual((await store.findByOwner(OWNER_B))[0]!.allowedPaths, []);
  } finally {
    db.close();
  }
});

test("claim: a re-claim of an expired lease is refused (two-active-workers guard)", async () => {
  // Deterministic clock: the claim's `expires_at` is computed from `now`.
  const fakeNow = new Date("2025-06-01T00:00:00.000Z");
  const { db, store } = await setup(() => fakeNow);
  try {
    // A claims a 1s lease at 00:00:00 → expires 00:00:01.
    assert.equal(await store.claim(claimArgs("wi_swp", OWNER_A, EPOCH_A, 1_000)), true);

    // 30s later the lease is dead but the row is still there (unswept). A
    // re-claim by the same owner+epoch must NOT silently return true without
    // extending the lease — the old code did exactly that, letting the
    // reaper sweep it while A kept working (two active workers).
    fakeNow.setTime(Date.parse("2025-06-01T00:00:30.000Z"));
    assert.equal(await store.claim(claimArgs("wi_swp", OWNER_A, EPOCH_A, 60_000)), false);
    assert.equal(await store.claim(claimArgs("wi_swp", OWNER_A, EPOCH_A, 60_000)), false);

    // The reaper sweeps the dead row and the item becomes claimable again.
    assert.equal(await store.reapExpired(fakeNow.toISOString()), 1);
    assert.equal(await store.claim(claimArgs("wi_swp", OWNER_B, EPOCH_B, 60_000)), true);
  } finally {
    db.close();
  }
});

test("claim with a runId that has no runs row succeeds (run auto-created)", async () => {
  const { db, store } = await setup(); // setup only seeds run1/run2
  try {
    // "run_new" has no runs row: the claim must not throw FOREIGN KEY.
    assert.equal(await store.claim(claimArgs("wi_f1", "run_new:1", EPOCH_A)), true);
    const row = (await store.findByRunId("run_new"))[0]!;
    assert.equal(row.workItemId, "wi_f1");
    assert.equal(row.runId, "run_new");
    assert.equal(row.workerSeq, 1);
    assert.equal(row.epoch, EPOCH_A);

    // The runs row was created idempotently with the daemon-owned defaults.
    const runs = await db.query<{ id: string; pipeline: string; status: string; created_at: string }>(
      "SELECT id, pipeline, status, created_at FROM runs WHERE id = ?",
      ["run_new"],
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.id, "run_new");
    assert.equal(runs[0]!.pipeline, "");
    assert.equal(runs[0]!.status, "running");
    assert.ok(new Date(runs[0]!.created_at).getTime() > 0);

    // A second claim under the same new run still works (idempotent create).
    assert.equal(await store.claim(claimArgs("wi_f2", "run_new:2", EPOCH_A)), true);
  } finally {
    db.close();
  }
});

test("claim rejects malformed owner strings", async () => {
  const { db, store } = await setup();
  try {
    // Anything that is not "<run_id>:<digits>" is rejected up front.
    for (const bad of ["nocolon", "run1", "run1:", "run1:abc", ":1", "run:1:2"]) {
      await assert.rejects(
        store.claim(claimArgs("wi_f2", bad, EPOCH_A)),
        /invalid claim owner/,
        `owner ${JSON.stringify(bad)} must be rejected`,
      );
    }
    // A valid owner still claims fine.
    assert.equal(await store.claim(claimArgs("wi_f2", "run1:2", EPOCH_A)), true);
  } finally {
    db.close();
  }
});

test("findByOwner and findByRunId decode rows and derive run_id/worker_seq from owner", async () => {
  const { db, store } = await setup();
  try {
    await store.claim(claimArgs("wi_f1", "run1:1", EPOCH_A));
    await store.claim(claimArgs("wi_f2", "run1:2", EPOCH_A));
    await store.claim(claimArgs("wi_f3", "run2:1", EPOCH_B));

    // By run id: only that run's claims, decoded owner-derived columns.
    const run1 = await store.findByRunId("run1");
    assert.equal(run1.length, 2);
    for (const claim of run1) {
      assert.equal(claim.runId, "run1");
      assert.equal(claim.epoch, EPOCH_A);
      assert.ok(claim.workerSeq === 1 || claim.workerSeq === 2);
    }
    assert.equal((await store.findByRunId("run_none")).length, 0);

    // By owner: exact match with full decode.
    const byOwner = await store.findByOwner("run1:2");
    assert.equal(byOwner.length, 1);
    const row = byOwner[0]!;
    assert.equal(row.workItemId, "wi_f2");
    assert.equal(row.owner, "run1:2");
    assert.equal(row.runId, "run1");
    assert.equal(row.workerSeq, 2);
    assert.equal(row.epoch, EPOCH_A);
    assert.deepEqual(row.allowedPaths, []);
    assert.ok(new Date(row.claimedAt).getTime() > 0);
    assert.ok(new Date(row.expiresAt).getTime() > new Date(row.claimedAt).getTime());
    assert.ok(new Date(row.heartbeatAt).getTime() > 0);

    // run_id column derives from owner even when not passed explicitly.
    const raw = await db.query<{ run_id: string | null; worker_seq: number | null }>(
      "SELECT run_id, worker_seq FROM claims WHERE work_item_id = ?",
      ["wi_f3"],
    );
    assert.equal(raw[0]!.run_id, "run2");
    assert.equal(raw[0]!.worker_seq, 1);
  } finally {
    db.close();
  }
});
