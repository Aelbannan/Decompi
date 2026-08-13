/**
 * StoreDaemon.finalizeWorkflowItem tests (SPEC §5.3): the single-transaction
 * completion write — precise completion row (insert-or-ignore) + the
 * `CompletionAction` write on `work_items` + a `target-accepted` event,
 * committed together. Covers: promote (lifecycle+status+row+event),
 * idempotent re-finalize (no duplicate event), `promote:false` (row only),
 * COALESCE status retention, `{status}`-only writes, and whole-transaction
 * rollback when the event payload cannot be serialized.
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

interface CompletionRow {
  workflow_id: string;
  unit_id: string;
  target_id: string;
  actor: string;
  reason: string | null;
}

async function completionRows(db: SqliteAdapter): Promise<CompletionRow[]> {
  return db.query<CompletionRow>(
    "SELECT workflow_id, unit_id, target_id, actor, reason FROM workflow_completions ORDER BY id",
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

test("finalizeWorkflowItem promotes lifecycle+status and writes a completion row + event atomically", async () => {
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

    // Completion row: precise form (wf, unit-of-target, target), run-time reason.
    const completions = await completionRows(db);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.workflow_id, "wf_match");
    assert.equal(completions[0]!.unit_id, "kyoshin/CGame");
    assert.equal(completions[0]!.target_id, "t1");
    assert.equal(completions[0]!.actor, "run_1");
    assert.equal(completions[0]!.reason, "run-time");

    // Work item: promoted to accepted with the action's status.
    assert.deepEqual(await itemLifecycle(db, "t1"), {
      lifecycle: "accepted",
      status: "FULL_MATCH",
    });

    // Exactly one target-accepted event, carrying workflow + status.
    const events = await eventRows(db);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "target-accepted");
    assert.equal(events[0]!.work_item_id, "t1");
    const data = JSON.parse(events[0]!.data) as Record<string, unknown>;
    assert.equal(data.workflowId, "wf_match");
    assert.equal(data.status, "FULL_MATCH");
    assert.equal(data.actor, "run_1");
    assert.match(String(data.completedAt), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    db.close();
  }
});

test("a second finalize is idempotent: no duplicate event, single completion row, item write still applies", async () => {
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

    // One completion row, one event (seq 1 — no re-assignment on re-finalize).
    assert.equal((await completionRows(db)).length, 1);
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

test("promote:false writes only the completion row (no item write, no event)", async () => {
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

    const completions = await completionRows(db);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.target_id, "t2");
    assert.equal(completions[0]!.reason, "run-time");

    // No lifecycle/status change, no event.
    assert.deepEqual(await itemLifecycle(db, "t2"), {
      lifecycle: "pending",
      status: "NOT_STARTED",
    });
    assert.deepEqual(await eventRows(db), []);
  } finally {
    db.close();
  }
});

test("promote without a status keeps the current status (COALESCE)", async () => {
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
    });

    // Lifecycle promoted; status untouched (COALESCE(?, status) with NULL).
    assert.deepEqual(await itemLifecycle(db, "t3"), {
      lifecycle: "accepted",
      status: "CODE_MATCH",
    });
    const events = await eventRows(db);
    assert.equal(events.length, 1);
    assert.equal((JSON.parse(events[0]!.data) as Record<string, unknown>).status, undefined);
  } finally {
    db.close();
  }
});

test("{ status } alone sets only status: no lifecycle change, no event", async () => {
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
    assert.equal((await completionRows(db)).length, 1);
    assert.deepEqual(await eventRows(db), []);
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
    // after the completion-row and item writes — and must roll them all back.
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

    assert.deepEqual(await completionRows(db), []);
    assert.deepEqual(await eventRows(db), []);
    assert.deepEqual(await itemLifecycle(db, "t5"), {
      lifecycle: "pending",
      status: "NOT_STARTED",
    });
  } finally {
    db.close();
  }
});
