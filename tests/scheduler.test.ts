/**
 * M4 run scheduler tests (SPEC §5, §11, §16, §19 M4 row): `createRun` inserts
 * a queued `runs` row and starts it; `maxParallelRuns` caps concurrent
 * executions (two runs with cap 1 serialize); `cancel` stops runs
 * cooperatively (status lands on `cancelled`, never overwritten by done);
 * `pause`/`resume` are cooperative at agent-step boundaries and a paused run
 * frees its slot; `listRuns` reflects statuses; budget exceeds fail the run;
 * lifecycle events ride the StoreDaemon's event path when one is supplied;
 * `close()` cancels and drains.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime } from "../src/agent/runtime.js";
import type { ModelSpec, WorkItem } from "../src/types.js";
import { MockAgentRuntime, emptyUsage } from "../src/agent/mock.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import { StoreDaemon } from "../src/core/daemon.js";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { RunScheduler } from "../src/server/scheduler.js";

const FLASH: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 60,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

/** Minimal WorkItem fixture. */
function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    kind: "function",
    lifecycle: "pending",
    status: "NOT_STARTED",
    attempts: 0,
    exhausted: false,
    ready: true,
    meta: {},
    ...over,
  };
}

/** A promise plus its resolver (deterministic test gates). */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function openDb(): Promise<SqliteAdapter> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  return db;
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

/** A runtime whose sessions' prompts wait on a gate (blocks the agent step). */
function blockingRuntime(gate: Deferred): AgentRuntime {
  return {
    resolveModel: async () => FLASH,
    createSession: async () => ({
      prompt: async () => {
        await gate.promise;
        return { finalText: "ok", usage: emptyUsage() };
      },
    }),
  };
}

/** Register a pipeline with `agentSteps` bare agent steps over one item. */
function registerBlockingPipeline(
  engine: PipelineEngine,
  agentSteps: number,
  id = "block",
): void {
  engine.registerPipeline({
    id,
    adapter: "test",
    plan: async () => [item("a")],
    steps: Array.from({ length: agentSteps }, () => ({
      kind: "agent" as const,
      prompt: { template: "match" },
    })),
  });
}

// ---------------------------------------------------------------------------
// createRun → done
// ---------------------------------------------------------------------------

test("createRun inserts a queued run and transitions it to done", async () => {
  const db = await openDb();
  try {
    const rt = new MockAgentRuntime({ flash: FLASH });
    const engine = new PipelineEngine();
    engine.registerPipeline({
      id: "p",
      adapter: "test",
      plan: async () => [item("a"), item("b")],
      steps: [
        { kind: "agent", prompt: { template: "match" } },
        { kind: "agent", prompt: { template: "match" } },
      ],
    });
    const sched = new RunScheduler({ store: db, engine, maxParallelRuns: 1, runtime: rt });

    const id = await sched.createRun({ pipeline: "p", model: "flash" });
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);

    await waitFor(
      async () => (await sched.getRun(id))?.status === "done",
      5_000,
      "run reaches done",
    );

    const rec = (await sched.getRun(id))!;
    assert.equal(rec.pipeline, "p");
    assert.equal(rec.model, "flash");
    assert.equal(rec.status, "done");
    assert.ok(rec.createdAt.length > 0);
    assert.ok(rec.startedAt !== null, "started_at set on start");
    assert.ok(rec.finishedAt !== null, "finished_at set on completion");
    assert.ok(
      new Date(rec.finishedAt!).getTime() >= new Date(rec.startedAt!).getTime(),
    );
    assert.equal(rec.budgetMicroUsd, null);
    // No selector given: the row stores '{}', which parses to an empty Selector.
    assert.deepEqual(rec.selector, {});
    // Both agent steps ran through the mock runtime.
    assert.equal(rt.calls.length, 2);
    assert.deepEqual(
      rt.calls.map((c) => c.model),
      ["flash", "flash"],
    );

    // The store row itself matches the record.
    const row = (
      await db.query<{ status: string; pipeline: string }>(
        "SELECT status, pipeline FROM runs WHERE id = ?",
        [id],
      )
    )[0]!;
    assert.equal(row.status, "done");
    assert.equal(row.pipeline, "p");
    await sched.close();
  } finally {
    db.close();
  }
});

