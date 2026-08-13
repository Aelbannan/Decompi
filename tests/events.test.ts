/**
 * Event store tests (SPEC §6.2, §18): monotonic seq assignment under
 * concurrency, cursor reads, run/work-item filters, JSON round-trip,
 * counters increments, and write-queue resilience.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import type { Migration, SqlAdapter } from "../src/core/store/adapter.js";
import {
  EventStore,
  EVENTS_SEQ_COUNTER,
  type EmitEvent,
} from "../src/core/events.js";

const TS = "2025-01-01T00:00:00.000Z";

function event(i: number, extra: Partial<EmitEvent> = {}): EmitEvent {
  return { ts: TS, type: "run.log", data: { i }, ...extra };
}

async function openStore(): Promise<{ db: SqliteAdapter; store: EventStore }> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  return { db, store: new EventStore(db) };
}

test("concurrent emits assign strictly monotonic seqs (no gaps, no dupes)", async () => {
  const { db, store } = await openStore();
  try {
    const N = 150;
    // Fire everything before awaiting anything: all writes are in flight at
    // once and must still be serialized by the queue in enqueue order.
    const emits: Promise<number>[] = [];
    for (let i = 0; i < N; i++) emits.push(store.emit(event(i)));
    const seqs = await Promise.all(emits);

    // Enqueue order == flush order == seq assignment order.
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));

    // No gaps, no dupes, and payloads line up with their position.
    const rows = await store.readAfter(0);
    assert.deepEqual(
      rows.map((r) => r.seq),
      Array.from({ length: N }, (_, i) => i + 1),
    );
    assert.equal(new Set(rows.map((r) => r.seq)).size, N);
    assert.deepEqual(
      rows.map((r) => r.data),
      Array.from({ length: N }, (_, i) => ({ i })),
    );
  } finally {
    db.close();
  }
});

test("counters table seeds once and increments per emit (events.seq)", async () => {
  const { db, store } = await openStore();
  try {
    assert.equal(await store.count(), 0);

    const s1 = await store.emit(event(0));
    const s2 = await store.emit(event(1));
    const s3 = await store.emit(event(2));
    assert.deepEqual([s1, s2, s3], [1, 2, 3]);

    const counters = await db.query<{ name: string; next: number }>(
      "SELECT name, next FROM counters WHERE name = ?",
      [EVENTS_SEQ_COUNTER],
    );
    assert.equal(counters.length, 1); // seeded exactly once, not per emit
    assert.equal(counters[0]!.name, EVENTS_SEQ_COUNTER);
    assert.equal(Number(counters[0]!.next), 3);
    assert.equal(await store.count(), 3);
  } finally {
    db.close();
  }
});

test("readAfter returns events with seq > cursor, ascending, honoring limit", async () => {
  const { db, store } = await openStore();
  try {
    for (let i = 0; i < 5; i++) await store.emit(event(i));

    assert.deepEqual(
      (await store.readAfter(0)).map((r) => r.seq),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      (await store.readAfter(2)).map((r) => r.seq),
      [3, 4, 5],
    );
    assert.deepEqual((await store.readAfter(5)).map((r) => r.seq), []);
    // Past the cursor: limit caps the tail of the cursor stream.
    assert.deepEqual((await store.readAfter(2, 1)).map((r) => r.seq), [3]);
    assert.deepEqual((await store.readAfter(0, 2)).map((r) => r.seq), [1, 2]);
    // Row fields survive the round trip.
    const row = (await store.readAfter(0, 1))[0]!;
    assert.equal(row.ts, TS);
    assert.equal(row.type, "run.log");
    assert.deepEqual(row.data, { i: 0 });
  } finally {
    db.close();
  }
});

test("data payloads round-trip through JSON TEXT", async () => {
  const { db, store } = await openStore();
  try {
    const data = {
      attempt: 3,
      delta: { added: 2, removed: 1 },
      tags: ["alpha", "beta"],
      ok: true,
      ratio: 0.5,
      nested: { deep: [1, 2, 3] },
    };
    const seq = await store.emit({
      ts: TS,
      type: "verify.result",
      data,
    });

    const rows = await store.readAfter(seq - 1);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.data, data);

    // The stored column is TEXT JSON, not a structured column.
    const raw = await db.query<{ data: string }>(
      "SELECT data FROM events WHERE seq = ?",
      [seq],
    );
    assert.equal(raw[0]!.data, JSON.stringify(data));
  } finally {
    db.close();
  }
});

test("readByRun and readByWorkItem filter events", async () => {
  const { db, store } = await openStore();
  try {
    const a1 = await store.emit({ ts: TS, type: "run.log", runId: "run_a", data: { n: 1 } });
    const b1 = await store.emit({ ts: TS, type: "run.log", runId: "run_b", data: { n: 2 } });
    const a2 = await store.emit({
      ts: TS,
      type: "work.claimed",
      runId: "run_a",
      workItemId: "wi_1",
      data: {},
    });
    const b2 = await store.emit({
      ts: TS,
      type: "work.claimed",
      runId: "run_b",
      workItemId: "wi_2",
      data: {},
    });
    const a3 = await store.emit({
      ts: TS,
      type: "work.verified",
      workItemId: "wi_1",
      data: {},
    });

    const runA = await store.readByRun("run_a");
    assert.deepEqual(
      runA.map((r) => r.seq),
      [a1, a2],
    );
    for (const row of runA) assert.equal(row.runId, "run_a");

    const wi1 = await store.readByWorkItem("wi_1");
    assert.deepEqual(
      wi1.map((r) => r.seq),
      [a2, a3],
    );
    for (const row of wi1) assert.equal(row.workItemId, "wi_1");

    assert.deepEqual(
      (await store.readByRun("run_a", 1)).map((r) => r.seq),
      [a1],
    );
    assert.deepEqual(await store.readByRun("nope"), []);
    assert.deepEqual(await store.readByWorkItem("nope"), []);
    // b2 belongs to run_b but not to wi_1: filters compose on the row.
    const runBwi1 = await store.readByRun("run_b");
    assert.deepEqual(
      runBwi1.map((r) => r.seq),
      [b1, b2],
    );
  } finally {
    db.close();
  }
});

test("level defaults to info; runId/workItemId are optional", async () => {
  const { db, store } = await openStore();
  try {
    const seq = await store.emit({ ts: TS, type: "run.log", data: {} });
    const row = (await store.readAfter(seq - 1))[0]!;
    assert.equal(row.level, "info");
    assert.equal(row.runId, undefined);
    assert.equal(row.workItemId, undefined);

    const warnSeq = await store.emit({
      ts: TS,
      type: "run.log",
      level: "warn",
      data: {},
    });
    assert.equal((await store.readAfter(warnSeq - 1))[0]!.level, "warn");
    assert.equal(await store.count(), 2);
  } finally {
    db.close();
  }
});

test("a failed emit rejects its caller but does not break the queue", async () => {
  const { db, store } = await openStore();
  try {
    // Circular payload: JSON.stringify throws inside the transaction, which
    // rolls back (counter included) and rejects only this emit.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad = store.emit({ ts: TS, type: "run.log", data: circular });

    // Queued behind the bad write: must still flush with the next seq.
    const good = store.emit({ ts: TS, type: "run.log", data: { ok: true } });

    await assert.rejects(bad, /circular|Converting|structured/i);
    assert.equal(await good, 1); // counter rolled back with the failed tx
    assert.equal(await store.count(), 1);
    assert.deepEqual((await store.readAfter(0))[0]!.data, { ok: true });
  } finally {
    db.close();
  }
});

test("two EventStore instances over one adapter still assign unique gap-free seqs", async () => {
  const { db } = await openStore();
  try {
    const a = new EventStore(db);
    const b = new EventStore(db);
    const seqs = await Promise.all([
      a.emit({ ts: TS, type: "run.log", data: { src: "a1" } }),
      b.emit({ ts: TS, type: "run.log", data: { src: "b1" } }),
      a.emit({ ts: TS, type: "run.log", data: { src: "a2" } }),
      b.emit({ ts: TS, type: "run.log", data: { src: "b2" } }),
    ]);
    // Even without a shared in-process queue, the adapter serializes the
    // transactions and each one increments+inserts atomically, so seqs are
    // unique and gapless (just not necessarily in enqueue order).
    assert.equal(new Set(seqs).size, 4);
    assert.deepEqual([...seqs].sort((x, y) => x - y), [1, 2, 3, 4]);
    assert.equal(await a.count(), 4);
  } finally {
    db.close();
  }
});

/** Delegating adapter wrapper that counts `transaction()` invocations. */
class CountingAdapter implements SqlAdapter {
  transactions = 0;
  constructor(private readonly inner: SqlAdapter) {}
  query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.inner.query<T>(sql, params);
  }
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.inner.execute(sql, params);
  }
  transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return this.inner.transaction(fn);
  }
  insertIgnore(sql: string, params?: unknown[]): Promise<boolean> {
    return this.inner.insertIgnore(sql, params);
  }
  isUniqueViolation(err: unknown): boolean {
    return this.inner.isUniqueViolation(err);
  }
  migrate(migrations: Migration[]): Promise<void> {
    return this.inner.migrate(migrations);
  }
}

