/**
 * Introspection agent tests (SPEC §17): listRuns/getRun/getEvents/getSpans
 * return rows from a memory store, getMetrics derives global + per-run
 * counts, getTranscript reads a worker's transcript artifact, suggestChange
 * appends a proposals row (and only that), and runAnalysis drives a
 * MockAgentRuntime session with the tools listed as function descriptions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSpec } from "../src/types.js";
import { MockAgentRuntime } from "../src/agent/mock.js";
import { EventStore } from "../src/core/events.js";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import {
  ANALYZE_AUTHOR,
  ANALYZE_TOOL_NAMES,
  AnalyzeTools,
  DEFAULT_ANALYZE_MODEL,
  GLOBAL_SCOPE,
  runAnalysis,
} from "../src/server/analyze.js";

const TS = "2025-05-01T00:00:00.000Z";

const SPEC: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 20,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

/** Fresh in-memory store with the canonical schema applied. */
async function openStore(): Promise<SqliteAdapter> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  return db;
}

/** Insert one `runs` row with the given overrides (defaults in place). */
async function insertRun(
  db: SqliteAdapter,
  over: Partial<{
    id: string;
    pipeline: string;
    adapter: string;
    model: string;
    status: string;
    budgetMicroUsd: number | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }> = {},
): Promise<void> {
  const row = {
    id: "r1",
    pipeline: "match",
    adapter: "fixture",
    model: "ds4-flash",
    status: "done",
    budgetMicroUsd: null,
    createdAt: TS,
    startedAt: TS,
    finishedAt: TS,
    ...over,
  };
  await db.execute(
    `INSERT INTO runs
       (id, pipeline, adapter, model, selector, status, pause_requested,
        budget_micro_usd, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, '{}', ?, 0, ?, ?, ?, ?)`,
    [
      row.id,
      row.pipeline,
      row.adapter,
      row.model,
      row.status,
      row.budgetMicroUsd,
      row.createdAt,
      row.startedAt,
      row.finishedAt,
    ],
  );
}

test("listRuns and getRun return run rows from the store", async () => {
  const db = await openStore();
  try {
    const tools = new AnalyzeTools(db);
    assert.deepEqual(await tools.listRuns(), []); // empty store
    assert.equal(await tools.getRun("missing"), null);

    await insertRun(db, { id: "r1", pipeline: "match", model: "ds4-flash", status: "done" });
    await insertRun(db, { id: "r2", pipeline: "cleanup", model: "ds4-flash", status: "running" });
    await insertRun(db, { id: "r3", pipeline: "match", model: "ds4-flash", status: "queued" });

    const all = await tools.listRuns();
    assert.deepEqual(all.map((r) => r.id), ["r1", "r2", "r3"]);
    assert.deepEqual(all.map((r) => r.status), ["done", "running", "queued"]);
    assert.equal(all[0]!.pipeline, "match");
    assert.equal(all[0]!.createdAt, TS);
    assert.equal(all[0]!.budgetMicroUsd, null);

    // Filter by single status, several statuses, pipeline, and model.
    assert.deepEqual((await tools.listRuns({ status: "done" })).map((r) => r.id), ["r1"]);
    assert.deepEqual(
      (await tools.listRuns({ status: ["queued", "done"] })).map((r) => r.id),
      ["r1", "r3"],
    );
    assert.deepEqual((await tools.listRuns({ pipeline: "cleanup" })).map((r) => r.id), ["r2"]);
    assert.deepEqual(
      (await tools.listRuns({ status: "running", model: "ds4-flash" })).map((r) => r.id),
      ["r2"],
    );
    assert.deepEqual(await tools.listRuns({ status: "failed" }), []);

    const run = await tools.getRun("r2");
    assert.equal(run!.status, "running");
    assert.equal(run!.pipeline, "cleanup");
    assert.equal(await tools.getRun("nope"), null);

    await assert.rejects(tools.listRuns({ status: 42 as unknown as string }), /status/);
    await assert.rejects(tools.listRuns({ pipeline: 7 as unknown as string }), /pipeline/);
  } finally {
    db.close();
  }
});

test("getEvents returns rows filtered by run, type, and seq cursor", async () => {
  const db = await openStore();
  try {
    const events = new EventStore(db);
    const tools = new AnalyzeTools(db);
    const s1 = await events.emit({ ts: TS, runId: "r1", type: "run.log", data: { n: 1 } });
    await events.emit({ ts: TS, runId: "r1", type: "run.log", data: { n: 2 } });
    await events.emit({
      ts: TS,
      runId: "r1",
      type: "verify.result",
      data: { verdict: "accepted" },
    });
    await events.emit({ ts: TS, runId: "r2", type: "run.log", data: { n: 9 } });

    // By run only.
    const r1 = await tools.getEvents({ runId: "r1" });
    assert.deepEqual(r1.map((e) => e.seq), [s1, s1 + 1, s1 + 2]);
    for (const e of r1) assert.equal(e.runId, "r1");

    // Type filter.
    const verified = await tools.getEvents({ runId: "r1", type: "verify.result" });
    assert.equal(verified.length, 1);
    assert.equal(verified[0]!.type, "verify.result");
    assert.deepEqual(verified[0]!.data, { verdict: "accepted" });

    // After cursor.
    const after = await tools.getEvents({ runId: "r1", after: s1 + 1 });
    assert.deepEqual(after.map((e) => e.seq), [s1 + 2]);

    // Combined filters + limit.
    const limited = await tools.getEvents({
      runId: "r1",
      type: "run.log",
      after: s1 - 1,
      limit: 1,
    });
    assert.deepEqual(limited.map((e) => e.seq), [s1]);

    // No filter: everything.
    assert.equal((await tools.getEvents({})).length, 4);

    assert.deepEqual(await tools.getEvents({ runId: "nope" }), []);
    await assert.rejects(tools.getEvents({ after: -1 }), /after/);
    await assert.rejects(tools.getEvents({ limit: 0 }), /limit/);
  } finally {
    db.close();
  }
});