test("getRun returns null for an unknown id", async () => {
  const db = await openDb();
  try {
    const sched = new RunScheduler({
      store: db,
      engine: new PipelineEngine(),
      maxParallelRuns: 1,
    });
    assert.equal(await sched.getRun("nope"), null);
    await sched.close();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// maxParallelRuns serialization
// ---------------------------------------------------------------------------

test("maxParallelRuns=1 serializes two runs: the second stays queued until the first finishes", async () => {
  const db = await openDb();
  try {
    const gate = deferred();
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 1);
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: blockingRuntime(gate),
    });

    const a = await sched.createRun({ pipeline: "block", model: "flash" });
    const b = await sched.createRun({ pipeline: "block", model: "flash" });

    // A holds the only slot and is in flight; B must be queued, not started.
    await waitFor(
      async () => (await sched.getRun(a))?.status === "running",
      5_000,
      "run A starts",
    );
    const bWhileA = (await sched.getRun(b))!;
    assert.equal(bWhileA.status, "queued");
    assert.equal(bWhileA.startedAt, null);

    // Free A: it completes, then B starts and completes in turn.
    gate.resolve();
    await waitFor(
      async () => (await sched.getRun(a))?.status === "done",
      5_000,
      "run A done",
    );
    await waitFor(
      async () => (await sched.getRun(b))?.status === "done",
      5_000,
      "run B done after A freed the slot",
    );
    const bAfter = (await sched.getRun(b))!;
    const aAfter = (await sched.getRun(a))!;
    assert.ok(bAfter.startedAt !== null);
    // B could only start once A was finished.
    assert.ok(
      (bAfter.startedAt ?? "").localeCompare(aAfter.finishedAt ?? "") >= 0,
      "B must not start before A finished",
    );
    await sched.close();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test("cancel sets status cancelled; a running run stops at the next step boundary", async () => {
  const db = await openDb();
  try {
    const gate = deferred();
    const engine = new PipelineEngine();
    // Two agent steps: cancel lands while step 1 is in flight; step 2's
    // session-creation boundary is where the run must abort.
    registerBlockingPipeline(engine, 2);
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: blockingRuntime(gate),
    });

    const id = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(id))?.status === "running",
      5_000,
      "run running",
    );

    await sched.cancel(id);
    assert.equal((await sched.getRun(id))!.status, "cancelled");

    // Free the in-flight turn: the run must abort at the next boundary, not
    // complete — a cancelled run never lands on done/failed.
    gate.resolve();
    await waitFor(
      async () => (await sched.getRun(id))?.finishedAt !== null,
      5_000,
      "execution settles",
    );
    const rec = (await sched.getRun(id))!;
    assert.equal(rec.status, "cancelled");
    assert.ok(rec.finishedAt !== null, "finished_at recorded when the run stopped");
    await sched.close();
  } finally {
    db.close();
  }
});

test("cancel of a queued run: it never starts", async () => {
  const db = await openDb();
  try {
    const gate = deferred();
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 1);
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: blockingRuntime(gate),
    });

    const a = await sched.createRun({ pipeline: "block", model: "flash" });
    const b = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(a))?.status === "running",
      5_000,
      "run A starts (holds the only slot)",
    );

    await sched.cancel(b);
    assert.equal((await sched.getRun(b))!.status, "cancelled");

    // A completes; B must remain cancelled and never have started.
    gate.resolve();
    await waitFor(
      async () => (await sched.getRun(a))?.status === "done",
      5_000,
      "run A done",
    );
    const bAfter = (await sched.getRun(b))!;
    assert.equal(bAfter.status, "cancelled");
    assert.equal(bAfter.startedAt, null, "a cancelled queued run never starts");
    await sched.close();
  } finally {
    db.close();
  }
});

test("cancel is idempotent on a terminal run", async () => {
  const db = await openDb();
  try {
    const engine = new PipelineEngine();
    engine.registerPipeline({
      id: "p",
      adapter: "test",
      plan: async () => [],
      steps: [],
    });
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: new MockAgentRuntime({ flash: FLASH }),
    });
    const id = await sched.createRun({ pipeline: "p", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(id))?.status === "done",
      5_000,
      "empty pipeline finishes",
    );
    await sched.cancel(id); // no-op: already done
    assert.equal((await sched.getRun(id))!.status, "done");
    await sched.close();
  } finally {
    db.close();
  }
});

