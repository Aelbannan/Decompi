/**
 * M5 serve cut-over wiring tests: the serve stack assembles the full
 * workflow runtime —
 *
 *  (a) a workflow compiled through the facade with a `WorkflowCompletionStore`
 *      plans OUT completed targets (target-scoped AND unit-scoped rows), so
 *      `plan()` returns only the rest;
 *  (b) a workflow compiled with the adapter's `registerHelpers` registry gets
 *      a MATERIALIZED `ctx.helpers` in reprompt — built-ins plus the real
 *      xenoblade helpers are callable, via the pipeline-carried registry
 *      default (no `RunContext.helpers` needed);
 *  (c) the scheduler threads `completions` + `helpers` into a real run:
 *      reprompt sees the materialized helpers, and accepted items record
 *      precise completion rows through the engine's default finalize — the
 *      loop closes (accept → complete → later plan skips).
 *
 * Uses a memory SqliteAdapter + MockAgentRuntime — no live xenoblade repo.
 * Registering the adapter helpers touches no filesystem; only INVOKING a
 * helper would resolve the repo, and no test invokes one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MockAgentRuntime } from "../src/agent/mock.js";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import { RunScheduler } from "../src/server/scheduler.js";
import { WorkItemRepo } from "../src/target/work-item.js";
import type { ModelSpec, WorkItem } from "../src/types.js";
import { WorkflowCompletionStore } from "../src/workflow/completions.js";
import { Decompi } from "../src/workflow/facade.js";
import { HelperRegistry } from "../src/workflow/helpers.js";
import { Workflow } from "../src/workflow/types.js";
import { registerHelpers } from "../adapters/xenoblade/workflow.js";

const FLASH: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 60,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

/** A `function`-kind work item fixture (unitId defaulted like targets.json). */
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

async function openDb(): Promise<SqliteAdapter> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  return db;
}

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

/** A stub scheduler: the facade only needs `createRun` for `addWorkflow`. */
function stubScheduler(result = "stub-run") {
  return { createRun: async (): Promise<string> => result };
}

// ---------------------------------------------------------------------------
// (a) plan() subtracts completed targets (target-scoped + unit-scoped)
// ---------------------------------------------------------------------------

