/**
 * M3 run-lifecycle tests (SPEC §11): `runPipelineWithBudget` wraps an engine
 * run with budget enforcement (abort on exceed), per-model pacing (order +
 * gaps via an injected fake clock), and resume (skip already-finished items at
 * the select() boundary).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, ModelSpec, Verifier, WorkItem } from "../src/types.js";
import { MockAgentRuntime, MockSession } from "../src/agent/mock.js";
import { RateLimiter, StaticModelRegistry } from "../src/agent/ratelimit.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import type { StepCtx } from "../src/pipeline/types.js";
import {
  BudgetExceededError,
  runPipelineWithBudget,
} from "../src/pipeline/run.js";

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

const MATCH_PROMPT = { template: "match" } as const;

// Shared temp style-guide file for the styleGuidePath threading test.
const GUIDE_CONTENT = "# Xenoblade style guide\n\nNever emit asm blocks.\n";
let tmpDir = "";
let guidePath = "";

test.before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "decompi-run-"));
  guidePath = join(tmpDir, "style-guide.md");
  await writeFile(guidePath, GUIDE_CONTENT, "utf8");
});

test.after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

test("budget exceeded aborts the run with BudgetExceededError", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [{ kind: "agent", prompt: MATCH_PROMPT }],
  });

  await assert.rejects(
    runPipelineWithBudget(engine, "p", {
      runtime: rt,
      defaultModel: "flash",
      // A 50µ$ cap passes the pre-step estimate (20µ$ at 10+10 tokens) but is
      // blown by the real turn (the mock measures usage in chars → ~1kµ$).
      budgetMicroUsd: 50,
      turnEstimate: { input: 10, output: 10 },
    }),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      const e = err as BudgetExceededError;
      assert.equal(e.limitMicroUsd, 50);
      // The turn really ran: the actual (over-limit) cost was recorded.
      assert.ok(e.spentMicroUsd > 1);
      return true;
    },
  );
  // The session did happen before the abort (charge comes after the turn).
  assert.equal(rt.calls.length, 1);
});

test("a tiny budget aborts BEFORE the first agent step (estimate pre-check)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [{ kind: "agent", prompt: MATCH_PROMPT }],
  });

  await assert.rejects(
    runPipelineWithBudget(engine, "p", {
      runtime: rt,
      defaultModel: "flash",
      budgetMicroUsd: 1, // far below the default 100k+20k token estimate
    }),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      const e = err as BudgetExceededError;
      assert.equal(e.limitMicroUsd, 1);
      // Nothing was spent and no session was created: the abort is pre-step.
      assert.equal(e.spentMicroUsd, 0);
      return true;
    },
  );
  assert.equal(rt.calls.length, 0);
});

test("an unresolvable model is a hard error, never a silent zero-cost charge", async () => {
  const rt = new MockAgentRuntime(); // no models registered: resolveModel -> null
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [{ kind: "agent", prompt: MATCH_PROMPT }],
  });

  await assert.rejects(
    runPipelineWithBudget(engine, "p", {
      runtime: rt,
      defaultModel: "ghost",
      budgetMicroUsd: 10_000_000,
    }),
    /resolveModel returned null \(unknown cost ≠ zero cost\)/,
  );
  // The run aborted before any session or spend.
  assert.equal(rt.calls.length, 0);
});

test("a run within budget completes with full results", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const acceptAll: Verifier = {
    id: "acceptAll",
    verify: async () => ({ accepted: true, evidence: {} }),
  };
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async () => [item("a"), item("b")],
    steps: [
      {
        kind: "foreach",
        batch: 5,
        steps: [
          { kind: "agent", prompt: MATCH_PROMPT },
          { kind: "verify", verifier: "acceptAll" },
        ],
      },
    ],
  });

  const out = await runPipelineWithBudget(engine, "p", {
    runtime: rt,
    defaultModel: "flash",
    budgetMicroUsd: 10_000_000, // generous
    verifiers: [acceptAll],
  });

  assert.equal(rt.calls.length, 1);
  assert.deepEqual(
    out.accepted.map((i) => i.id).sort(),
    ["a", "b"],
  );
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.skipped, []);
});

// ---------------------------------------------------------------------------
// pacing
// ---------------------------------------------------------------------------

test("pacing: each agent step awaits the per-model rate limiter in order", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  let t = 0;
  const rateLimiter = new RateLimiter(new StaticModelRegistry({ flash: 60 }), {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "agent", prompt: MATCH_PROMPT },
      { kind: "agent", prompt: MATCH_PROMPT },
      { kind: "agent", prompt: MATCH_PROMPT },
    ],
  });

  const out = await runPipelineWithBudget(engine, "p", {
    runtime: rt,
    defaultModel: "flash",
    rateLimiter,
  });

  assert.equal(rt.calls.length, 3);
  assert.deepEqual(
    rt.calls.map((c) => c.model),
    ["flash", "flash", "flash"],
  );
  // now() at each release, strictly one interval apart, in acquire order.
  // Each of the 3 sessions is paced twice: once at createSession and once at
  // its prompt() (per-request pacing), so 6 requests leave one interval apart.
  assert.deepEqual(rateLimiter.releases.get("flash"), [0, 1000, 2000, 3000, 4000, 5000]);
  assert.equal(t, 5000);
  // No verifier ran: the item stays in play.
  assert.deepEqual(out.rejected.map((i) => i.id), ["a"]);
});

test("pacing: every prompt on a session is paced, not just session creation", async () => {
  let t = 0;
  const rateLimiter = new RateLimiter(new StaticModelRegistry({ flash: 60 }), {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  });
  // A runtime that reuses ONE session across every createSession: the engine
  // prompts the same session twice, so per-request pacing must acquire twice
  // per session (createSession + prompt) instead of once.
  const shared = new MockSession();
  const rt: AgentRuntime = {
    resolveModel: async () => FLASH,
    createSession: async () => shared,
  };
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "agent", prompt: MATCH_PROMPT },
      { kind: "agent", prompt: MATCH_PROMPT },
    ],
  });

  await runPipelineWithBudget(engine, "p", {
    runtime: rt,
    defaultModel: "flash",
    rateLimiter,
  });

  // 2 createSession + 2 prompt acquires = 4 paced requests on one session.
  assert.deepEqual(rateLimiter.releases.get("flash"), [0, 1000, 2000, 3000]);
  assert.equal(t, 3000);
  assert.equal(shared.promptHistory.length, 2);
});

test("budget and pacing compose in a single run", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  let t = 0;
  const rateLimiter = new RateLimiter(new StaticModelRegistry({ flash: 60 }), {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "agent", prompt: MATCH_PROMPT },
      { kind: "agent", prompt: MATCH_PROMPT },
    ],
  });

  await runPipelineWithBudget(engine, "p", {
    runtime: rt,
    defaultModel: "flash",
    budgetMicroUsd: 10_000_000,
    rateLimiter,
  });

  assert.equal(rt.calls.length, 2);
  // 2 sessions × (createSession + prompt) acquires.
  assert.deepEqual(rateLimiter.releases.get("flash"), [0, 1000, 2000, 3000]);
});

// ---------------------------------------------------------------------------
// style guide threading (SPEC §12)
// ---------------------------------------------------------------------------

test("styleGuidePath is threaded into agent prompts (non-empty styleGuideHash)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  let seen: { styleGuideHash?: string; model?: string } | null = null;
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "sg",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "agent", prompt: MATCH_PROMPT },
      {
        kind: "transform",
        fn: async (ctx) => {
          seen = (ctx as StepCtx & { lastAgentResult?: { styleGuideHash?: string; model?: string } })
            .lastAgentResult;
        },
      },
    ],
  });

  await runPipelineWithBudget(engine, "sg", {
    runtime: rt,
    defaultModel: "flash",
    styleGuidePath: guidePath,
  });

  // The agent turn carries a non-empty sha256 of the injected guide, and the
  // rendered prompt actually contains it (SPEC §12: the file is the source of
  // truth, injected into the system portion).
  assert.ok(seen !== null);
  assert.equal(typeof seen!.styleGuideHash, "string");
  assert.ok((seen!.styleGuideHash ?? "").length > 0);
  assert.equal(seen!.model, "flash");
  assert.match(rt.calls[0]!.prompt, /## Style guide/);
  assert.match(rt.calls[0]!.prompt, /Never emit asm blocks\./);
});

test("no styleGuidePath: agent prompts carry an empty styleGuideHash", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  let seen: { styleGuideHash?: string } | null = null;
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "sg",
    adapter: "test",
    plan: async () => [item("a")],
    steps: [
      { kind: "agent", prompt: MATCH_PROMPT },
      {
        kind: "transform",
        fn: async (ctx) => {
          seen = (ctx as StepCtx & { lastAgentResult?: { styleGuideHash?: string } })
            .lastAgentResult;
        },
      },
    ],
  });

  await runPipelineWithBudget(engine, "sg", { runtime: rt, defaultModel: "flash" });

  assert.ok(seen !== null);
  assert.equal(seen!.styleGuideHash, "");
  assert.doesNotMatch(rt.calls[0]!.prompt, /## Style guide/);
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

test("resume skips already-finished items at the select() boundary", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const logs: string[] = [];
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async (ctx) => ctx.select({ filter: { status: ["NOT_STARTED"] } }),
    steps: [
      {
        kind: "foreach",
        batch: 5,
        steps: [{ kind: "agent", prompt: MATCH_PROMPT }],
      },
    ],
  });
  const all = [item("a"), item("b"), item("c"), item("d")];

  const out = await runPipelineWithBudget(engine, "p", {
    runtime: rt,
    defaultModel: "flash",
    select: async () => all,
    resumeState: { doneItems: new Set(["a", "c"]), stepIndex: 2 },
    log: (_level, msg) => logs.push(msg),
  });

  // Only the unfinished items reached the agent, in one batch session.
  assert.equal(rt.calls.length, 1);
  assert.match(rt.calls[0]!.prompt, /- b\b/);
  assert.match(rt.calls[0]!.prompt, /- d\b/);
  assert.doesNotMatch(rt.calls[0]!.prompt, /- a\b/);
  assert.doesNotMatch(rt.calls[0]!.prompt, /- c\b/);
  assert.deepEqual(
    out.rejected.map((i) => i.id).sort(),
    ["b", "d"],
  );
  assert.ok(logs.some((m) => m.includes("resume: skipped 2 already-finished item(s)")));
});

test("resume with an empty doneItems set passes everything through", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async (ctx) => ctx.select({ filter: { status: ["NOT_STARTED"] } }),
    steps: [
      {
        kind: "foreach",
        batch: 5,
        steps: [{ kind: "agent", prompt: MATCH_PROMPT }],
      },
    ],
  });
  const all = [item("a"), item("b")];

  const out = await runPipelineWithBudget(engine, "p", {
    runtime: rt,
    defaultModel: "flash",
    select: async () => all,
    resumeState: { doneItems: new Set(), stepIndex: 0 },
  });

  assert.equal(rt.calls.length, 1);
  assert.match(rt.calls[0]!.prompt, /- a\b/);
  assert.match(rt.calls[0]!.prompt, /- b\b/);
  assert.deepEqual(
    out.rejected.map((i) => i.id).sort(),
    ["a", "b"],
  );
});

test("no resumeState: select() passes through unchanged", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "test",
    plan: async (ctx) => ctx.select({ filter: { status: ["NOT_STARTED"] } }),
    steps: [
      {
        kind: "foreach",
        batch: 5,
        steps: [{ kind: "agent", prompt: MATCH_PROMPT }],
      },
    ],
  });
  const all = [item("a"), item("b"), item("c")];

  await runPipelineWithBudget(engine, "p", {
    runtime: rt,
    defaultModel: "flash",
    select: async () => all,
  });

  assert.equal(rt.calls.length, 1);
  assert.match(rt.calls[0]!.prompt, /- a\b/);
  assert.match(rt.calls[0]!.prompt, /- b\b/);
  assert.match(rt.calls[0]!.prompt, /- c\b/);
});