test("cancel of a queued-then-resumed run: it ends cancelled, never running", async () => {
  const db = await openDb();
  try {
    const gate = deferred();
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 1);
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: blockingRuntime(gate),
    });

    const a = await sched.createRun({ pipeline: "block", model: "flash" });
    const b = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(a))?.status === "running",
      5_000,
      "run A starts (holds the only slot)",
    );

    // Park the queued run, then resume it: it is startable again but the
    // pump cannot start it (A holds the only slot).
    await sched.pause(b);
    assert.equal((await sched.getRun(b))!.status, "paused");
    await sched.resume(b);
    assert.equal((await sched.getRun(b))!.status, "queued");

    // Cancel the queued-then-resumed run: it must never start, even after
    // A finishes and frees the slot.
    await sched.cancel(b);
    assert.equal((await sched.getRun(b))!.status, "cancelled");
    gate.resolve();
    await waitFor(
      async () => (await sched.getRun(a))?.status === "done",
      5_000,
      "run A done",
    );
    const bAfter = (await sched.getRun(b))!;
    assert.equal(bAfter.status, "cancelled");
    assert.equal(bAfter.startedAt, null, "a cancelled queued-then-resumed run never starts");
    const running = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runs WHERE status = 'running'",
    );
    assert.equal(Number(running[0]!.n), 0, "no phantom running rows");
    await sched.close();
  } finally {
    db.close();
  }
});

/** A gate that can be re-armed so a SECOND run can block on a fresh gate. */
function rearmableGate(): { gate: Deferred; arm: () => void } {
  let gate = deferred();
  return {
    get gate() {
      return gate;
    },
    arm: () => {
      gate = deferred();
    },
  };
}

test("cancel while a paused run re-acquires its slot: it ends cancelled, never running/done", async () => {
  const db = await openDb();
  try {
    const rg = rearmableGate();
    const rt: AgentRuntime = {
      resolveModel: async () => FLASH,
      createSession: async () => ({
        prompt: async () => {
          await rg.gate.promise; // capture the CURRENT gate at prompt time
          return { finalText: "ok", usage: emptyUsage() };
        },
      }),
    };
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 2); // two agent steps for run A
    const sched = new RunScheduler({ store: db, engine, maxParallelRuns: 1, runtime: rt });

    const a = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(a))?.status === "running",
      5_000,
      "A running",
    );
    await sched.pause(a);
    rg.gate.resolve(); // step 1 completes; step 2's boundary → A yields (paused), frees the slot
    await waitFor(
      async () => (await sched.getRun(a))?.status === "paused",
      5_000,
      "A paused at a boundary",
    );
    rg.arm(); // the next prompt blocks on a fresh gate
    const b = await sched.createRun({ pipeline: "block", model: "flash" }); // takes the slot, blocks
    await waitFor(
      async () => (await sched.getRun(b))?.status === "running",
      5_000,
      "B running (holds the slot)",
    );

    // Resume A: it wakes and waits on the SEMAPHORE (B holds the only slot).
    await sched.resume(a);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let A reach the semaphore wait

    // Cancel A while it is re-acquiring: the row is cancelled; when B frees
    // the slot, A's acquire resolves but A must abort WITHOUT marking the
    // row running again (M4 cancel/close race fix — the old code flipped the
    // cancelled row back to 'running').
    await sched.cancel(a);
    assert.equal((await sched.getRun(a))!.status, "cancelled");
    rg.gate.resolve(); // B completes → releases the slot → A's acquire resolves
    await waitFor(
      async () => (await sched.getRun(a))?.finishedAt !== null,
      5_000,
      "A's execution settles",
    );
    const aRec = (await sched.getRun(a))!;
    assert.equal(aRec.status, "cancelled", "cancelled run never flips back to running/done");
    const running = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runs WHERE status = 'running'",
    );
    assert.equal(Number(running[0]!.n), 0, "no phantom running rows");
    await sched.close();
  } finally {
    db.close();
  }
});