test("facade-compiled plan() skips completed targets (target-scoped and unit-scoped rows)", async () => {
  const db = await openDb();
  try {
    const completions = new WorkflowCompletionStore(db);
    const engine = new PipelineEngine();
    Decompi.configure({ engine, scheduler: stubScheduler(), completions });

    // What the compiled plan actually handed the run (startPrompt input).
    let planned: string[] = [];
    const wf = new Workflow({
      id: "wiring-plan",
      accepts: "function",
      startPrompt: async (targets) => {
        planned = targets.map((t) => t.id);
        return "p";
      },
      reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
    });
    Decompi.addWorkflow(wf);

    const t1 = item("t1", { unitId: "u1" });
    const t2 = item("t2", { unitId: "u1" });
    const t3 = item("t3", { unitId: "u2" });
    // t1: target-scoped completion row. t3: unit-scoped row (covers u2).
    await completions.complete({ workflowId: "wiring-plan", targetId: "t1", actor: "manual" });
    await completions.complete({ workflowId: "wiring-plan", unitId: "u2", actor: "manual" });

    const out = await engine.runPipeline("wiring-plan", {
      runtime: new MockAgentRuntime({ flash: FLASH }),
      defaultModel: "flash",
      select: async () => [t1, t2, t3],
      finalize: async () => {},
    });

    // plan() subtracted the completed t1 (target row) AND t3 (unit row):
    // only t2 reached the run.
    assert.deepEqual(planned, ["t2"]);
    assert.deepEqual(
      out.accepted.map((i) => i.id),
      ["t2"],
    );
    assert.deepEqual(out.rejected, []);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// (b) ctx.helpers is materialized (pipeline-carried registry default)
// ---------------------------------------------------------------------------

test("compiled workflow reprompt gets a materialized ctx.helpers (adapter helpers + callable probe)", async () => {
  const db = await openDb();
  try {
    // The adapter's REAL helpers (registering touches no repo) plus a probe
    // we can actually invoke without a live checkout.
    const registry = new HelperRegistry();
    registerHelpers(registry);
    registry.register("probe", () => "probe-ok");

    const engine = new PipelineEngine();
    Decompi.configure({
      engine,
      scheduler: stubScheduler(),
      completions: new WorkflowCompletionStore(db),
      helpers: registry,
    });

    const seen: Record<string, string> = {};
    const wf = new Workflow({
      id: "wiring-helpers",
      accepts: "function",
      startPrompt: async () => "p",
      reprompt: async (targets, ctx) => {
        // Built-ins materialized (not a cast hole).
        seen.log = typeof ctx.helpers.log;
        seen.select = typeof ctx.helpers.select;
        // The adapter's registered helpers are present (callable; invoking
        // them would touch the repo, so we only assert callability).
        seen.getFunctionAsm = typeof ctx.helpers.getFunctionAsm;
        seen.runBatchCycle = typeof ctx.helpers.runBatchCycle;
        seen.structLayout = typeof ctx.helpers.structLayout;
        // A registered helper is actually callable end-to-end.
        seen.probe = await (
          ctx.helpers as WorkflowHelpersWithProbe
        ).probe();
        return { accepted: targets, rejected: [] };
      },
    });
    Decompi.addWorkflow(wf);

    // NO RunContext.helpers: the registry compiled onto the pipeline by
    // addWorkflow is the run default.
    await engine.runPipeline("wiring-helpers", {
      runtime: new MockAgentRuntime({ flash: FLASH }),
      defaultModel: "flash",
      select: async () => [item("h1")],
      finalize: async () => {},
    });

    assert.deepEqual(seen, {
      log: "function",
      select: "function",
      getFunctionAsm: "function",
      runBatchCycle: "function",
      structLayout: "function",
      probe: "probe-ok",
    });
  } finally {
    db.close();
  }
});

// The `probe` helper is not part of the augmented WorkflowHelpers surface.
interface WorkflowHelpersWithProbe {
  probe(): string;
}

// ---------------------------------------------------------------------------
// (c) scheduler threads completions + helpers into a real run
// ---------------------------------------------------------------------------

test("scheduler threads completions + helpers into a real run (accepted items record completion rows)", async () => {
  const db = await openDb();
  const completions = new WorkflowCompletionStore(db);
  const registry = new HelperRegistry();
  registerHelpers(registry);
  const engine = new PipelineEngine();
  const rt = new MockAgentRuntime({ flash: FLASH });
  let scheduler: RunScheduler | undefined;
  try {
    // The serve wiring shape: the SAME completions store + helper registry
    // go to BOTH the scheduler and the facade.
    scheduler = new RunScheduler({
      store: db,
      engine,
      maxParallelRuns: 1,
      runtime: rt,
      completions,
      helpers: registry,
    });
    Decompi.configure({ engine, scheduler, completions, helpers: registry });

    const seen: Record<string, string> = {};
    const wf = new Workflow({
      id: "wiring-run",
      accepts: "function",
      startPrompt: async (targets) => `targets: ${targets.map((t) => t.id).join(",")}`,
      reprompt: async (targets, ctx) => {
        seen.log = typeof ctx.helpers.log;
        seen.getFunctionAsm = typeof ctx.helpers.getFunctionAsm;
        return { accepted: targets, rejected: [] };
      },
    });
    Decompi.addWorkflow(wf);

    // Seed the store the run's store-backed plan select reads.
    const repo = new WorkItemRepo(db);
    await repo.insert(item("s1", { unitId: "kyoshin/CGame" }));
    await repo.insert(item("s2", { unitId: "kyoshin/CGame" }));

    const runId = await scheduler.createRun({ pipeline: "wiring-run", model: "flash" });
    await waitFor(async () => (await scheduler!.getRun(runId))?.status === "done", 5000, "run done");

    // helpers materialized through the scheduler's pass-through (RunContext
    // → RunState → StepCtx → forwardCtx).
    assert.deepEqual(seen, { log: "function", getFunctionAsm: "function" });

    // Accepted items recorded PRECISE completion rows through the engine's
    // default finalize (the completions store threaded by the scheduler), so
    // a later plan for this workflow skips them.
    assert.equal(
      await completions.isComplete("wiring-run", { id: "s1", unitId: "kyoshin/CGame" }),
      true,
    );
    assert.equal(
      await completions.isComplete("wiring-run", { id: "s2", unitId: "kyoshin/CGame" }),
      true,
    );
    assert.equal((await completions.list("wiring-run")).length, 2);
  } finally {
    await scheduler?.close();
    db.close();
  }
});
