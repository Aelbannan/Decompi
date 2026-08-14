/**
 * Reference-example smoke test (SPEC §C): imports all five example
 * workflows, asserts each is a `Workflow` with the expected `id`/`accepts`,
 * checks the two batch workflows compile to a Pipeline whose body is a
 * `foreach` of an `agentLoop` (with the size routes compiled to onReject),
 * and registers all five on the `Decompi` facade backed by a real
 * `PipelineEngine` without throwing. Deliberately a smoke test: no full run
 * (the engine e2e already exists — `tests/workflow-e2e.test.ts`).
 *
 * Like `tests/workflow-types.test.ts`, this file is in tsconfig `include` so
 * `npm run typecheck` really checks it — and through it, the examples.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Workflow } from "../src/workflow/types.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import { Decompi } from "../src/workflow/facade.js";

import { basicMatch } from "../examples/basic-match.js";
import { judgeAdaptiveMatch } from "../examples/judge-adaptive-match.js";
import { tuFinal } from "../examples/tu-final.js";
import { tuPrepass } from "../examples/tu-prepass.js";
import { fakematchDetect } from "../examples/fakematch-detect.js";
import {
  getFunctionAsm,
  runBatchCycle,
  structLayout,
  estimateDifficulty,
  type FunctionWorkItem,
} from "../examples/helpers.js";

/** The five reference examples: [workflow, expected id, expected accepts]. */
const EXAMPLES = [
  [basicMatch, "basic-match", "function"],
  [judgeAdaptiveMatch, "judge-adaptive-match", "function"],
  [tuFinal, "tu-final", "object"],
  [tuPrepass, "tu-prepass", "function"],
  [fakematchDetect, "fakematch-detect", "function"],
] as const;

test("examples: each is a Workflow with the expected id/accepts", () => {
  for (const [wf, id, accepts] of EXAMPLES) {
    assert.ok(wf instanceof Workflow, `${id} must be a Workflow`);
    assert.equal(wf.id, id);
    assert.equal(wf.accepts, accepts);
  }
});

test("examples: basic-match and judge-adaptive-match compile to a Pipeline with a foreach + agentLoop", () => {
  for (const wf of [basicMatch, judgeAdaptiveMatch]) {
    const pipeline = wf.compile();
    assert.equal(pipeline.id, wf.id);
    assert.equal(pipeline.adapter, "workflow");

    // Body = ONE foreach holding the agentLoop (SPEC §4 compilation map).
    assert.equal(pipeline.steps.length, 1);
    const foreach = pipeline.steps[0]!;
    assert.equal(foreach.kind, "foreach");
    if (foreach.kind !== "foreach") throw new Error("unreachable");
    assert.equal(foreach.batch, 5); // defaultBatchSize
    assert.equal(foreach.steps.length, 1);
    const loop = foreach.steps[0]!;
    assert.equal(loop.kind, "agentLoop");
    if (loop.kind !== "agentLoop") throw new Error("unreachable");
    assert.equal(typeof loop.start, "function");
    assert.equal(typeof loop.reprompt, "function");
    assert.equal(loop.rejectionRetries, 1);

    // Both routes compiled to ordered onReject entries (rebatch + singleton).
    assert.equal(foreach.onReject?.length, 2);
    assert.equal(foreach.onReject?.[0]?.when?.sizeBelow, 128);
    assert.equal(foreach.onReject?.[0]?.model, "nube-ds4-flash-low");
    assert.equal(foreach.onReject?.[1]?.model, "nube-ds4-flash-high");
  }
});

test("examples: helper stubs honor their documented stub contract", async () => {
  const t: FunctionWorkItem = {
    id: "f1",
    kind: "function",
    lifecycle: "pending",
    status: "NOT_STARTED",
    attempts: 0,
    exhausted: false,
    ready: true,
    meta: {},
    size: 42,
    asmText: "",
  };
  assert.match(await getFunctionAsm(t), /stub asm for f1/);
  const results = await runBatchCycle([t]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.accepted, true);
  assert.equal(results[0]!.targetId, "f1");
  assert.match(await structLayout("UnitA"), /UnitA/);
  assert.equal(await estimateDifficulty(t), 42);
  assert.equal(await estimateDifficulty({ ...t, size: undefined }), 0);
});

test("examples: all five register on the Decompi facade (PipelineEngine) without throwing", () => {
  const engine = new PipelineEngine();
  const scheduler = {
    createRun: async (_spec: unknown): Promise<string> => "smoke-run",
  };
  Decompi.configure({ engine, scheduler });
  for (const [wf, id] of EXAMPLES) {
    // addWorkflow compiles the pipeline AND registers both halves
    // (pipeline + route fragments) on the configured engine; a duplicate id
    // or route-graph cycle would throw here.
    Decompi.addWorkflow(wf);
    assert.equal(Decompi.workflow(id), wf);
  }
});