test("close() while a paused run re-acquires its slot leaves no phantom running rows", async () => {
  const db = await openDb();
  try {
    const rg = rearmableGate();
    const rt: AgentRuntime = {
      resolveModel: async () => FLASH,
      createSession: async () => ({
        prompt: async () => {
          await rg.gate.promise;
          return { finalText: "ok", usage: emptyUsage() };
        },
      }),
    };
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 2);
    const sched = new RunScheduler({ store: db, engine, maxParallelRuns: 1, runtime: rt });

    const a = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(a))?.status === "running",
      5_000,
      "A running",
    );
    await sched.pause(a);
    rg.gate.resolve();
    await waitFor(
      async () => (await sched.getRun(a))?.status === "paused",
      5_000,
      "A paused",
    );
    rg.arm();
    const b = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(b))?.status === "running",
      5_000,
      "B running (holds the slot)",
    );
    await sched.resume(a); // A wakes and blocks on the semaphore
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Close while A is re-acquiring: the semaphore close resolves A's wait
    // WITHOUT granting (sentinel); A must abort without markRunning.
    const closing = sched.close(); // closed=true + both rows cancelled synchronously
    rg.gate.resolve(); // B finishes its turn; A's acquire resolves (granted=false)
    await closing;

    assert.equal((await sched.getRun(a))!.status, "cancelled");
    assert.equal((await sched.getRun(b))!.status, "cancelled");
    const running = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runs WHERE status = 'running'",
    );
    assert.equal(Number(running[0]!.n), 0, "close() leaves no phantom running rows");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// pause / resume (cooperative, at agent-step boundaries)
// ---------------------------------------------------------------------------

test("pause is cooperative: the run yields at the next step boundary and resume continues it", async () => {
  const db = await openDb();
  try {
    const gate = deferred();
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 3);
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: blockingRuntime(gate),
    });

    const id = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(id))?.status === "running",
      5_000,
      "run running",
    );

    // Request pause while step 1 is in flight: the run does NOT stop yet.
    await sched.pause(id);
    assert.equal((await sched.getRun(id))!.status, "running");
    const pausedFlag = (
      await db.query<{ pause_requested: number }>(
        "SELECT pause_requested FROM runs WHERE id = ?",
        [id],
      )
    )[0]!.pause_requested;
    assert.equal(pausedFlag, 1);

    // Step 1 finishes; step 2's boundary sees the flag and the run yields.
    gate.resolve();
    await waitFor(
      async () => (await sched.getRun(id))?.status === "paused",
      5_000,
      "run yields into paused at the step boundary",
    );

    // A paused run freed its slot: a new run can start while it waits.
    const b = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(b))?.status === "done",
      5_000,
      "a new run completes while the first is paused",
    );
    assert.equal((await sched.getRun(id))!.status, "paused", "paused run still paused");

    // Resume: the run re-acquires a slot and finishes its remaining steps.
    await sched.resume(id);
    await waitFor(
      async () => (await sched.getRun(id))?.status === "done",
      5_000,
      "resumed run completes",
    );
    const rec = (await sched.getRun(id))!;
    assert.equal(rec.status, "done");
    assert.ok(rec.startedAt !== null, "started_at preserved across pause/resume");
    const flagAfter = (
      await db.query<{ pause_requested: number }>(
        "SELECT pause_requested FROM runs WHERE id = ?",
        [id],
      )
    )[0]!.pause_requested;
    assert.equal(flagAfter, 0);
    assert.equal((await sched.getRun(b))!.status, "done");
    await sched.close();
  } finally {
    db.close();
  }
});

