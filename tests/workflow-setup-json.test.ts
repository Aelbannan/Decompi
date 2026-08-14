/**
 * Dynamic Reprompt Policy (SPEC §A.1/§A.2) + `ctx.helpers` materialization:
 *
 *  (a) `ctx.StartJsonAgent` returns a zod-parsed object from a
 *      MockAgentRuntime with a scripted canned JSON reply;
 *  (b) `StartJsonAgent` retries once (fresh session), then throws
 *      `JudgeError` on non-JSON / schema-invalid replies;
 *  (c) a Workflow with `setup` compiles to a `foreach` carrying `setup`
 *      (main foreach AND route fragments; absent when undeclared);
 *  (d) `forwardCtx` materializes `ctx.helpers` (built-ins + adapter registry
 *      + local, local wins) + `ctx.store` + `ctx.StartJsonAgent` — asserted
 *      through a compiled workflow's reprompt with a fake StepCtx.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { MockAgentRuntime, emptyUsage } from "../src/agent/mock.js";
import type { AgentTurn } from "../src/pipeline/engine.js";
import type { Step, StepCtx } from "../src/pipeline/types.js";
import type { ModelSpec, Selector, WorkItem } from "../src/types.js";
import { compileWorkflow, fragmentId } from "../src/workflow/compile.js";
import { HelperRegistry, makeStartJsonAgent } from "../src/workflow/helpers.js";
import { JudgeError, Workflow } from "../src/workflow/types.js";

const FLASH: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 60,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

/** The §A.4 judge schema shape: a go/no-go decision plus a message. */
const JudgeOut = z.object({ shouldContinue: z.boolean(), message: z.string() });

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
// (a) StartJsonAgent: fresh session + one JSON-mode turn -> zod-parsed reply
// ---------------------------------------------------------------------------

test("StartJsonAgent returns a zod-parsed object from a scripted JSON reply", async () => {
  const rt = new MockAgentRuntime(
    { judge: FLASH },
    [['{"shouldContinue":true,"message":"ok"}']],
  );
  const judge = makeStartJsonAgent(rt);

  const out = await judge("judge", "Is this batch converging?", { last: "turn" }, JudgeOut);

  // zod-parsed, fully typed (no any): {shouldContinue:boolean, message:string}.
  assert.deepEqual(out, { shouldContinue: true, message: "ok" });

  // One fresh session per call, seeded with the judge prompt.
  assert.equal(rt.calls.length, 1);
  assert.deepEqual(rt.calls[0], { model: "judge", prompt: "Is this batch converging?" });
  // One JSON-mode turn fed with the schema AND the input context (SPEC §A.2).
  assert.equal(rt.sessions.length, 1);
  const turn = rt.sessions[0]!.promptHistory[0]!;
  assert.match(turn, /Respond with a single JSON object matching this schema:/);
  assert.match(turn, /shouldContinue/); // the schema is described in the prompt
  assert.match(turn, /Input:/);
  assert.match(turn, /"last"/); // the input payload reached the turn
});

// ---------------------------------------------------------------------------
// (b) StartJsonAgent: retry once (fresh session), then JudgeError
// ---------------------------------------------------------------------------

test("StartJsonAgent retries once with a fresh session, then throws JudgeError on invalid JSON", async () => {
  const rt = new MockAgentRuntime(
    { judge: FLASH },
    [["not json at all"], ["still not json"]],
  );
  const judge = makeStartJsonAgent(rt);

  await assert.rejects(
    judge("judge", "p", undefined, JudgeOut),
    (err: unknown) => {
      assert.ok(err instanceof JudgeError, `expected JudgeError, got ${String(err)}`);
      assert.equal(err.attempts, 2); // initial + one retry
      assert.match(err.message, /not valid JSON/);
      return true;
    },
  );

  // Two attempts = two fresh sessions (the judge never reuses a session).
  assert.equal(rt.calls.length, 2);
  assert.equal(rt.sessions.length, 2);
});

test("StartJsonAgent also retries + throws JudgeError on schema-invalid (valid-JSON) replies", async () => {
  const rt = new MockAgentRuntime(
    { judge: FLASH },
    [['{"shouldContinue":"nope"}'], ['{"message":5}']], // both fail the schema
  );
  const judge = makeStartJsonAgent(rt);

  await assert.rejects(
    judge("judge", "p", undefined, JudgeOut),
    (err: unknown) => {
      assert.ok(err instanceof JudgeError);
      assert.equal(err.attempts, 2);
      return true;
    },
  );
  assert.equal(rt.calls.length, 2);
});

// ---------------------------------------------------------------------------
// (c) Workflow.setup compiles onto the foreach (main + fragments)
// ---------------------------------------------------------------------------

