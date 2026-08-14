/**
 * Dynamic Reprompt Policy — engine consumption (SPEC §A.1/§A.5):
 *
 *  (a) `foreach.setup` batchSize sub-division: a 5-item batch drawn at
 *      `batch: 5` with `setup → {batchSize: 2}` processes 2 and spills 3
 *      back to the FRONT of the queue; the next windows are drawn from the
 *      ordered remainder (2, then 1) — every processed window ≤ 2, setup
 *      runs once per drawn window, and order/grouping is never re-shuffled;
 *  (b) `setup.model` forks the batch ctx: the batch's `agentLoop` session is
 *      created with the setup model (checked on the MockAgentRuntime's
 *      createSession) — `setup.model` > run `defaultModel` (SPEC §A.1);
 *  (c) `agentLoop` `final`+feedback: the feedback is delivered as ONE
 *      write-only turn — counted on the session's promptHistory — the reply
 *      is NOT re-evaluated (reprompt runs exactly once, and no AgentTurn is
 *      produced), and the still-in-play items return as rejected, routed at
 *      the enclosing foreach level (single routing);
 *  (d) `setup.rejectionRetries` overrides the batch's `agentLoop` cap (a
 *      per-scope override the loop reads before its own `rejectionRetries`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelSpec, WorkItem } from "../src/types.js";
import { MockAgentRuntime, MockSession } from "../src/agent/mock.js";
import { PipelineEngine } from "../src/pipeline/engine.js";

const FLASH: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 20,
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

function ids(items: WorkItem[]): string[] {
  return items.map((i) => i.id);
}

/** Capture every MockSession a runtime creates (for promptHistory assertions). */
function captureSessions(rt: MockAgentRuntime): MockSession[] {
  const sessions: MockSession[] = [];
  const orig = rt.createSession.bind(rt);
  rt.createSession = async (opts) => {
    const session = (await orig(opts)) as MockSession;
    sessions.push(session);
    return session;
  };
  return sessions;
}

// ---------------------------------------------------------------------------
// (a) setup batchSize: sub-divide + spillover to the front of the queue
// ---------------------------------------------------------------------------

test("foreach.setup batchSize sub-divides; spillover returns to the front; setup runs once per window", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const items = [item("a"), item("b"), item("c"), item("d"), item("e")];
  const setupWindows: string[][] = []; // what setup saw, per drawn window
  const startWindows: string[][] = []; // what the body agentLoop saw, per window

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "setup-a",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "foreach",
        batch: 5,
        // Always sub-divide to 2: the 5-item batch becomes 2 + spill 3,
        // then 2 + spill 1, then 1 — three windows, all <= 2.
        setup: async (batch) => {
          setupWindows.push(ids(batch));
          return { batchSize: 2 };
        },
        steps: [
          {
            kind: "agentLoop",
            model: "flash",
            start: async (targets) => {
              startWindows.push(ids(targets));
              return `work on: ${ids(targets).join(",")}`;
            },
            reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
          },
        ],
      },
    ],
  });

  const out = await engine.runPipeline("setup-a", { runtime: rt, defaultModel: "flash" });

  // setup runs ONCE per drawn window, seeing the full drawn batch: first the
  // whole 5, then the spilled 3, then the spilled 1.
  assert.deepEqual(setupWindows, [
    ["a", "b", "c", "d", "e"],
    ["c", "d", "e"],
    ["e"],
  ]);
  // Every processed window <= 2 and order is preserved (never re-shuffled).
  assert.deepEqual(startWindows, [
    ["a", "b"],
    ["c", "d"],
    ["e"],
  ]);
  for (const window of startWindows) assert.ok(window.length <= 2);
  // Every item was processed exactly once; all accepted.
  assert.deepEqual(ids(out.accepted).sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(out.rejected, []);
});

