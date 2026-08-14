/**
 * Workflow authoring API — END-TO-END test (SPEC §2–§4, task 12): the
 * `basicMatchWorkflow` from the spec, registered through the `Decompi`
 * facade on a real `PipelineEngine`, run with a `MockAgentRuntime` and a
 * fake `diff` verifier. This proves the whole chain — the typed `Workflow`
 * compiles (plan + `agentLoop`), registers (pipeline AND `onReject`
 * fragments), and runs (accepted items finalized via the collector, rejected
 * items routed through the fragments).
 *
 * Also covers the run-scope half of the wiring (SPEC §6): `RunSpec.scope`
 * folds into the persisted `runs.selector` (`targetIds → filter.ids`,
 * `unitIds → filter.unit`) so a restarted run keeps its scope.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MockAgentRuntime } from "../src/agent/mock.js";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import type { StepCtx } from "../src/pipeline/types.js";
import { RunScheduler } from "../src/server/scheduler.js";
import type { ModelSpec, Selector, Verifier, WorkItem } from "../src/types.js";
import { Decompi } from "../src/workflow/facade.js";
import { Workflow } from "../src/workflow/types.js";

const FLASH: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 60,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

/** A `function`-kind work item fixture. */
function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    kind: "function",
    unitId: "kyoshin/CGame",
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

/** A stub scheduler: records the spec, returns a canned run id. */
function stubScheduler(result = "e2e-run") {
  let seen: { pipeline: string; model: string; budgetMicroUsd?: number; scope?: unknown } | undefined;
  const scheduler = {
    createRun: async (spec: { pipeline: string; model: string; budgetMicroUsd?: number; scope?: unknown }): Promise<string> => {
      seen = spec;
      return result;
    },
  };
  return { scheduler, seen: () => seen };
}

// ---------------------------------------------------------------------------
// The spec's basicMatchWorkflow, end to end
// ---------------------------------------------------------------------------

test("basicMatchWorkflow compiles + registers + runs: accepts finalized, rejects routed", async () => {
  const engine = new PipelineEngine();
  const { scheduler } = stubScheduler();
  Decompi.configure({ engine, scheduler });

  /**
   * Fake `diff` verifier (SPEC §9 shape): accepted iff the function is
   * smaller than 100 bytes — the deterministic stand-in for hexdiff. The
   * workflow's reprompt runs it over the in-play targets (the spec's
   * `runBatchCycle` position) to build the accepted/rejected verdict.
   */
  const fakeDiff: Verifier = {
    id: "diff",
    async verify(t) {
      const accepted = t.size !== undefined && t.size < 100;
      return {
        accepted,
        status: accepted ? "FULL_MATCH" : "NOT_STARTED",
        evidence: { symbol: t.symbol ?? t.id, size: t.size },
        feedback: accepted ? "" : `diff mismatch for ${t.id}`,
      };
    },
  };

  const wf = new Workflow({
    id: "basic-match",
    accepts: "function",
    canBatch: true,
    defaultBatchSize: 3,
    rejectionRetries: 1,
    select: {
      filter: { status: ["NOT_STARTED"] },
      sort: [{ by: "size", dir: "asc" }],
      limit: 100,
    },
    routes: [{ model: "flash" }], // singleton fragment for rejected items
    startPrompt: async (targets) => `match: ${targets.map((t) => t.id).join(",")}`,
    reprompt: async (targets, ctx, _lastTurn) => {
      const verdicts = await Promise.all(targets.map((t) => fakeDiff.verify(t, ctx)));
      return {
        accepted: targets.filter((_, i) => verdicts[i]!.accepted),
        rejected: targets.filter((_, i) => !verdicts[i]!.accepted),
        feedback: verdicts.map((v) => v.feedback ?? "").join("\n"),
      };
    },
  });
  Decompi.addWorkflow(wf);
  assert.equal(Decompi.workflow("basic-match"), wf);

  // Plan surface: `accepts` → kind filter, def.select narrows the rest.
  let seenSelector: Selector | undefined;
  const items = [
    item("f1", { size: 50, symbol: "fn_0001" }), // accepted by the fake diff
    item("f2", { size: 200, symbol: "fn_0002" }), // rejected → routed
    item("f3", { size: 300, symbol: "fn_0003" }), // rejected → routed
  ];

  const finalized: Array<[string, unknown]> = [];
  const rt = new MockAgentRuntime({ flash: FLASH });
  const out = await engine.runPipeline("basic-match", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: { diff: fakeDiff },
    select: async (selector) => {
      seenSelector = selector;
      return items;
    },
    finalize: async (it, action) => void finalized.push([it.id, action]),
  });

  // The compiled plan honored the select surface: kind is ALWAYS = accepts,
  // def.select's status/sort/limit flow through.
  assert.deepEqual(seenSelector?.filter?.kind, ["function"]);
  assert.deepEqual(seenSelector?.filter?.status, ["NOT_STARTED"]);
  assert.deepEqual(seenSelector?.sort, [{ by: "size", dir: "asc" }]);
  assert.equal(seenSelector?.limit, 100);

  // Accepted items are finalized exactly once, with the default action:
  // promote + the compiled ladder's completionStatus (SPEC §A.4).
  assert.deepEqual(out.accepted.map((i) => i.id), ["f1"]);
  assert.deepEqual(
    finalized.map(([id]) => id),
    ["f1"],
  );
  assert.deepEqual(finalized[0]![1], { promote: true, status: "DONE" });

  // Rejected items were routed through the onReject fragment (a missing
  // fragment would throw) and, re-verified deterministically, stay rejected.
  assert.deepEqual(
    out.rejected.map((i) => i.id).sort(),
    ["f2", "f3"],
  );
  assert.deepEqual(out.skipped, []);

  // Sessions prove the routing: 1 main batch + 2 singleton fragment runs.
  assert.equal(rt.calls.length, 3);
  assert.match(rt.calls[0]!.prompt, /match: f1,f2,f3/);
  assert.match(rt.calls[1]!.prompt, /match: f2/);
  assert.doesNotMatch(rt.calls[1]!.prompt, /f1|f3/);
  assert.match(rt.calls[2]!.prompt, /match: f3/);
  assert.doesNotMatch(rt.calls[2]!.prompt, /f1|f2/);
});