test("Workflow.setup compiles to a foreach carrying setup (main + fragments); absent when undeclared", async () => {
  let seen: { targets: string[]; helpersOk: boolean; jsonOk: boolean } | undefined;
  const wf = new Workflow({
    id: "wf-setup",
    accepts: "function",
    defaultBatchSize: 3,
    routes: [{ when: { sizeBelow: 128 }, model: "flash" }],
    setup: async (targets, ctx) => {
      // The setup hook receives a fully materialized ctx too.
      seen = {
        targets: targets.map((t) => t.id),
        helpersOk: typeof ctx.helpers.select === "function",
        jsonOk: typeof ctx.StartJsonAgent === "function",
      };
      return { batchSize: 2, model: "flash-low", rejectionRetries: 3 };
    },
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const { pipeline, fragments } = compileWorkflow(wf);

  const rt = new MockAgentRuntime({ flash: FLASH });
  const fakeCtx = {
    runtime: rt,
    select: async () => [],
    log: () => {},
  } as unknown as StepCtx;

  // Main foreach carries the compiled setup hook.
  const foreach = asForeach(pipeline.steps[0]!);
  assert.equal(typeof foreach.setup, "function");
  const cfg = await foreach.setup!([item("a"), item("b")], fakeCtx);
  assert.deepEqual(cfg, { batchSize: 2, model: "flash-low", rejectionRetries: 3 });
  assert.deepEqual(seen?.targets, ["a", "b"]);
  assert.equal(seen?.helpersOk, true);
  assert.equal(seen?.jsonOk, true);

  // Route fragments reuse the compiled loop AND re-run setup per batch (§A.1).
  const frag = asForeach(fragments.get(fragmentId("wf-setup", 0))![0]!);
  assert.equal(typeof frag.setup, "function");
  const fragCfg = await frag.setup!([item("c")], fakeCtx);
  assert.deepEqual(fragCfg, { batchSize: 2, model: "flash-low", rejectionRetries: 3 });

  // A workflow without setup compiles with setup absent (engine skips it).
  const plain = new Workflow({
    id: "wf-plain",
    accepts: "function",
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const plainForeach = asForeach(compileWorkflow(plain).pipeline.steps[0]!);
  assert.equal(plainForeach.setup, undefined);
});

// ---------------------------------------------------------------------------
// (d) forwardCtx materializes helpers + store + StartJsonAgent
// ---------------------------------------------------------------------------

test("forwardCtx materializes ctx.helpers (built-ins + registry + local), ctx.store, ctx.StartJsonAgent", async () => {
  const rt = new MockAgentRuntime(
    { judge: FLASH },
    [['{"shouldContinue":true,"message":"ok"}']],
  );
  const dbStore = { query: async <T,>(_sql: string): Promise<T[]> => [{ id: "f1" } as T] };
  const registry = new HelperRegistry().register("adapterHelper", () => "adapter");

  const obs: {
    helpersSelect: string | undefined;
    adapter: unknown;
    local: unknown;
    storeRows: unknown;
    helpersStoreRows: unknown;
    judge: unknown;
    lastTurnText: string | undefined;
    builtinRender: string | undefined;
  } = {
    helpersSelect: undefined,
    adapter: undefined,
    local: undefined,
    storeRows: undefined,
    helpersStoreRows: undefined,
    judge: undefined,
    lastTurnText: undefined,
    builtinRender: undefined,
  };

  const wf = new Workflow({
    id: "wf-ctx",
    accepts: "function",
    helpers: { localHelper: () => "local" }, // local wins over globals
    startPrompt: async () => "p",
    reprompt: async (_targets, ctx, lastTurn) => {
      // helpers: built-ins present
      obs.helpersSelect = typeof ctx.helpers.select;
      obs.builtinRender = ctx.helpers.render("hi ${x}", { x: "there" });
      // helpers: adapter registry merged in
      obs.adapter = ctx.helpers.adapterHelper();
      // helpers: workflow-local helper merged in (and wins)
      obs.local = ctx.helpers.localHelper();
      // store: ctx.store AND helpers.store are the run's read-only view
      obs.storeRows = await ctx.store.query("SELECT 1");
      obs.helpersStoreRows = await ctx.helpers.store.query("SELECT 2");
      // StartJsonAgent is bound and works against the run runtime
      obs.judge = await ctx.StartJsonAgent("judge", "judge-prompt", { last: "turn" }, JudgeOut);
      obs.lastTurnText = lastTurn.text;
      return { accepted: [], rejected: [] };
    },
  });
  const { pipeline } = compileWorkflow(wf);
  const loop = asAgentLoop(asForeach(pipeline.steps[0]!).steps[0]!);

  const fakeCtx = {
    runtime: rt,
    select: async (s: Selector) => s.filter?.kind?.includes("function") ? [item("f1")] : [],
    log: () => {},
    store: dbStore,
    helpers: registry,
    finalize: async () => {},
  } as unknown as StepCtx;
  const lastTurn: AgentTurn = { model: "flash", text: "turn text", usage: emptyUsage(), styleGuideHash: "" };

  const verdict = await loop.reprompt([item("f1")], fakeCtx, lastTurn);
  assert.deepEqual(verdict, { accepted: [], rejected: [] });

  // Built-ins materialized (not a cast hole).
  assert.equal(obs.helpersSelect, "function");
  assert.equal(obs.builtinRender, "hi there");
  // Adapter registry merged; local shadows global (both present, local wins).
  assert.equal(obs.adapter, "adapter");
  assert.equal(obs.local, "local");
  // store surfaced on BOTH ctx.store and ctx.helpers.store (same read-only view).
  assert.deepEqual(obs.storeRows, [{ id: "f1" }]);
  assert.deepEqual(obs.helpersStoreRows, [{ id: "f1" }]);
  // StartJsonAgent bound to the run's runtime: one fresh judge session.
  assert.deepEqual(obs.judge, { shouldContinue: true, message: "ok" });
  assert.equal(rt.calls.length, 1);
  assert.deepEqual(rt.calls[0], { model: "judge", prompt: "judge-prompt" });
  assert.equal(rt.sessions.length, 1);
  assert.match(rt.sessions[0]!.promptHistory[0]!, /Respond with a single JSON object matching this schema:/);
  // lastTurn forwarded to reprompt's ctx.
  assert.equal(obs.lastTurnText, "turn text");
});
