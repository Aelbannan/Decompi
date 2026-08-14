/**
 * Workflow → Pipeline compiler tests (SPEC §4): `compileWorkflow` emits the
 * plan (kind filter via the selector, scope intersection, completion
 * subtraction), the `foreach` + `agentLoop` body with `onReject` routes, and
 * the route fragments (rebatch vs singleton batches) — plus an end-to-end
 * engine run through a compiled workflow's pipeline + fragments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MockAgentRuntime } from "../src/agent/mock.js";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import type { Step, StepCtx } from "../src/pipeline/types.js";
import type { ModelSpec, Selector, WorkItem } from "../src/types.js";
import {
  DEFAULT_BATCH_SIZE,
  applyScopeSelector,
  compileWorkflow,
  fragmentId,
  resolveLadder,
} from "../src/workflow/compile.js";
import { WorkflowStatusStore } from "../src/workflow/status.js";
import { Workflow } from "../src/workflow/types.js";

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

function asForeach(step: Step): Extract<Step, { kind: "foreach" }> {
  assert.equal(step.kind, "foreach");
  return step as Extract<Step, { kind: "foreach" }>;
}

function asAgentLoop(step: Step): Extract<Step, { kind: "agentLoop" }> {
  assert.equal(step.kind, "agentLoop");
  return step as Extract<Step, { kind: "agentLoop" }>;
}

// ---------------------------------------------------------------------------
// compile structure: foreach + agentLoop + onReject + fragments
// ---------------------------------------------------------------------------

test("compileWorkflow: one foreach with an agentLoop and onReject routes; fragments rebatch vs singleton", () => {
  const wf = new Workflow({
    id: "wf-struct",
    accepts: "function",
    canBatch: true,
    defaultBatchSize: 3,
    rejectionRetries: 2,
    select: {
      filter: { status: ["NOT_STARTED"] },
      sort: [{ by: "size", dir: "asc" }],
      limit: 100,
    },
    routes: [
      { when: { sizeBelow: 128 }, model: "flash-low", maxAttempts: 2 },
      { model: "flash-high" },
    ],
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });

  const { pipeline, fragments } = compileWorkflow(wf);

  // Pipeline identity.
  assert.equal(pipeline.id, "wf-struct");
  assert.equal(pipeline.adapter, "workflow");
  assert.equal(typeof pipeline.plan, "function");

  // One foreach, batch = defaultBatchSize (canBatch is true), one agentLoop.
  assert.equal(pipeline.steps.length, 1);
  const foreach = asForeach(pipeline.steps[0]!);
  assert.equal(foreach.batch, 3);
  assert.equal(foreach.steps.length, 1);
  const loop = asAgentLoop(foreach.steps[0]!);
  assert.equal(loop.rejectionRetries, 2); // def.rejectionRetries forwarded
  assert.equal(typeof loop.start, "function");
  assert.equal(typeof loop.reprompt, "function");
  assert.equal(loop.model, undefined); // run default

  // onReject: one entry per route, targeting its own fragment.
  assert.equal(foreach.onReject?.length, 2);
  assert.deepEqual(foreach.onReject?.[0], {
    when: { sizeBelow: 128 },
    to: fragmentId("wf-struct", 0),
    model: "flash-low",
    maxAttempts: 2,
  });
  assert.deepEqual(foreach.onReject?.[1], {
    when: undefined,
    to: fragmentId("wf-struct", 1),
    model: "flash-high",
    maxAttempts: undefined,
  });

  // Fragments: route 0 has when.sizeBelow → rebatch (batch = defaultBatchSize);
  // route 1 is a singleton (batch 1). Both wrap the same agentLoop.
  assert.equal(fragments.size, 2);
  const rebatch = asForeach(fragments.get(fragmentId("wf-struct", 0))![0]!);
  assert.equal(rebatch.batch, 3);
  const singleton = asForeach(fragments.get(fragmentId("wf-struct", 1))![0]!);
  assert.equal(singleton.batch, 1);
  for (const frag of [rebatch, singleton]) {
    assert.equal(asAgentLoop(frag.steps[0]!).kind, "agentLoop");
  }
});

test("compileWorkflow: canBatch=false forces batch 1; absent defaultBatchSize defaults to 5", () => {
  const solo = new Workflow({
    id: "wf-solo",
    accepts: "function",
    canBatch: false,
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const soloForeach = asForeach(compileWorkflow(solo).pipeline.steps[0]!);
  assert.equal(soloForeach.batch, 1);

  const defaulted = new Workflow({
    id: "wf-default",
    accepts: "function",
    canBatch: true,
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const defaultForeach = asForeach(compileWorkflow(defaulted).pipeline.steps[0]!);
  assert.equal(defaultForeach.batch, DEFAULT_BATCH_SIZE);
  assert.equal(DEFAULT_BATCH_SIZE, 5);
});

// ---------------------------------------------------------------------------
// plan: kind filter, def.select, scope, status (done) subtraction
// ---------------------------------------------------------------------------

test("plan: selects the workflow kind through def.select, applies scope, skips done targets", async () => {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  try {
    const statusesStore = new WorkflowStatusStore(db);
    const wf = new Workflow({
      id: "wf-plan",
      accepts: "function",
      defaultBatchSize: 3,
      select: {
        filter: { status: ["NOT_STARTED"] },
        sort: [{ by: "size", dir: "asc" }],
        limit: 100,
      },
      startPrompt: async () => "p",
      reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
    });
    const { pipeline } = compileWorkflow(wf, { statusesStore });

    const f1 = item("f1", { size: 50 });
    const f2 = item("f2", { size: 200 });
    const f3 = item("f3", { size: 300 });
    const o1 = { ...item("o1"), kind: "object" };
    // f2 is already done for this workflow (ladder default ["DONE"]): the
    // plan must skip it.
    await statusesStore.setStatus({ workflowId: "wf-plan", targetId: "f2", status: "DONE", actor: "test" });

    let seen: Selector | undefined;
    const ctx = {
      select: async (selector: Selector) => {
        seen = selector;
        // store-like: apply the kind + status filters the plan asked for.
        return [f1, f2, f3, o1].filter((i) => {
          if (selector.filter?.kind && !selector.filter.kind.includes(i.kind)) return false;
          if (selector.filter?.status && !selector.filter.status.includes(i.status)) return false;
          return true;
        });
      },
      scope: { targetIds: ["f1", "f2"] },
    };

    const planned = await pipeline.plan(ctx as unknown as StepCtx);

    // Kind is always = accepts; def.select narrows the rest.
    assert.deepEqual(seen?.filter?.kind, ["function"]);
    assert.deepEqual(seen?.filter?.status, ["NOT_STARTED"]);
    assert.deepEqual(seen?.sort, [{ by: "size", dir: "asc" }]);
    assert.equal(seen?.limit, 100);
    // Scope (targetIds ∩) removed f3; done-subtraction removed f2.
    assert.deepEqual(
      planned.map((i) => i.id),
      ["f1"],
    );
  } finally {
    db.close();
  }
});

test("plan: doneStatuses drives the subtraction (a non-last status stays selectable)", async () => {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  try {
    const statusesStore = new WorkflowStatusStore(db);
    const wf = new Workflow({
      id: "wf-ladder",
      accepts: "function",
      statuses: ["NOT_STARTED", "CODE_MATCH", "FULL_MATCH"],
      doneStatuses: ["FULL_MATCH"],
      completionStatus: "FULL_MATCH",
      startPrompt: async () => "p",
      reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
    });
    const { pipeline } = compileWorkflow(wf, { statusesStore });

    const done = item("done", { size: 10 });
    const partial = item("partial", { size: 20 });
    const open = item("open", { size: 30 });
    await statusesStore.setStatus({ workflowId: "wf-ladder", targetId: "done", status: "FULL_MATCH", actor: "run_1" });
    await statusesStore.setStatus({ workflowId: "wf-ladder", targetId: "partial", status: "CODE_MATCH", actor: "run_1" });

    const planned = await pipeline.plan({
      select: async () => [done, partial, open],
    } as unknown as StepCtx);

    // FULL_MATCH is done (skipped); CODE_MATCH is on the ladder but NOT done
    // (stays selectable — re-run may push it further).
    assert.deepEqual(
      planned.map((i) => i.id),
      ["partial", "open"],
    );
  } finally {
    db.close();
  }
});

test("plan: without a status store nothing is pre-completed", async () => {
  const wf = new Workflow({
    id: "wf-noc",
    accepts: "function",
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const { pipeline } = compileWorkflow(wf);
  const planned = await pipeline.plan({
    select: async () => [item("a"), item("b")],
  } as unknown as StepCtx);
  assert.deepEqual(
    planned.map((i) => i.id),
    ["a", "b"],
  );
});

// ---------------------------------------------------------------------------
// status ladder compilation (SPEC §A.1)
// ---------------------------------------------------------------------------

test("resolveLadder applies the defaults: [DONE] ladder, last-status done/completion", () => {
  assert.deepEqual(resolveLadder({}), {
    statuses: ["DONE"],
    doneStatuses: ["DONE"],
    completionStatus: "DONE",
  });
  assert.deepEqual(
    resolveLadder({
      statuses: ["NOT_STARTED", "CODE_MATCH", "FULL_MATCH"],
      doneStatuses: ["CODE_MATCH", "FULL_MATCH"],
      completionStatus: "FULL_MATCH",
    }),
    {
      statuses: ["NOT_STARTED", "CODE_MATCH", "FULL_MATCH"],
      doneStatuses: ["CODE_MATCH", "FULL_MATCH"],
      completionStatus: "FULL_MATCH",
    },
  );
  // doneStatuses/completionStatus default to the LAST ladder status.
  assert.deepEqual(resolveLadder({ statuses: ["NEW", "DONE"] }), {
    statuses: ["NEW", "DONE"],
    doneStatuses: ["DONE"],
    completionStatus: "DONE",
  });
});

test("compileWorkflow compiles statuses/doneStatuses/completionStatus onto the pipeline", () => {
  const wf = new Workflow({
    id: "wf-ladder-compile",
    accepts: "function",
    statuses: ["NOT_STARTED", "CODE_MATCH", "FULL_MATCH"],
    completionStatus: "FULL_MATCH",
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const { pipeline } = compileWorkflow(wf);
  assert.deepEqual(pipeline.statuses, ["NOT_STARTED", "CODE_MATCH", "FULL_MATCH"]);
  assert.deepEqual(pipeline.doneStatuses, ["FULL_MATCH"]); // defaults to the last status
  assert.equal(pipeline.completionStatus, "FULL_MATCH");

  // Defaults when the def declares none.
  const plain = new Workflow({
    id: "wf-ladder-default",
    accepts: "function",
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const plainPipeline = compileWorkflow(plain).pipeline;
  assert.deepEqual(plainPipeline.statuses, ["DONE"]);
  assert.deepEqual(plainPipeline.doneStatuses, ["DONE"]);
  assert.equal(plainPipeline.completionStatus, "DONE");
});

// ---------------------------------------------------------------------------
// applyScopeSelector (SPEC §6 AND semantics)
// ---------------------------------------------------------------------------

test("applyScopeSelector: ANDs targetIds and unitIds; no scope = unchanged", () => {
  const a = item("a", { unitId: "u1" });
  const b = item("b", { unitId: "u2" });
  const c = item("c", { unitId: "u1" });
  const all = [a, b, c];
  const ids = (xs: WorkItem[]) => xs.map((i) => i.id);

  assert.deepEqual(ids(applyScopeSelector(all, undefined)), ["a", "b", "c"]);
  assert.deepEqual(ids(applyScopeSelector(all, { targetIds: ["a", "c"] })), ["a", "c"]);
  assert.deepEqual(ids(applyScopeSelector(all, { unitIds: ["u1"] })), ["a", "c"]);
  // Both given = AND: a is in targetIds AND u1.
  assert.deepEqual(ids(applyScopeSelector(all, { targetIds: ["a"], unitIds: ["u1"] })), ["a"]);
  // An item without a unitId never matches a unit filter.
  assert.deepEqual(ids(applyScopeSelector([item("x"), a], { unitIds: ["u1"] })), ["a"]);
});

// ---------------------------------------------------------------------------
// end-to-end through the engine
// ---------------------------------------------------------------------------

test("compiled pipeline runs end-to-end: agentLoop accepts, onReject routes rejected items to the fragments", async () => {
  const wf = new Workflow({
    id: "wf-e2e",
    accepts: "function",
    canBatch: true,
    defaultBatchSize: 3,
    routes: [
      { when: { sizeBelow: 128 }, model: "flash" }, // rebatch fragment (batch 3)
      { model: "flash" }, // singleton fragment (batch 1)
    ],
    startPrompt: async (targets) => `batch: ${targets.map((t) => t.id).join(",")}`,
    reprompt: async (targets) => ({
      accepted: targets.slice(0, 1),
      rejected: targets.slice(1),
      final: true,
    }),
  });
  const { pipeline, fragments } = compileWorkflow(wf);

  const engine = new PipelineEngine();
  engine.registerPipeline(pipeline);
  for (const [id, steps] of fragments) engine.registerFragment(id, steps);

  const rt = new MockAgentRuntime({ flash: FLASH });
  const finalized: string[] = [];
  // f1 (200) accepted in the main batch; f2 (50) routes to the rebatch
  // fragment (sizeBelow 128); f3 (200) routes to the singleton fragment.
  const items = [item("f1", { size: 200 }), item("f2", { size: 50 }), item("f3", { size: 300 })];

  const out = await engine.runPipeline("wf-e2e", {
    runtime: rt,
    defaultModel: "flash",
    select: async () => items,
    finalize: async (it) => void finalized.push(it.id),
  });

  // Every item was accepted: f1 by the main agentLoop turn, f2/f3 by their
  // route fragments (each fragment re-runs the same agentLoop hooks).
  assert.deepEqual(
    out.accepted.map((i) => i.id).sort(),
    ["f1", "f2", "f3"],
  );
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(finalized.sort(), ["f1", "f2", "f3"]);

  // Three sessions: main batch + rebatch fragment + singleton fragment.
  assert.equal(rt.calls.length, 3);
  assert.match(rt.calls[0]!.prompt, /batch: f1,f2,f3/);
  assert.match(rt.calls[1]!.prompt, /batch: f2/);
  assert.doesNotMatch(rt.calls[1]!.prompt, /f1|f3/);
  assert.match(rt.calls[2]!.prompt, /batch: f3/);
  assert.doesNotMatch(rt.calls[2]!.prompt, /f1|f2/);
});