test("pause of a queued run parks it at the gate; resume makes it startable", async () => {
  const db = await openDb();
  try {
    const gate = deferred();
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 1);
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: blockingRuntime(gate),
    });

    const a = await sched.createRun({ pipeline: "block", model: "flash" });
    const b = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(a))?.status === "running",
      5_000,
      "run A starts (holds the only slot)",
    );

    // Pause the QUEUED run: it parks (status paused) and never starts.
    await sched.pause(b);
    assert.equal((await sched.getRun(b))!.status, "paused");

    // A finishes, but the parked run does not take the freed slot.
    gate.resolve();
    await waitFor(
      async () => (await sched.getRun(a))?.status === "done",
      5_000,
      "run A done",
    );
    assert.equal((await sched.getRun(b))!.status, "paused");
    assert.equal((await sched.getRun(b))!.startedAt, null);

    // Resume: back to queued, then it starts and completes.
    await sched.resume(b);
    await waitFor(
      async () => (await sched.getRun(b))?.status === "done",
      5_000,
      "resumed queued run completes",
    );
    assert.equal((await sched.getRun(b))!.startedAt !== null, true);
    await sched.close();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// listRuns
// ---------------------------------------------------------------------------

test("listRuns reflects statuses across the lifecycle", async () => {
  const db = await openDb();
  try {
    const gate = deferred();
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 1);
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: blockingRuntime(gate),
    });

    const done = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(done))?.status === "running",
      5_000,
      "done-bound run starts",
    );
    const cancelled = await sched.createRun({ pipeline: "block", model: "flash" });
    await sched.cancel(cancelled);
    gate.resolve();
    await waitFor(
      async () => (await sched.getRun(done))?.status === "done",
      5_000,
      "run reaches done",
    );

    const runs = await sched.listRuns();
    assert.equal(runs.length, 2);
    const byId = new Map(runs.map((r) => [r.id, r]));
    assert.equal(byId.get(done)!.status, "done");
    assert.equal(byId.get(done)!.finishedAt !== null, true);
    assert.equal(byId.get(cancelled)!.status, "cancelled");
    assert.equal(byId.get(cancelled)!.startedAt, null);
    await sched.close();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// budget passthrough
// ---------------------------------------------------------------------------

test("an exceeded budget fails the run before any agent session", async () => {
  const db = await openDb();
  try {
    const rt = new MockAgentRuntime({ flash: FLASH });
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 1, "p");
    const sched = new RunScheduler({ store: db, engine, maxParallelRuns: 1, runtime: rt });

    // 100µ$ is far below the default 100k+20k-token turn estimate (~80kµ$ on
    // FLASH's per-M rates): the pre-step affordability check aborts the run.
    const id = await sched.createRun({
      pipeline: "p",
      model: "flash",
      budgetMicroUsd: 100,
    });
    await waitFor(
      async () => (await sched.getRun(id))?.status === "failed",
      5_000,
      "run fails on budget",
    );
    const rec = (await sched.getRun(id))!;
    assert.equal(rec.status, "failed");
    assert.equal(rec.budgetMicroUsd, 100);
    assert.ok(rec.finishedAt !== null);
    assert.equal(rt.calls.length, 0, "no session was created before the abort");
    await sched.close();
  } finally {
    db.close();
  }
});

