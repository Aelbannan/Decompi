/**
 * StoreDaemon.finalizeWorkflowItem tests (SPEC §A.4): the single-transaction
 * status write — precise status row UPSERT (SPEC §A.2, status =
 * action.status ?? completionStatus ?? "DONE") + the `CompletionAction`
 * write on `work_items` + a `target-status` event emitted ONLY on a status
 * change, committed together. Covers: promote (lifecycle+status+row+event),
 * same-status re-finalize (no duplicate event), `promote:false` (row only),
 * COALESCE status retention, `{status}`-only writes, the `completionStatus`
 * default, and whole-transaction rollback when the event payload cannot be
 * serialized.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { StoreDaemon } from "../src/core/daemon.js";
import type { WorkItem } from "../src/types.js";

async function openDb(): Promise<SqliteAdapter> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]); // canonical schema.sql, applied fresh
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

interface StatusRow {
  workflow_id: string;
  unit_id: string;
  target_id: string;
  status: string;
  actor: string;
  reason: string | null;
}

async function statusRows(db: SqliteAdapter): Promise<StatusRow[]> {
  return db.query<StatusRow>(
    "SELECT workflow_id, unit_id, target_id, status, actor, reason FROM workflow_status ORDER BY updated_at",
  );
}

interface EventRow {
  seq: number;
  work_item_id: string | null;
  type: string;
  data: string;
}

async function eventRows(db: SqliteAdapter): Promise<EventRow[]> {
  return db.query<EventRow>(
    "SELECT seq, work_item_id, type, data FROM events ORDER BY seq",
  );
}

async function itemLifecycle(
  db: SqliteAdapter,
  id: string,
): Promise<{ lifecycle: string; status: string }> {
  const rows = await db.query<{ lifecycle: string; status: string }>(
    "SELECT lifecycle, status FROM work_items WHERE id = ?",
    [id],
  );
  assert.ok(rows[0], `work item ${id} must exist`);
  // node:sqlite rows are null-prototype objects; copy to a plain object so
  // deepStrictEqual compares values, not prototypes.
  const row = rows[0]!;
  return { lifecycle: row.lifecycle, status: row.status };
}

test("finalizeWorkflowItem promotes lifecycle+status and writes a status row + event atomically", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db);
    await daemon.importWorkItems([workItem("t1")]);

    await daemon.finalizeWorkflowItem({
      workflowId: "wf_match",
      target: workItem("t1"),
      actor: "run_1",
      action: { promote: true, status: "FULL_MATCH" },
    });

    // Status row: precise form (wf, unit-of-target, target), run-time reason.
    const rows = await statusRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.workflow_id, "wf_match");
    assert.equal(rows[0]!.unit_id, "kyoshin/CGame");
    assert.equal(rows[0]!.target_id, "t1");
    assert.equal(rows[0]!.status, "FULL_MATCH");
    assert.equal(rows[0]!.actor, "run_1");
    assert.equal(rows[0]!.reason, "run-time");

    // Work item: promoted to accepted with the action's status.
    assert.deepEqual(await itemLifecycle(db, "t1"), {
      lifecycle: "accepted",
      status: "FULL_MATCH",
    });

    // Exactly one target-status event (null → FULL_MATCH), carrying from/to.
    const events = await eventRows(db);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "target-status");
    assert.equal(events[0]!.work_item_id, "t1");
    const data = JSON.parse(events[0]!.data) as Record<string, unknown>;
    assert.equal(data.workflowId, "wf_match");
    assert.equal(data.status, "FULL_MATCH");
    assert.equal(data.from, null);
    assert.equal(data.actor, "run_1");
    assert.match(String(data.updatedAt), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    db.close();
  }
});

test("a same-status second finalize replaces the row but emits no duplicate event", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db);
    await daemon.importWorkItems([workItem("t1")]);
    const input = {
      workflowId: "wf_match",
      target: workItem("t1"),
      actor: "run_1",
      action: { promote: true, status: "FULL_MATCH" },
    };

    await daemon.finalizeWorkflowItem(input);
    await daemon.finalizeWorkflowItem(input);

    // One status row (the second finalize UPSERTED the same row), one event
    // (seq 1 — no event on the same-status re-finalize).
    assert.equal((await statusRows(db)).length, 1);
    const events = await eventRows(db);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.seq, 1);

    // The lifecycle/status write still ran (idempotent, harmless).
    assert.deepEqual(await itemLifecycle(db, "t1"), {
      lifecycle: "accepted",
      status: "FULL_MATCH",
    });
  } finally {
    db.close();
  }
});

test("promote:false writes only the status row (no item write)", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db);
    await daemon.importWorkItems([workItem("t2")]);

    await daemon.finalizeWorkflowItem({
      workflowId: "wf_manual",
      target: workItem("t2"),
      actor: "manual",
      action: { promote: false },
    });

    // The status row lands with the ladder default (completionStatus
    // absent → "DONE"); the target-status event fires (null → DONE).
    const rows = await statusRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.target_id, "t2");
    assert.equal(rows[0]!.status, "DONE");
    assert.equal(rows[0]!.reason, "run-time");

    // No lifecycle/status change on the item.
    assert.deepEqual(await itemLifecycle(db, "t2"), {
      lifecycle: "pending",
      status: "NOT_STARTED",
    });
    const events = await eventRows(db);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "target-status");
  } finally {
    db.close();
  }
});

test("completionStatus threads through: promote without a status writes the workflow's completion status", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db);
    const item = { ...workItem("t3"), status: "CODE_MATCH" };
    await daemon.importWorkItems([item]);

    await daemon.finalizeWorkflowItem({
      workflowId: "wf_coalesce",
      target: item,
      actor: "run_2",
      action: { promote: true },
      completionStatus: "FULL_MATCH",
    });

    // Lifecycle promoted; item status untouched (COALESCE(?, status) with
    // NULL). The status row carries the threaded completionStatus.
    assert.deepEqual(await itemLifecycle(db, "t3"), {
      lifecycle: "accepted",
      status: "CODE_MATCH",
    });
    const rows = await statusRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "FULL_MATCH");
    const events = await eventRows(db);
    assert.equal(events.length, 1);
    assert.equal((JSON.parse(events[0]!.data) as Record<string, unknown>).status, "FULL_MATCH");
  } finally {
    db.close();
  }
});

test("{ status } alone sets only status: no lifecycle change, event on change", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db);
    await daemon.importWorkItems([workItem("t4")]);

    await daemon.finalizeWorkflowItem({
      workflowId: "wf_status",
      target: workItem("t4"),
      actor: "run_3",
      action: { status: "REVIEWED" },
    });

    assert.deepEqual(await itemLifecycle(db, "t4"), {
      lifecycle: "pending",
      status: "REVIEWED",
    });
    const rows = await statusRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "REVIEWED");
    // null → REVIEWED is a change: exactly one target-status event.
    const events = await eventRows(db);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "target-status");
    assert.equal((JSON.parse(events[0]!.data) as Record<string, unknown>).status, "REVIEWED");
  } finally {
    db.close();
  }
});

test("a status CHANGE re-finalize emits a new event (from → to); same-status does not", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db);
    await daemon.importWorkItems([workItem("t6")]);

    await daemon.finalizeWorkflowItem({
      workflowId: "wf_ladder",
      target: workItem("t6"),
      actor: "run_5",
      action: { promote: true, status: "CODE_MATCH" },
    });
    await daemon.finalizeWorkflowItem({
      workflowId: "wf_ladder",
      target: workItem("t6"),
      actor: "run_5",
      action: { promote: true, status: "FULL_MATCH" },
    });
    await daemon.finalizeWorkflowItem({
      workflowId: "wf_ladder",
      target: workItem("t6"),
      actor: "run_5",
      action: { promote: true, status: "FULL_MATCH" },
    });

    // Two events: null → CODE_MATCH and CODE_MATCH → FULL_MATCH. The
    // same-status third finalize emitted nothing.
    const events = await eventRows(db);
    assert.equal(events.length, 2);
    const statuses = events.map((e) => {
      const data = JSON.parse(e.data) as { from: string | null; status: string };
      return { from: data.from, status: data.status };
    });
    assert.deepEqual(statuses, [
      { from: null, status: "CODE_MATCH" },
      { from: "CODE_MATCH", status: "FULL_MATCH" },
    ]);
    assert.equal((await statusRows(db)).length, 1);
    assert.equal((await statusRows(db))[0]!.status, "FULL_MATCH");
  } finally {
    db.close();
  }
});

test("a throwing finalize rolls the whole transaction back (no row, no item write, no event)", async () => {
  const db = await openDb();
  try {
    const daemon = new StoreDaemon(db);
    await daemon.importWorkItems([workItem("t5")]);

    // An unserializable evidence payload throws inside the transaction —
    // after the status-row and item writes — and must roll them all back.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(
      daemon.finalizeWorkflowItem({
        workflowId: "wf_rollback",
        target: workItem("t5"),
        actor: "run_4",
        action: { promote: true, status: "FULL_MATCH", evidence: circular },
      }),
      /circular/i,
    );

    assert.deepEqual(await statusRows(db), []);
    assert.deepEqual(await eventRows(db), []);
    assert.deepEqual(await itemLifecycle(db, "t5"), {
      lifecycle: "pending",
      status: "NOT_STARTED",
    });
  } finally {
    db.close();
  }
});
