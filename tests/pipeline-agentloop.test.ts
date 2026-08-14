/**
 * `agentLoop` step tests (SPEC §4): the session-holding re-prompt primitive.
 * Covers: accept/reject split with `final:true` (accepted finalized, the
 * remainder routed through onReject); `rejectionRetries=2` continuation on
 * feedback (reject → accept on the SAME session); and cap-exhausted routing
 * when a reprompt never finalizes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelSpec, WorkItem } from "../src/types.js";
import { MockAgentRuntime, MockSession } from "../src/agent/mock.js";
import { PipelineEngine, type AgentTurn } from "../src/pipeline/engine.js";

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

const MATCH_PROMPT = { template: "match" } as const;

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
// accept/reject split + final:true
// ---------------------------------------------------------------------------

test("agentLoop: accepted items are finalized; final:true routes the remainder through onReject", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const sessions = captureSessions(rt);
  const items = [item("a"), item("b"), item("c"), item("d"), item("e")];
  const finalized: Array<[string, unknown]> = [];

  const engine = new PipelineEngine();
  // Agent-only retry fragment: routed items reach it but are still unaccepted.
  engine.registerFragment("retry", [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }]);
  engine.registerPipeline({
    id: "loop-a",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "foreach",
        batch: 5,
        steps: [
          {
            kind: "agentLoop",
            model: "flash",
            start: async (targets) => `work on: ${ids(targets).join(",")}`,
            reprompt: async (targets, _ctx, _lastTurn) => ({
              accepted: targets.slice(0, 3),
              rejected: targets.slice(3),
              feedback: "fix the rest",
              final: true,
            }),
          },
        ],
        onReject: [{ when: {}, to: "retry", model: "flash" }],
      },
    ],
  });

  const out = await engine.runPipeline("loop-a", {
    runtime: rt,
    defaultModel: "flash",
    finalize: async (it, action) => void finalized.push([it.id, action]),
  });

  // ONE agentLoop session (start prompt seeds it), then one retry-fragment
  // session for the routed remainder. `final:true` cut the loop at turn 1 —
  // but its feedback was still delivered as ONE write-only wrap-up turn
  // (SPEC §A.5), so the session saw exactly two prompts.
  assert.equal(rt.calls.length, 2);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0]!.promptHistory, ["work on: a,b,c,d,e", "fix the rest"]);
  for (const i of items) assert.match(rt.calls[0]!.prompt, new RegExp(i.id));
  // The 3 accepted items were finalized with the promote action.
  assert.deepEqual(
    finalized.map(([id]) => id).sort(),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    finalized.map(([, action]) => action),
    [{ promote: true }, { promote: true }, { promote: true }],
  );
  // The 2 rejected items were routed to the retry fragment and stay rejected.
  assert.deepEqual(ids(out.accepted).sort(), ["a", "b", "c"]);
  assert.deepEqual(ids(out.rejected).sort(), ["d", "e"]);
  assert.match(rt.calls[1]!.prompt, /- d\b/);
  assert.match(rt.calls[1]!.prompt, /- e\b/);
  assert.doesNotMatch(rt.calls[1]!.prompt, /- a\b/);
});

// ---------------------------------------------------------------------------
// rejectionRetries continuation on one session
// ---------------------------------------------------------------------------

test("agentLoop: rejectionRetries=2 rejects on turn 1, accepts on turn 2 — one session, 2 prompts", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const sessions = captureSessions(rt);
  const items = [item("a"), item("b"), item("c"), item("d"), item("e")];
  const finalized: string[] = [];
  let lastTurn: AgentTurn | undefined;
  let repromptCalls = 0;

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "loop-b",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "agentLoop",
        model: "flash",
        rejectionRetries: 2,
        start: async (targets) => `batch: ${ids(targets).join(",")}`,
        reprompt: async (targets, _ctx, turn) => {
          lastTurn = turn;
          repromptCalls += 1;
          if (repromptCalls === 1) {
            // Reject everything with feedback: the next turn is a re-prompt.
            return { accepted: [], rejected: targets, feedback: "please accept" };
          }
          return { accepted: targets, rejected: [] };
        },
      },
    ],
  });

  const out = await engine.runPipeline("loop-b", {
    runtime: rt,
    defaultModel: "flash",
    finalize: async (it) => void finalized.push(it.id),
  });

  // One session, two prompts on it: the start prompt, then the feedback.
  assert.equal(rt.calls.length, 1);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]!.promptHistory, [
    "batch: a,b,c,d,e",
    "please accept",
  ]);
  // The reprompt saw the loop's AgentTurn (model + the mock's reply + usage).
  assert.ok(lastTurn !== undefined);
  assert.equal(lastTurn.model, "flash");
  assert.match(lastTurn.text, /^echo: /);
  assert.ok(lastTurn.usage.input > 0);
  // Turn 2 accepted everything: all 5 finalized, nothing rejected.
  assert.deepEqual(ids(out.accepted).sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(finalized.sort(), ["a", "b", "c", "d", "e"]);
});

// ---------------------------------------------------------------------------
// never-final reprompt loops until the cap, then routes
// ---------------------------------------------------------------------------

test("agentLoop: a reprompt that never finalizes loops on feedback until the cap then routes inPlay", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const sessions = captureSessions(rt);
  const items = [item("x"), item("y")];
  const finalized: string[] = [];

  const engine = new PipelineEngine();
  engine.registerFragment("retry", [{ kind: "agent", prompt: MATCH_PROMPT, model: "flash" }]);
  engine.registerPipeline({
    id: "loop-c",
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
            // Turn 1 rejects (feedback) -> turn 2 hits the cap and routes.
            rejectionRetries: 2,
            start: async (targets) => `start: ${ids(targets).join(",")}`,
            reprompt: async (targets) => ({
              accepted: [],
              rejected: targets,
              feedback: "try again",
            }),
          },
        ],
        onReject: [{ when: {}, to: "retry", model: "flash" }],
      },
    ],
  });

  const out = await engine.runPipeline("loop-c", {
    runtime: rt,
    defaultModel: "flash",
    finalize: async (it) => void finalized.push(it.id),
  });

  // Two turns on ONE agentLoop session (start + feedback), then the cap routed
  // the still-in-play items to the retry fragment (its own session).
  assert.equal(rt.calls.length, 2);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]!.promptHistory.length, 2);
  assert.deepEqual(sessions[0]!.promptHistory, ["start: x,y", "try again"]);
  // Nothing was ever accepted: the finalize writer never ran.
  assert.deepEqual(finalized, []);
  // The retry fragment saw both in-play items; the agent-only body keeps them
  // rejected at the run level.
  assert.match(rt.calls[1]!.prompt, /- x\b/);
  assert.match(rt.calls[1]!.prompt, /- y\b/);
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(ids(out.rejected).sort(), ["x", "y"]);
});