test("foreach.setup rejects an invalid batchSize (< 1 or non-integer) with a clear error", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const rt = new MockAgentRuntime({ flash: FLASH });
    const engine = new PipelineEngine();
    engine.registerPipeline({
      id: `setup-bad-${String(bad)}`,
      adapter: "test",
      plan: async () => [item("a")],
      steps: [
        {
          kind: "foreach",
          batch: 1,
          setup: async () => ({ batchSize: bad }),
          steps: [
            {
              kind: "agentLoop",
              model: "flash",
              start: async () => "p",
              reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
            },
          ],
        },
      ],
    });
    await assert.rejects(
      engine.runPipeline(`setup-bad-${String(bad)}`, { runtime: rt, defaultModel: "flash" }),
      /setup\(\) returned an invalid batchSize.*integer >= 1/,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) setup.model forks the batch ctx (SPEC §A.1 precedence)
// ---------------------------------------------------------------------------

test("setup.model runs the batch's agentLoop under that model (over the run default)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH, "flash-low": FLASH });
  const items = [item("a"), item("b")];

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "setup-b",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "foreach",
        batch: 5,
        setup: async () => ({ model: "flash-low" }),
        steps: [
          {
            kind: "agentLoop",
            // Compiled workflows never set a step model: the run default is
            // "flash" and setup.model must win (SPEC §A.1 precedence).
            start: async (targets) => `start: ${ids(targets).join(",")}`,
            reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
          },
        ],
      },
    ],
  });

  const out = await engine.runPipeline("setup-b", { runtime: rt, defaultModel: "flash" });

  // The batch's ONE agentLoop session was created with the setup model.
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0]!.model, "flash-low");
  assert.deepEqual(ids(out.accepted).sort(), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// (c) agentLoop final+feedback: ONE write-only turn, no re-evaluation,
//     rejected items return (routed at the foreach level)
// ---------------------------------------------------------------------------

test("agentLoop final+feedback sends the feedback exactly once (write-only); the reply is not re-evaluated", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const sessions = captureSessions(rt);
  const items = [item("a"), item("b")];
  let repromptCalls = 0;
  let lastAgentTextAfterLoop: string | undefined;

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "final-c",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "foreach",
        batch: 2,
        steps: [
          {
            kind: "agentLoop",
            model: "flash",
            start: async (targets) => `start: ${ids(targets).join(",")}`,
            reprompt: async (targets, _ctx, _turn) => {
              repromptCalls += 1;
              return {
                accepted: [],
                rejected: targets,
                feedback: "wrap it up",
                final: true,
              };
            },
          },
        ],
      },
      // After the loop: the lastAgentResult must still be the LAST
      // EVALUATED turn — the write-only reply was never turned into an
      // AgentTurn (SPEC §A.5 "the response is NOT re-evaluated").
      {
        kind: "transform",
        fn: async (ctx) => {
          lastAgentTextAfterLoop = ctx.lastAgentResult?.text;
        },
      },
    ],
  });

  const out = await engine.runPipeline("final-c", { runtime: rt, defaultModel: "flash" });

  // ONE agentLoop session with exactly TWO prompts: the start prompt, then
  // the single write-only wrap-up turn. reprompt ran exactly ONCE — the
  // write-only reply was never fed back into the loop.
  assert.equal(repromptCalls, 1);
  assert.equal(rt.calls.length, 1);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]!.promptHistory, ["start: a,b", "wrap it up"]);
  // No AgentTurn was produced for the wrap-up reply.
  assert.equal(lastAgentTextAfterLoop, "echo: start: a,b");
  assert.doesNotMatch(lastAgentTextAfterLoop ?? "", /wrap it up/);
  // Nothing accepted; the still-in-play items return as rejected (the
  // enclosing foreach is the single routing boundary — no onReject here, so
  // they surface at the run level).
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(ids(out.rejected).sort(), ["a", "b"]);
});

test("agentLoop final without feedback sends NO write-only turn (still routes inPlay)", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const sessions = captureSessions(rt);
  const items = [item("x"), item("y")];

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "final-c2",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "foreach",
        batch: 2,
        steps: [
          {
            kind: "agentLoop",
            model: "flash",
            start: async (targets) => `start: ${ids(targets).join(",")}`,
            reprompt: async (targets) => ({
              accepted: [],
              rejected: targets,
              final: true,
            }),
          },
        ],
      },
    ],
  });

  const out = await engine.runPipeline("final-c2", { runtime: rt, defaultModel: "flash" });

  // Only the start prompt was delivered: final without feedback sends nothing.
  assert.equal(rt.calls.length, 1);
  assert.deepEqual(sessions[0]!.promptHistory, ["start: x,y"]);
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(ids(out.rejected).sort(), ["x", "y"]);
});

// ---------------------------------------------------------------------------
// (d) setup.rejectionRetries overrides the batch's agentLoop cap
// ---------------------------------------------------------------------------

test("setup.rejectionRetries overrides the batch's agentLoop rejectionRetries", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const sessions = captureSessions(rt);
  const items = [item("a"), item("b")];

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "setup-d",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "foreach",
        batch: 2,
        // The step's own cap is 1; the per-batch override raises it to 3.
        setup: async () => ({ rejectionRetries: 3 }),
        steps: [
          {
            kind: "agentLoop",
            model: "flash",
            rejectionRetries: 1,
            start: async (targets) => `start: ${ids(targets).join(",")}`,
            reprompt: async (targets) => ({
              accepted: [],
              rejected: targets,
              feedback: "try again",
            }),
          },
        ],
      },
    ],
  });

  const out = await engine.runPipeline("setup-d", { runtime: rt, defaultModel: "flash" });

  // Without the override the loop would break after 1 turn (start + one
  // feedback). The override lifts it to 3 turns: start + two re-prompts on
  // the ONE session, then the still-in-play items return as rejected.
  assert.equal(rt.calls.length, 1);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]!.promptHistory, ["start: a,b", "try again", "try again"]);
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(ids(out.rejected).sort(), ["a", "b"]);
});