test("getSpans returns span rows with parsed attrs", async () => {
  const db = await openStore();
  try {
    const tools = new AnalyzeTools(db);
    const attrs = { model: "ds4-flash", cost: 42, verdict: "accepted" };
    await db.execute(
      `INSERT INTO spans (id, run_id, parent_id, name, started_at, finished_at, prompt_id, attrs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "r1", null, "session", TS, TS, "p1", JSON.stringify(attrs)],
    );
    await db.execute(
      `INSERT INTO spans (id, run_id, parent_id, name, started_at, finished_at, prompt_id, attrs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "r1", "s1", "verify.round", TS, null, null, "{}"],
    );
    await db.execute(
      `INSERT INTO spans (id, run_id, parent_id, name, started_at, finished_at, prompt_id, attrs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s3", "r2", null, "session", TS, TS, null, "{}"],
    );

    const spans = await tools.getSpans("r1");
    assert.deepEqual(spans.map((s) => s.id), ["s1", "s2"]);
    assert.equal(spans[0]!.name, "session");
    assert.equal(spans[0]!.promptId, "p1");
    assert.deepEqual(spans[0]!.attrs, attrs);
    assert.equal(spans[1]!.parentId, "s1");
    assert.equal(spans[1]!.finishedAt, null);
    assert.deepEqual(spans[1]!.attrs, {});

    assert.deepEqual(await tools.getSpans("nope"), []);
  } finally {
    db.close();
  }
});

test("getMetrics derives global and per-run counts", async () => {
  const db = await openStore();
  try {
    const tools = new AnalyzeTools(db);
    await insertRun(db, { id: "r1", status: "done" });
    await insertRun(db, { id: "r2", status: "running" });
    await insertRun(db, { id: "r3", status: "queued" });
    await insertRun(db, { id: "r4", status: "failed" });
    await insertRun(db, { id: "r5", status: "cancelled" });

    const events = new EventStore(db);
    await events.emit({ ts: TS, runId: "r1", type: "run.log", data: {} });
    await events.emit({ ts: TS, runId: "r1", type: "run.log", data: {} });
    await db.execute(
      `INSERT INTO spans (id, run_id, name, started_at, attrs) VALUES (?, ?, ?, ?, ?)`,
      ["sp1", "r1", "session", TS, "{}"],
    );
    await db.execute(
      `INSERT INTO run_workers (run_id, seq, status) VALUES (?, ?, ?)`,
      ["r1", 0, "done"],
    );
    await db.execute(
      `INSERT INTO run_workers (run_id, seq, status) VALUES (?, ?, ?)`,
      ["r1", 1, "done"],
    );
    await db.execute(
      `INSERT INTO run_worker_items (run_id, worker_seq, work_item_id) VALUES (?, ?, ?)`,
      ["r1", 0, "wi_1"],
    );
    await db.execute(
      `INSERT INTO run_worker_items (run_id, worker_seq, work_item_id) VALUES (?, ?, ?)`,
      ["r1", 1, "wi_2"],
    );
    await db.execute(
      `INSERT INTO audit_log (id, ts, actor, action, run_id, cost_micro_usd, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["a1", TS, "tok", "run-create", "r1", 120, "{}"],
    );

    const global = await tools.getMetrics(GLOBAL_SCOPE);
    assert.equal(global.scope, "global");
    assert.equal(global.totalRuns, 5);
    assert.equal(global.activeRuns, 2); // queued + running
    assert.equal(global.doneRuns, 1);
    assert.equal(global.failedRuns, 1);
    assert.equal(global.cancelledRuns, 1);
    assert.equal(global.totalEvents, 2);
    assert.equal(global.totalSpans, 1);
    assert.equal(global.openProposals, 0);

    const run = await tools.getMetrics("r1");
    assert.equal(run.scope, "r1");
    assert.equal(run.runId, "r1");
    assert.equal(run.status, "done");
    assert.equal(run.pipeline, "match");
    assert.equal(run.events, 2);
    assert.equal(run.spans, 1);
    assert.equal(run.workers, 2);
    assert.equal(run.workItems, 2);
    assert.equal(run.costMicroUsd, 120);
    assert.equal(run.finishedAt, TS);

    assert.equal(await tools.getMetrics("nope"), null);
  } finally {
    db.close();
  }
});

test("getTranscript reads the worker's transcript artifact, else null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-analyze-"));
  const file = join(dir, "t1.txt");
  const file2 = join(dir, "t2.txt");
  writeFileSync(file, "worker 1 transcript content\n");
  writeFileSync(file2, "worker 2 transcript content\n");
  try {
    const db = await openStore();
    try {
      const tools = new AnalyzeTools(db);
      // worker 1: meta carries workerId; worker 2: meta carries worker_seq.
      await db.execute(
        `INSERT INTO artifacts (id, run_id, kind, path, meta, created_at)
         VALUES (?, ?, 'transcript', ?, ?, ?)`,
        ["art1", "r1", file, JSON.stringify({ workerId: 1 }), TS],
      );
      await db.execute(
        `INSERT INTO artifacts (id, run_id, kind, path, meta, created_at)
         VALUES (?, ?, 'transcript', ?, ?, ?)`,
        ["art2", "r1", file2, JSON.stringify({ worker_seq: 2 }), TS],
      );
      // A transcript whose file is missing degrades to null…
      await db.execute(
        `INSERT INTO artifacts (id, run_id, kind, path, meta, created_at)
         VALUES (?, ?, 'transcript', ?, ?, ?)`,
        ["art3", "r1", join(dir, "missing.txt"), JSON.stringify({ workerId: 3 }), TS],
      );
      // …and non-transcript artifacts are never returned.
      await db.execute(
        `INSERT INTO artifacts (id, run_id, kind, path, meta, created_at)
         VALUES (?, ?, 'snapshot', ?, ?, ?)`,
        ["art4", "r1", file, "{}", TS],
      );

      assert.equal(await tools.getTranscript("r1", 1), "worker 1 transcript content\n");
      assert.equal(await tools.getTranscript("r1", 2), "worker 2 transcript content\n");
      assert.equal(await tools.getTranscript("r1", 3), null); // file missing
      assert.equal(await tools.getTranscript("r1", 9), null); // no artifact for worker
      assert.equal(await tools.getTranscript("nope", 1), null); // no run artifacts
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("suggestChange appends a proposals row and returns its id", async () => {
  const db = await openStore();
  try {
    const tools = new AnalyzeTools(db);
    const id = await tools.suggestChange("re-run r1 with the cleanup pipeline");
    const rows = await db.query<{
      id: string;
      run_id: string | null;
      text: string;
      author: string;
      status: string;
    }>("SELECT id, run_id, text, author, status FROM proposals WHERE id = ?", [id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.text, "re-run r1 with the cleanup pipeline");
    assert.equal(rows[0]!.author, ANALYZE_AUTHOR);
    assert.equal(rows[0]!.status, "open");
    assert.equal(rows[0]!.run_id, null);

    // runId/author opts are honored; every call only appends.
    const id2 = await tools.suggestChange("cap the budget at 500 micro-USD", {
      runId: "r1",
      author: "human-review",
    });
    const row2 = (
      await db.query<{ run_id: string; author: string }>(
        "SELECT run_id, author FROM proposals WHERE id = ?",
        [id2],
      )
    )[0]!;
    assert.equal(row2.run_id, "r1");
    assert.equal(row2.author, "human-review");

    // The tool never touches work state: no runs row was created.
    assert.equal(await tools.getRun("r1"), null);
    const proposalCount = await db.query<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM proposals",
    );
    assert.equal(Number(proposalCount[0]!.n), 2);

    await assert.rejects(tools.suggestChange("   "), /non-empty/);
  } finally {
    db.close();
  }
});

test("runAnalysis drives a MockAgentRuntime session and returns the final text", async () => {
  const db = await openStore();
  try {
    const tools = new AnalyzeTools(db);
    const rt = new MockAgentRuntime({ [DEFAULT_ANALYZE_MODEL]: SPEC });
    const out = await runAnalysis(rt, tools, "RESPOND: r1 finished with 3 accepted items");
    assert.equal(out, "r1 finished with 3 accepted items");

    assert.equal(rt.calls.length, 1);
    const call = rt.calls[0]!;
    assert.equal(call.model, DEFAULT_ANALYZE_MODEL);
    // The tools are wired as function descriptions: the names ride the
    // session's tools list and the system prompt lists each one.
    assert.deepEqual(call.tools, ANALYZE_TOOL_NAMES);
    for (const name of ANALYZE_TOOL_NAMES) assert.ok(call.prompt.includes(name));
    assert.ok(/READ-ONLY/.test(call.prompt));
    assert.ok(call.prompt.includes("proposals"));
    assert.ok(call.prompt.includes("suggestChange(text"));

    // Model override.
    rt.register("custom", SPEC);
    const out2 = await runAnalysis(rt, tools, "RESPOND: ok", { model: "custom" });
    assert.equal(out2, "ok");
    assert.equal(rt.calls[1]!.model, "custom");
  } finally {
    db.close();
  }
});