test("createRun validates its spec", async () => {
  const db = await openDb();
  try {
    const sched = new RunScheduler({
      store: db,
      engine: new PipelineEngine(),
      maxParallelRuns: 1,
    });
    await assert.rejects(
      sched.createRun({ pipeline: "", model: "flash" }),
      /pipeline must be a non-empty string/,
    );
    await assert.rejects(
      sched.createRun({ pipeline: "p", model: "" }),
      /model must be a non-empty string/,
    );
    await assert.rejects(
      sched.createRun({ pipeline: "p", model: "flash", budgetMicroUsd: -1 }),
      /budgetMicroUsd must be a non-negative number/,
    );
    await sched.close();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// events through the StoreDaemon
// ---------------------------------------------------------------------------

test("lifecycle events ride the StoreDaemon's event path when one is supplied", async () => {
  const db = await openDb();
  const daemon = new StoreDaemon(db);
  try {
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 1, "p");
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: new MockAgentRuntime({ flash: FLASH }),
      daemon,
    });

    const id = await sched.createRun({ pipeline: "p", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(id))?.status === "done",
      5_000,
      "run done",
    );
    // EventStore micro-batches (10ms window): poll until the batch flushes.
    await waitFor(
      async () => {
        const rows = await db.query<{ type: string }>(
          "SELECT type FROM events WHERE run_id = ?",
          [id],
        );
        const types = rows.map((r) => r.type);
        return (
          types.includes("run-created") &&
          types.includes("run-start") &&
          types.includes("run-done")
        );
      },
      5_000,
      "run-created/run-start/run-done events flushed",
    );
    await sched.close();
  } finally {
    await daemon.close();
    db.close();
  }
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

test("close() cancels non-terminal runs, drains, and rejects new work", async () => {
  const db = await openDb();
  try {
    const gate = deferred();
    const engine = new PipelineEngine();
    registerBlockingPipeline(engine, 2);
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: blockingRuntime(gate),
    });

    const id = await sched.createRun({ pipeline: "block", model: "flash" });
    await waitFor(
      async () => (await sched.getRun(id))?.status === "running",
      5_000,
      "run running",
    );
    await sched.pause(id);
    gate.resolve();
    await waitFor(
      async () => (await sched.getRun(id))?.status === "paused",
      5_000,
      "run paused at a boundary",
    );

    // Close with a paused run in flight: it is cancelled and close resolves
    // without hanging on the resume waiter.
    await sched.close();
    const rec = (await sched.getRun(id))!;
    assert.equal(rec.status, "cancelled");
    assert.ok(rec.finishedAt !== null, "stopped execution records finished_at");

    // New work is rejected; reads still work.
    await assert.rejects(
      sched.createRun({ pipeline: "block", model: "flash" }),
      /closed/,
    );
    assert.equal(await sched.getRun(id).then((r) => r?.status), "cancelled");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// restart recovery (SPEC §11)
// ---------------------------------------------------------------------------

test("scheduler start re-pauses stale running rows and re-enqueues stale queued rows", async () => {
  const db = await openDb();
  try {
    // Rows left by a crashed scheduler: a stale 'running' row (no live
    // execution in THIS process) and a stale 'queued' row that never
    // started. A terminal row must be left alone.
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO runs
         (id, pipeline, adapter, model, selector, status, pause_requested,
          budget_micro_usd, created_at, started_at, finished_at)
       VALUES (?, 'p', 'test', 'flash', '{}', 'running', 0, NULL, ?, ?, NULL)`,
      ["stale-running", now, now],
    );
    await db.execute(
      `INSERT INTO runs
         (id, pipeline, adapter, model, selector, status, pause_requested,
          budget_micro_usd, created_at, started_at, finished_at)
       VALUES (?, 'p', 'test', 'flash', '{}', 'queued', 0, NULL, ?, NULL, NULL)`,
      ["stale-queued", now],
    );
    await db.execute(
      `INSERT INTO runs
         (id, pipeline, adapter, model, selector, status, pause_requested,
          budget_micro_usd, created_at, started_at, finished_at)
       VALUES (?, 'p', 'test', 'flash', '{}', 'done', 0, NULL, ?, ?, ?)`,
      ["stale-done", now, now, now],
    );

    const engine = new PipelineEngine();
    engine.registerPipeline({
      id: "p",
      adapter: "test",
      plan: async () => [],
      steps: [],
    });
    const sched = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: new MockAgentRuntime({ flash: FLASH }),
    });

    // Start recovery: the stale 'running' row is re-paused (the operator
    // resumes it); the stale 'queued' row is re-enqueued and, with a free
    // slot, starts and completes (spec reconstructed from the row).
    await waitFor(
      async () => (await sched.getRun("stale-running"))?.status === "paused",
      5_000,
      "stale running row re-paused on start",
    );
    await waitFor(
      async () => (await sched.getRun("stale-queued"))?.status === "done",
      5_000,
      "stale queued row re-enqueued and completed",
    );
    assert.equal((await sched.getRun("stale-done"))!.status, "done", "terminal rows untouched");

    // resume() recreates the execution of the recovered paused run (SPEC §11
    // restart semantics) and it completes.
    await sched.resume("stale-running");
    await waitFor(
      async () => (await sched.getRun("stale-running"))?.status === "done",
      5_000,
      "recovered run resumes to done",
    );
    const rec = (await sched.getRun("stale-running"))!;
    assert.ok(rec.startedAt !== null, "resumed run starts and records started_at");
    await sched.close();
  } finally {
    db.close();
  }
});
