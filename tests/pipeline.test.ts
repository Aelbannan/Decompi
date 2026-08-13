/**
 * M3 pipeline engine tests (SPEC §10): step execution model with
 * MockAgentRuntime + fake verifiers. Covers: foreach batching (one agent
 * session per batch), verify accept/reject splitting, onReject routing to
 * steps-only fragments (ordered `when` predicates + per-route maxAttempts
 * budget), gate scope abort, select/foreach.from binding wiring, keyed
 * grouping, and register-time route-cycle rejection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelSpec, Verifier, WorkItem } from "../src/types.js";
import { MockAgentRuntime } from "../src/agent/mock.js";
import { PipelineEngine, definePipeline } from "../src/pipeline/engine.js";
import type { StepCtx } from "../src/pipeline/types.js";

const FLASH: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 20,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

const HARD: ModelSpec = {
  provider: "nube",
  model: "ds4-flash-high",
  thinkingLevel: "high",
  maxTokens: 0,
  rpm: 5,
  cost: { inputPerM: 2, outputPerM: 4, cacheReadPerM: 0.2, cacheWritePerM: 4 },
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

const MATCH_PROMPT = { template: "match" } as const;

function ids(items: WorkItem[]): string[] {
  return items.map((i) => i.id);
}

// ---------------------------------------------------------------------------
// foreach batching
// ---------------------------------------------------------------------------

test("foreach batch of 5 runs the agent step once for 5 items (1 session)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const items = [item("a"), item("b"), item("c"), item("d"), item("e")];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "batch5",
    adapter: "test",
    plan: async () => items,
    steps: [
      { kind: "foreach", batch: 5, steps: [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }] },
    ],
  });

  const out = await engine.runPipeline("batch5", { runtime: rt, defaultModel: "flash" });

  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0]!.model, "flash");
  // The batch's items are all visible to the shared session.
  for (const i of items) assert.match(rt.calls[0]!.prompt, new RegExp(`- ${i.id}\\b`));
  // No verifier ran: every item is still in play (unaccepted).
  assert.deepEqual(ids(out.rejected), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(out.accepted, []);
});

test("foreach batch=2 splits 5 items into 3 batches (3 sessions, disjoint prompts)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const items = [item("a"), item("b"), item("c"), item("d"), item("e")];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "batch2",
    adapter: "test",
    plan: async () => items,
    steps: [
      { kind: "foreach", batch: 2, steps: [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }] },
    ],
  });

  await engine.runPipeline("batch2", { runtime: rt, defaultModel: "flash" });

  assert.equal(rt.calls.length, 3);
  const seen = rt.calls.map((c) => c.prompt).join("\n");
  for (const i of items) assert.match(seen, new RegExp(`- ${i.id}\\b`));
});

test("foreach groups by key before batching (unit)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  // unit1 has 3 items, unit2 has 1; batch=2.
  const items = [
    item("u1a", { unitId: "u1" }),
    item("u1b", { unitId: "u1" }),
    item("u1c", { unitId: "u1" }),
    item("u2d", { unitId: "u2" }),
  ];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "grouped",
    adapter: "test",
    plan: async () => items,
    steps: [
      { kind: "foreach", key: "unit", batch: 2, steps: [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }] },
    ],
  });

  await engine.runPipeline("grouped", { runtime: rt, defaultModel: "flash" });

  // Grouped: u1 -> [u1a,u1b],[u1c] (2 batches) + u2 -> [u2d] (1 batch) = 3 sessions.
  // Ungrouped: 4 items chunked at 2 would be only 2 sessions.
  assert.equal(rt.calls.length, 3);
  for (const call of rt.calls) {
    const prompt = call.prompt;
    const hasU1 = /- u1[abc]\b/.test(prompt);
    const hasU2 = /- u2d\b/.test(prompt);
    assert.ok(hasU1 !== hasU2, `batch mixed units: ${prompt}`);
  }
});

// ---------------------------------------------------------------------------
// verify splitting
// ---------------------------------------------------------------------------

const acceptOk: Verifier = {
  id: "acceptOk",
  verify: async (it) => ({ accepted: it.id.startsWith("ok"), evidence: { source: "fake" } }),
};

test("verify splits items into accepted/rejected and flows rejects onward", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const items = [item("ok-1"), item("bad-1"), item("ok-2")];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "vsplit",
    adapter: "test",
    plan: async () => items,
    steps: [{ kind: "verify", verifier: "acceptOk" }],
  });

  const out = await engine.runPipeline("vsplit", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: [acceptOk],
  });

  assert.deepEqual(ids(out.accepted), ["ok-1", "ok-2"]);
  assert.deepEqual(ids(out.rejected), ["bad-1"]);
  assert.deepEqual(out.skipped, []);
});

test("verify: unknown verifier throws a clear error", async () => {
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "nover",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [{ kind: "verify", verifier: "ghost" }],
  });
  await assert.rejects(
    engine.runPipeline("nover", { runtime: new MockAgentRuntime({ flash: FLASH }), defaultModel: "flash" }),
    /unknown verifier "ghost"/,
  );
});

// ---------------------------------------------------------------------------
// onReject routing
// ---------------------------------------------------------------------------

test("onReject routes a rejected item to a fragment under the route's model", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH, hard: HARD });
  const items = [item("ok-1"), item("bad-1")];
  const engine = new PipelineEngine();
  // Fragment has NO model on its agent step: the route's model must win.
  engine.registerFragment("retry", [{ kind: "agent", prompt: MATCH_PROMPT }]);
  engine.registerPipeline({
    id: "route",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "foreach",
        batch: 10,
        steps: [{ kind: "verify", verifier: "acceptOk" }],
        onReject: [{ when: {}, to: "retry", model: "hard", maxAttempts: 2 }],
      },
    ],
  });

  const out = await engine.runPipeline("route", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: [acceptOk],
  });

  // Body had no agent; exactly one session from the fragment run, on "hard".
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0]!.model, "hard");
  assert.match(rt.calls[0]!.prompt, /- bad-1\b/);
  assert.doesNotMatch(rt.calls[0]!.prompt, /- ok-1\b/);
  // ok-1 was accepted by the verifier; bad-1 went through the retry fragment
  // (agent only, no verifier) and is still in play -> rejected.
  assert.deepEqual(ids(out.accepted), ["ok-1"]);
  assert.deepEqual(ids(out.rejected), ["bad-1"]);
});

test("onReject evaluates ordered when predicates; unmatched items stay rejected", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH, hard: HARD });
  const rejectAll: Verifier = { id: "rejectAll", verify: async () => ({ accepted: false, evidence: {} }) };
  const acceptAll: Verifier = { id: "acceptAll", verify: async () => ({ accepted: true, evidence: {} }) };
  const items = [
    item("small-failed", { size: 10, status: "FAILED" }),
    item("big-failed", { size: 200, status: "FAILED" }),
    item("no-match", { size: 5000, status: "OTHER" }),
  ];
  const engine = new PipelineEngine();
  engine.registerFragment("small", [
    { kind: "agent", prompt: MATCH_PROMPT, model: "flash" },
    { kind: "verify", verifier: "acceptAll" },
  ]);
  engine.registerFragment("failed", [
    { kind: "agent", prompt: MATCH_PROMPT, model: "hard" },
    { kind: "verify", verifier: "acceptAll" },
  ]);
  engine.registerPipeline({
    id: "when",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "foreach",
        batch: 10,
        steps: [{ kind: "verify", verifier: "rejectAll" }],
        onReject: [
          { when: { sizeBelow: 100 }, to: "small", model: "flash" },
          { when: { status: ["FAILED"], attempts: { min: 0, max: 9 } }, to: "failed", model: "hard" },
        ],
      },
    ],
  });

  const out = await engine.runPipeline("when", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: [rejectAll, acceptAll],
  });

  assert.equal(rt.calls.length, 2);
  const flashCall = rt.calls.find((c) => c.model === "flash")!;
  const hardCall = rt.calls.find((c) => c.model === "hard")!;
  assert.match(flashCall.prompt, /- small-failed\b/);
  assert.doesNotMatch(flashCall.prompt, /- big-failed\b/);
  assert.match(hardCall.prompt, /- big-failed\b/);
  // small-failed hit route 1 (sizeBelow 100), big-failed hit route 2 (status
  // FAILED within attempts range); both were accepted by the retry fragments.
  assert.deepEqual(ids(out.accepted), ["small-failed", "big-failed"]);
  // "no-match" matched neither route -> stays rejected without a session.
  assert.deepEqual(ids(out.rejected), ["no-match"]);
});

test("route maxAttempts budget blocks re-routing after the cap", async () => {
  const rejectAll: Verifier = { id: "rejectAll", verify: async () => ({ accepted: false, evidence: {} }) };

  async function runWith(budget: number) {
    const rt = new MockAgentRuntime({ flash: FLASH });
    const engine = new PipelineEngine();
    engine.registerFragment("retry", [{ kind: "agent", prompt: MATCH_PROMPT }]);
    engine.registerPipeline({
      id: "cap",
      adapter: "test",
      plan: async () => [item("bad-1")],
      steps: [
        {
          kind: "foreach",
          batch: 10,
          steps: [{ kind: "verify", verifier: "rejectAll" }],
          onReject: [{ when: {}, to: "retry", maxAttempts: budget, model: "flash" }],
        },
        {
          kind: "foreach",
          batch: 10,
          steps: [{ kind: "verify", verifier: "rejectAll" }],
          onReject: [{ when: {}, to: "retry", maxAttempts: budget, model: "flash" }],
        },
      ],
    });
    return { rt, out: await engine.runPipeline("cap", { runtime: rt, defaultModel: "flash", verifiers: [rejectAll] }) };
  }

  // First foreach routes bad-1 to the retry fragment once (1 session); the
  // second foreach sees the same item rejected again, but the budget is spent.
  const capped = await runWith(1);
  assert.equal(capped.rt.calls.length, 1);
  assert.deepEqual(ids(capped.out.rejected), ["bad-1"]);

  // With budget 2 the second rejection routes again: 2 fragment sessions.
  const open = await runWith(2);
  assert.equal(open.rt.calls.length, 2);
  assert.deepEqual(ids(open.out.rejected), ["bad-1"]);
});

test("route target that is not a registered fragment fails at run time", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const rejectAll: Verifier = { id: "rejectAll", verify: async () => ({ accepted: false, evidence: {} }) };
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "ghostroute",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      {
        kind: "foreach",
        batch: 10,
        steps: [{ kind: "verify", verifier: "rejectAll" }],
        onReject: [{ when: {}, to: "never-registered" }],
      },
    ],
  });
  await assert.rejects(
    engine.runPipeline("ghostroute", { runtime: rt, defaultModel: "flash", verifiers: [rejectAll] }),
    /not a registered fragment/,
  );
});

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

test("gate false skips the remaining steps in the current scope", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const ran: string[] = [];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "gate",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "gate", when: async () => false },
      { kind: "transform", fn: async () => void ran.push("transform") },
      { kind: "agent", prompt: MATCH_PROMPT, model: "flash" },
    ],
  });

  const out = await engine.runPipeline("gate", { runtime: rt, defaultModel: "flash" });

  assert.deepEqual(ran, []);
  assert.equal(rt.calls.length, 0);
  assert.deepEqual(ids(out.skipped), ["a"]);
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.accepted, []);
});

test("gate false inside a foreach aborts that batch's body only", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "gatebatch",
    adapter: "test",
    plan: async () => [item("a"), item("b")],
    steps: [
      {
        kind: "foreach",
        batch: 1,
        steps: [{ kind: "gate", when: () => false }, { kind: "agent", prompt: MATCH_PROMPT, model: "flash" }],
      },
    ],
  });

  const out = await engine.runPipeline("gatebatch", { runtime: rt, defaultModel: "flash" });

  assert.equal(rt.calls.length, 0);
  assert.deepEqual(ids(out.skipped), ["a", "b"]);
});

test("gate true lets the remaining steps run", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "gatepass",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "gate", when: (ctx) => ctx.items.length === 1 },
      { kind: "agent", prompt: MATCH_PROMPT, model: "flash" },
    ],
  });

  await engine.runPipeline("gatepass", { runtime: rt, defaultModel: "flash" });

  assert.equal(rt.calls.length, 1);
});

// ---------------------------------------------------------------------------
// select + foreach.from
// ---------------------------------------------------------------------------

test("select stores a binding consumed by foreach.from (dynamic targeting)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const all = [item("a", { status: "MATCHED" }), item("b", { status: "SKIPPED" }), item("c", { status: "MATCHED" })];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "sel",
    adapter: "test",
    plan: async () => all,
    steps: [
      { kind: "select", into: "chosen", selector: { filter: { status: ["MATCHED"] } } },
      {
        kind: "foreach",
        from: "chosen",
        batch: 1,
        steps: [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }],
      },
    ],
  });

  const out = await engine.runPipeline("sel", {
    runtime: rt,
    defaultModel: "flash",
    select: async (sel) => all.filter((i) => sel.filter?.status?.includes(i.status) ?? true),
  });

  assert.equal(rt.calls.length, 2); // a and c, one batch each
  const prompts = rt.calls.map((c) => c.prompt).join("\n");
  assert.match(prompts, /- a\b/);
  assert.match(prompts, /- c\b/);
  assert.doesNotMatch(prompts, /- b\b/);
  // b was never selected into the binding: it stays in play (unprocessed),
  // while a and c (agent-only body, no verifier) remain unaccepted.
  assert.deepEqual(ids(out.rejected).sort(), ["a", "b", "c"]);
});

test("foreach.from with a missing binding throws a clear error", async () => {
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "nobinding",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "foreach", from: "nope", batch: 10, steps: [] },
    ],
  });
  await assert.rejects(
    engine.runPipeline("nobinding", { runtime: new MockAgentRuntime({ flash: FLASH }), defaultModel: "flash" }),
    /no binding "nope"/,
  );
});

// ---------------------------------------------------------------------------
// route graph validation
// ---------------------------------------------------------------------------

test("route cycles are rejected at register time", () => {
  // Two fragments that route to each other.
  const e1 = new PipelineEngine();
  e1.registerFragment("a", [{ kind: "foreach", batch: 1, steps: [], onReject: [{ to: "b" }] }]);
  assert.throws(
    () => e1.registerFragment("b", [{ kind: "foreach", batch: 1, steps: [], onReject: [{ to: "a" }] }]),
    /route cycle: b -> a -> b/,
  );

  // Self-loop.
  const e2 = new PipelineEngine();
  assert.throws(
    () => e2.registerFragment("x", [{ kind: "foreach", batch: 1, steps: [], onReject: [{ to: "x" }] }]),
    /route cycle/,
  );

  // Pipeline -> fragment -> pipeline.
  const e3 = new PipelineEngine();
  e3.registerFragment("f", [{ kind: "foreach", batch: 1, steps: [], onReject: [{ to: "p" }] }]);
  assert.throws(
    () =>
      e3.registerPipeline({
        id: "p",
        adapter: "test",
        plan: async () => [],
        steps: [{ kind: "foreach", batch: 1, steps: [], onReject: [{ to: "f" }] }],
      }),
    /route cycle: p -> f -> p/,
  );

  // A valid acyclic ladder is accepted.
  const e4 = new PipelineEngine();
  e4.registerFragment("b", [{ kind: "foreach", batch: 1, steps: [], onReject: [{ to: "c" }] }]);
  e4.registerFragment("a", [{ kind: "foreach", batch: 1, steps: [], onReject: [{ to: "b" }] }]);
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// misc engine behaviour
// ---------------------------------------------------------------------------

test("agent step model overrides the run's default model", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH, hard: HARD });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "models",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "agent", prompt: MATCH_PROMPT },
      { kind: "agent", prompt: MATCH_PROMPT, model: "hard" },
    ],
  });

  await engine.runPipeline("models", { runtime: rt, defaultModel: "flash" });

  assert.deepEqual(rt.calls.map((c) => c.model), ["flash", "hard"]);
});

test("runPipeline rejects unknown pipeline ids", async () => {
  const engine = new PipelineEngine();
  await assert.rejects(
    engine.runPipeline("ghost", { runtime: new MockAgentRuntime({ flash: FLASH }), defaultModel: "flash" }),
    /pipeline "ghost" is not registered/,
  );
});

test("transform mutates ctx.items in place for the following steps", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "mutate",
    adapter: "test",
    plan: async () => [item("a"), item("b")],
    steps: [
      { kind: "transform", fn: async (ctx) => void (ctx.items = ctx.items.slice(1)) },
      { kind: "agent", prompt: MATCH_PROMPT, model: "flash" },
    ],
  });

  await engine.runPipeline("mutate", { runtime: rt, defaultModel: "flash" });

  assert.equal(rt.calls.length, 1);
  assert.match(rt.calls[0]!.prompt, /- b\b/);
  assert.doesNotMatch(rt.calls[0]!.prompt, /- a\b/);
});

test("ctx.run executes a sub-step over given items without disturbing scope items", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  const seen: string[][] = [];
  engine.registerPipeline({
    id: "ctxrun",
    adapter: "test",
    plan: async () => [item("ok-1"), item("bad-1")],
    steps: [
      {
        kind: "transform",
        fn: async (ctx) => {
          const sub = await ctx.run({ kind: "verify", verifier: "acceptOk" }, [item("bad-1"), item("ok-2")]);
          seen.push(ids(sub.accepted), ids(sub.rejected));
        },
      },
      { kind: "agent", prompt: MATCH_PROMPT, model: "flash" },
    ],
  });

  await engine.runPipeline("ctxrun", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: [acceptOk],
  });

  assert.deepEqual(seen, [["ok-2"], ["bad-1"]]);
  // The scope's own items were unaffected by the sub-run.
  assert.equal(rt.calls.length, 1);
  assert.match(rt.calls[0]!.prompt, /- ok-1\b/);
  assert.match(rt.calls[0]!.prompt, /- bad-1\b/);
});

test("shell step receives ctx.items and its output lines are logged", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const logs: Array<[string, string]> = [];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "shell",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      {
        kind: "shell",
        run: async (ctx) => [`shell saw ${ids(ctx.items).join(",")}`],
      },
    ],
  });

  await engine.runPipeline("shell", {
    runtime: rt,
    defaultModel: "flash",
    log: (level, msg) => logs.push([level, msg]),
  });

  assert.ok(logs.some(([, msg]) => msg === "shell saw a"));
});

test("plan can use ctx.select to produce the initial items", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const all = [item("g1", { status: "GOOD" }), item("g2", { status: "GOOD" }), item("n1", { status: "MEH" })];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "planselect",
    adapter: "test",
    plan: async (ctx: StepCtx) => ctx.select({ filter: { status: ["GOOD"] } }),
    steps: [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }],
  });

  await engine.runPipeline("planselect", {
    runtime: rt,
    defaultModel: "flash",
    select: async (sel) => all.filter((i) => sel.filter?.status?.includes(i.status) ?? true),
  });

  assert.equal(rt.calls.length, 1);
  assert.match(rt.calls[0]!.prompt, /- g1\b/);
  assert.match(rt.calls[0]!.prompt, /- g2\b/);
  assert.doesNotMatch(rt.calls[0]!.prompt, /- n1\b/);
});

test("agent step exposes the last result (text + usage) on ctx", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  let seen: unknown = null;
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "lastagent",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "agent", prompt: MATCH_PROMPT, model: "flash" },
      {
        kind: "transform",
        fn: async (ctx) => {
          seen = (ctx as StepCtx & { lastAgentResult?: { model: string; text: string; usage: unknown } })
            .lastAgentResult;
        },
      },
    ],
  });

  await engine.runPipeline("lastagent", { runtime: rt, defaultModel: "flash" });

  const result = seen as { model: string; text: string; usage: { input: number; output: number } };
  assert.equal(result.model, "flash");
  assert.match(result.text, /^echo: /); // deterministic mock reply
  assert.ok(result.usage.input > 0);
});

test("definePipeline is an identity helper for pipeline definitions", () => {
  const pipeline = {
    id: "id",
    adapter: "test",
    plan: async () => [] as WorkItem[],
    steps: [],
  };
  assert.equal(definePipeline(pipeline), pipeline);
});

// ---------------------------------------------------------------------------
// agent step tools (SPEC §10)
// ---------------------------------------------------------------------------

test("agent step forwards tools to the runtime session", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "tools",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash", tools: ["read", "bash"] }],
  });

  await engine.runPipeline("tools", { runtime: rt, defaultModel: "flash" });

  assert.equal(rt.calls.length, 1);
  assert.deepEqual(rt.calls[0]!.tools, ["read", "bash"]);
});

// ---------------------------------------------------------------------------
// when.status: [] (SPEC §10: an empty predicate matches nothing)
// ---------------------------------------------------------------------------

test("when.status: [] matches nothing (never a silent catch-all)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH, hard: HARD });
  const rejectAll: Verifier = {
    id: "rejectAll",
    verify: async () => ({ accepted: false, evidence: {} }),
  };
  const engine = new PipelineEngine();
  engine.registerFragment("empty-status", [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }]);
  engine.registerFragment("catch-all", [{ kind: "agent", prompt: MATCH_PROMPT, model: "hard" }]);
  engine.registerPipeline({
    id: "emptystatus",
    adapter: "test",
    plan: async () => [item("x", { status: "FAILED" })],
    steps: [
      {
        kind: "foreach",
        batch: 10,
        steps: [{ kind: "verify", verifier: "rejectAll" }],
        onReject: [
          { when: { status: [] }, to: "empty-status", model: "flash" },
          { when: {}, to: "catch-all", model: "hard" },
        ],
      },
    ],
  });

  const out = await engine.runPipeline("emptystatus", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: [rejectAll],
  });

  // The empty status list never matches: the item falls through to the
  // catch-all route (hard model), never to the empty-status fragment.
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0]!.model, "hard");
  assert.match(rt.calls[0]!.prompt, /- x\b/);
  assert.deepEqual(ids(out.rejected), ["x"]);
});

// ---------------------------------------------------------------------------
// route maxAttempts keyed per route (SPEC §10)
// ---------------------------------------------------------------------------

test("route maxAttempts budgets are per-route: different routes to one fragment stay independent", async () => {
  const rejectAll: Verifier = {
    id: "rejectAll",
    verify: async () => ({ accepted: false, evidence: {} }),
  };
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerFragment("retry", [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }]);
  engine.registerPipeline({
    id: "perroute",
    adapter: "test",
    plan: async () => [item("bad-1", { status: "FAILED", size: 10 })],
    steps: [
      {
        kind: "foreach",
        batch: 10,
        steps: [{ kind: "verify", verifier: "rejectAll" }],
        onReject: [{ when: { sizeBelow: 100 }, to: "retry", maxAttempts: 1, model: "flash" }],
      },
      {
        kind: "foreach",
        batch: 10,
        steps: [{ kind: "verify", verifier: "rejectAll" }],
        onReject: [
          // Decoy at index 0 (never matches); the item hits route index 1.
          { when: { status: ["NEVER"] }, to: "retry", maxAttempts: 1, model: "flash" },
          { when: { status: ["FAILED"] }, to: "retry", maxAttempts: 1, model: "flash" },
        ],
      },
    ],
  });

  await engine.runPipeline("perroute", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: [rejectAll],
  });

  // Two DIFFERENT route slots (0:retry and 1:retry) each hold their own
  // maxAttempts=1 budget: the item routes once per slot → 2 fragment sessions.
  assert.equal(rt.calls.length, 2);
});

// ---------------------------------------------------------------------------
// lastAgentResult across scope boundaries (SPEC §10)
// ---------------------------------------------------------------------------

test("lastAgentResult from inside a foreach is visible to a transform after it", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  let seen: unknown = null;
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "lastforeach",
    adapter: "test",
    plan: async () => [item("a"), item("b")],
    steps: [
      {
        kind: "foreach",
        batch: 1,
        steps: [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }],
      },
      {
        kind: "transform",
        fn: async (ctx) => {
          seen = ctx.lastAgentResult;
        },
      },
    ],
  });

  await engine.runPipeline("lastforeach", { runtime: rt, defaultModel: "flash" });

  // The foreach body's agent turn was written through to the shared run state
  // and is visible to the outer scope's transform.
  const result = seen as { model: string; text: string };
  assert.ok(result !== undefined && result !== null);
  assert.equal(result.model, "flash");
  assert.match(result.text, /^echo: /); // deterministic mock reply
  assert.equal(rt.calls.length, 2); // one session per batch item
});

// ---------------------------------------------------------------------------
// triggers (SPEC §10)
// ---------------------------------------------------------------------------

test("unitComplete trigger fires the target pipeline when a unit's items are all accepted", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const fired: string[] = [];
  const acceptAll: Verifier = {
    id: "acceptAll",
    verify: async () => ({ accepted: true, evidence: {} }),
  };
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "final",
    adapter: "test",
    plan: async () => {
      fired.push("final");
      return [];
    },
    steps: [],
  });
  engine.registerPipeline({
    id: "detect",
    adapter: "test",
    plan: async () => [item("a", { unitId: "u1" }), item("b", { unitId: "u1" })],
    steps: [{ kind: "verify", verifier: "acceptAll" }],
    triggers: [{ when: "unitComplete", to: "final" }],
  });

  const out = await engine.runPipeline("detect", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: [acceptAll],
  });

  assert.deepEqual(ids(out.accepted).sort(), ["a", "b"]);
  assert.deepEqual(out.rejected, []);
  // Zero non-accepted items for unit u1 -> the trigger ran the target pipeline.
  assert.deepEqual(fired, ["final"]);
});

test("unitComplete trigger does not fire while a unit still has non-accepted items", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const fired: string[] = [];
  const rejectAll: Verifier = {
    id: "rejectAll",
    verify: async () => ({ accepted: false, evidence: {} }),
  };
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "final",
    adapter: "test",
    plan: async () => {
      fired.push("final");
      return [];
    },
    steps: [],
  });
  engine.registerPipeline({
    id: "detect",
    adapter: "test",
    plan: async () => [item("a", { unitId: "u1" }), item("b", { unitId: "u1" })],
    steps: [{ kind: "verify", verifier: "rejectAll" }],
    triggers: [{ when: "unitComplete", to: "final" }],
  });

  const out = await engine.runPipeline("detect", {
    runtime: rt,
    defaultModel: "flash",
    verifiers: [rejectAll],
  });

  // Both items stayed non-accepted: the unit is not complete, no trigger fired.
  assert.equal(out.accepted.length, 0);
  assert.deepEqual(fired, []);
});

test("unitComplete trigger fires exactly once per (pipeline, unit)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const fired: string[] = [];
  const acceptAll: Verifier = {
    id: "acceptAll",
    verify: async () => ({ accepted: true, evidence: {} }),
  };
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "final",
    adapter: "test",
    plan: async () => {
      fired.push("final");
      return [];
    },
    steps: [],
  });
  engine.registerPipeline({
    id: "detect",
    adapter: "test",
    plan: async () => [item("a", { unitId: "u1" })],
    steps: [{ kind: "verify", verifier: "acceptAll" }],
    triggers: [{ when: "unitComplete", to: "final" }],
  });
  const opts = { runtime: rt, defaultModel: "flash", verifiers: [acceptAll] };

  await engine.runPipeline("detect", opts);
  await engine.runPipeline("detect", opts);

  // The in-memory fired-set (M3; the durable events marker lands in M4)
  // dedupes the second run: the target ran exactly once.
  assert.deepEqual(fired, ["final"]);
});