// ---------------------------------------------------------------------------
// Run scope (SPEC §6): RunSpec.scope folds into the persisted runs.selector
// ---------------------------------------------------------------------------

test("RunSpec.scope folds into the persisted runs.selector (targetIds → ids, unitIds → unit)", async () => {
  const db = await openDb();
  let scheduler: RunScheduler | undefined;
  try {
    const engine = new PipelineEngine();
    engine.registerPipeline({ id: "p", adapter: "x", plan: async () => [], steps: [] });
    scheduler = new RunScheduler({ store: db, engine, maxParallelRuns: 1 });

    const id = await scheduler.createRun({
      pipeline: "p",
      model: "flash",
      selector: { filter: { kind: ["function"] } },
      scope: { targetIds: ["t1", "t2"], unitIds: ["u1"] },
    });
    const run = await scheduler.getRun(id);
    // AND semantics: the base selector's kind filter is preserved and the
    // scope folds in — a restarted run (spec rebuilt from the row) keeps it.
    assert.deepEqual(run?.selector, {
      filter: { kind: ["function"], ids: ["t1", "t2"], unit: ["u1"] },
    });
  } finally {
    await scheduler?.close();
    db.close();
  }
});

// ---------------------------------------------------------------------------
// The CLI/API RunSpec shape the wiring builds (Decompi.run delegates)
// ---------------------------------------------------------------------------

test("Decompi.run receives the CLI-built spec (pipeline, model, budget, scope)", async () => {
  const { scheduler, seen } = stubScheduler();
  Decompi.configure({ engine: new PipelineEngine(), scheduler });

  const id = await Decompi.run({
    pipeline: "basic-match",
    model: "flash",
    budgetMicroUsd: 100_000,
    scope: { targetIds: ["f1"], unitIds: ["kyoshin/CGame"] },
  });
  assert.equal(id, "e2e-run");
  assert.deepEqual(seen(), {
    pipeline: "basic-match",
    model: "flash",
    budgetMicroUsd: 100_000,
    scope: { targetIds: ["f1"], unitIds: ["kyoshin/CGame"] },
  });
});