test("a burst of emits is micro-batched: gap-free seqs in fewer transactions than emits", async () => {
  const { db } = await openStore();
  const counting = new CountingAdapter(db);
  // 60s window so the ONLY flush triggers are full batches (25 events each).
  const store = new EventStore(counting, { batchSize: 25, flushDelayMs: 60_000 });
  try {
    const N = 200;
    const emits: Promise<number>[] = [];
    for (let i = 0; i < N; i++) emits.push(store.emit(event(i)));
    const seqs = await Promise.all(emits);

    // Enqueue order == flush order == seq assignment order, gap-free.
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));
    // 200 events in batches of 25 → exactly 8 flush transactions, not 200
    // (SPEC §18: batched writes).
    assert.equal(counting.transactions, N / 25);

    const rows = await store.readAfter(0);
    assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: N }, (_, i) => i + 1));
    assert.deepEqual(
      rows.map((r) => r.data),
      Array.from({ length: N }, (_, i) => ({ i })),
    );
  } finally {
    db.close();
  }
});

test("event queue is bounded: producers block (backpressure) until a flush frees room", { timeout: 10_000 }, async () => {
  const { db } = await openStore();
  // Cap of 6 pending; batches of 2. Firing 30 emits without awaiting means
  // most producers hit the cap and must wait for a flush to drain — if the
  // waiters were never released the test would hang (guarded by timeout).
  const store = new EventStore(db, { batchSize: 2, maxPending: 6, flushDelayMs: 1_000 });
  try {
    const N = 30;
    const emits: Promise<number>[] = [];
    for (let i = 0; i < N; i++) emits.push(store.emit(event(i)));
    const seqs = await Promise.all(emits);

    // Every emit succeeded (nothing dropped) with gap-free seqs in enqueue
    // order, despite the queue having been full for most of the burst.
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));
    assert.equal(await store.count(), N);
  } finally {
    db.close();
  }
});
