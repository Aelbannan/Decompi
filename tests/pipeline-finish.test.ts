/**
 * Pipeline `finish` built-in tool tests (SPEC §B.4) + the `complete?` accept
 * fix (SPEC §A.4): the engine-owned `finish(targetIds)` handler records ids
 * per prompt() turn; after EVERY prompt() — including the `final` write-only
 * turn — the engine unions them into accepted (each finalized with the
 * step's `completionStatus`), removes them from inPlay BEFORE the
 * empty/final/cap checks, then continues. Unknown ids are logged + ignored.
 * Workflow custom tools shadowing a core-reserved name (finish/select/
 * status/lint) fail at compile time; accepted verdict items go through the
 * workflow's `complete` decider before finalize.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { ModelSpec, WorkItem } from "../src/types.js";
import { MockAgentRuntime, MockSession } from "../src/agent/mock.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import { compileWorkflow } from "../src/workflow/compile.js";
import { Workflow } from "../src/workflow/types.js";
import type { Tool } from "../src/workflow/types.js";

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

/** Intercept createSession so the caller can seed the session's script. */
function scriptedSessions(
  rt: MockAgentRuntime,
  script: () => Array<{ type: "tool"; name: string; args: Record<string, unknown> } | { type: "reply"; text: string }>,
): MockSession[] {
  const sessions: MockSession[] = [];
  const orig = rt.createSession.bind(rt);
  rt.createSession = async (opts) => {
    const session = (await orig(opts)) as MockSession;
    session.setScript(script());
    sessions.push(session);
    return session;
  };
  return sessions;
}

// ---------------------------------------------------------------------------
// (b) finish drains: accepted with completionStatus, remaining items continue
// ---------------------------------------------------------------------------

test("agentLoop: finish(['t2']) accepts t2 with completionStatus; t1/t3 continue to the next turn", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const items = [item("t1"), item("t2"), item("t3")];
  const finalized: Array<[string, unknown]> = [];
  const repromptTargets: string[][] = [];
  const sessions = scriptedSessions(rt, () => [
    // Turn 1: the agent calls finish(["t2"]) then replies.
    { type: "tool", name: "finish", args: { targetIds: ["t2"] } },
    { type: "reply", text: "t2 is done" },
    // Turn 2: the agent accepts the rest.
    { type: "reply", text: "accept the rest" },
  ]);

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "finish-loop",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "agentLoop",
        model: "flash",
        completionStatus: "DONE",
        // Allow a second turn: the drain must not consume the retry budget.
        rejectionRetries: 2,
        start: async (targets) => `batch: ${ids(targets).join(",")}`,
        reprompt: async (targets) => {
          repromptTargets.push(ids(targets));
          if (repromptTargets.length === 1) {
            return { accepted: [], rejected: targets, feedback: "continue" };
          }
          return { accepted: targets, rejected: [] };
        },
      },
    ],
  });

  const out = await engine.runPipeline("finish-loop", {
    runtime: rt,
    defaultModel: "flash",
    finalize: async (it, action) => void finalized.push([it.id, action]),
  });

  // t2 was drained BEFORE the reprompt: the loop's reprompt never saw it.
  assert.deepEqual(repromptTargets, [
    ["t1", "t3"],
    ["t1", "t3"],
  ]);
  // One session; the drain did not end the loop (t1/t3 continued).
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]!.promptHistory, ["batch: t1,t2,t3", "continue"]);
  // Everything is accepted; t2 was finalized with completionStatus.
  assert.deepEqual(ids(out.accepted).sort(), ["t1", "t2", "t3"]);
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(
    finalized.map(([id]) => id).sort(),
    ["t1", "t2", "t3"],
  );
  assert.deepEqual(finalized.map(([, action]) => action), [
    { promote: true, status: "DONE" }, // finish drain (t2)
    { promote: true, status: "DONE" }, // verdict accept (t1)
    { promote: true, status: "DONE" }, // verdict accept (t3)
  ]);
});

test("agentLoop: finish ignores unknown ids (logged) and never accepts them", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const items = [item("t1"), item("t2"), item("t3")];
  const finalized: string[] = [];
  const logs: string[] = [];
  scriptedSessions(rt, () => [
    // "ghost" is not in the batch: must be logged + ignored.
    { type: "tool", name: "finish", args: { targetIds: ["t2", "ghost"] } },
    { type: "reply", text: "done" },
    { type: "reply", text: "accept the rest" },
  ]);

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "finish-unknown",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "agentLoop",
        model: "flash",
        rejectionRetries: 2,
        start: async () => "start",
        reprompt: async (targets) => {
          if (targets.length === 3) return { accepted: [], rejected: targets, feedback: "go on" };
          return { accepted: targets, rejected: [] };
        },
      },
    ],
  });

  const out = await engine.runPipeline("finish-unknown", {
    runtime: rt,
    defaultModel: "flash",
    log: (level, msg) => void logs.push(`${level}: ${msg}`),
    finalize: async (it) => void finalized.push(it.id),
  });

  assert.deepEqual(ids(out.accepted).sort(), ["t1", "t2", "t3"]);
  // ghost never finalized anything.
  assert.ok(!finalized.includes("ghost"));
  assert.ok(logs.some((l) => l.includes("ignored unknown id(s): ghost")));
});

test("agentLoop: finish ids from the final write-only turn are drained too", async () => {
  const rt = new MockAgentRuntime({ flash: FLASH });
  const items = [item("t1"), item("t2"), item("t3")];
  const finalized: string[] = [];
  scriptedSessions(rt, () => [
    // Turn 1 reply: verdict is final:true with feedback (wrap-up turn).
    { type: "reply", text: "wrap up" },
    // The write-only wrap-up turn: the agent finishes t3 before its reply.
    { type: "tool", name: "finish", args: { targetIds: ["t3"] } },
    { type: "reply", text: "ok" },
  ]);

  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "finish-final",
    adapter: "test",
    plan: async () => items,
    steps: [
      {
        kind: "agentLoop",
        model: "flash",
        completionStatus: "DONE",
        start: async () => "start",
        reprompt: async (targets) => ({
          // Verdict accepts t1; t2/t3 stay in play and the loop wraps up.
          accepted: targets.filter((t) => t.id === "t1"),
          rejected: targets.filter((t) => t.id !== "t1"),
          feedback: "wrap it up",
          final: true,
        }),
      },
    ],
  });

  const out = await engine.runPipeline("finish-final", {
    runtime: rt,
    defaultModel: "flash",
    finalize: async (it) => void finalized.push(it.id),
  });

  // t1 accepted by the verdict; t3 finished during the write-only turn;
  // t2 was never finished and routes as rejected.
  assert.deepEqual(ids(out.accepted).sort(), ["t1", "t3"]);
  assert.deepEqual(ids(out.rejected), ["t2"]);
  assert.deepEqual(finalized.sort(), ["t1", "t3"]);
});

// ---------------------------------------------------------------------------
// (c) reserved core names are compile-time errors
// ---------------------------------------------------------------------------

test("compileWorkflow: a custom tool named finish (or select/status/lint) fails to compile", () => {
  const shadow = (name: string): Tool => ({
    name,
    description: "shadow attempt",
    inputSchema: z.object({}),
    run: async () => undefined,
  });
  for (const name of ["finish", "select", "status", "lint"]) {
    const wf = new Workflow({
      id: `wf-shadow-${name}`,
      accepts: "function",
      customTools: [shadow(name)],
      startPrompt: async () => "p",
      reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
    });
    assert.throws(() => wf.compile(), /core-reserved/, `${name} must be rejected`);
  }
});

test("compileWorkflow: a non-reserved custom tool compiles onto the agentLoop step", () => {
  const tool: Tool = {
    name: "hexdiff",
    description: "diff one function",
    inputSchema: z.object({ unit: z.string(), symbol: z.string() }),
    run: async () => ({ mismatch_count: 0 }),
  };
  const wf = new Workflow({
    id: "wf-tools",
    accepts: "function",
    customTools: [tool],
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const { pipeline } = compileWorkflow(wf);
  const foreach = pipeline.steps[0]!;
  assert.equal(foreach.kind, "foreach");
  const loop = (foreach as { steps: unknown[] }).steps[0]! as Extract<
    ReturnType<typeof compileWorkflow>["pipeline"]["steps"][number],
    { kind: "agentLoop" }
  >;
  assert.equal(loop.kind, "agentLoop");
  assert.deepEqual(loop.customTools?.map((t) => t.name), ["hexdiff"]);
  // completionStatus defaults to the ladder's last status ("DONE").
  assert.equal(loop.completionStatus, "DONE");
});

// ---------------------------------------------------------------------------
// (d) the workflow `complete` decider is called on accept
// ---------------------------------------------------------------------------

test("agentLoop: the workflow complete hook is called per accepted target and its action is finalized", async () => {
  const completeCalls: Array<{ id: string }> = [];
  const wf = new Workflow({
    id: "wf-complete",
    accepts: "function",
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
    complete: async (target) => {
      completeCalls.push({ id: target.id });
      return { promote: true, status: "MATCHED", evidence: { workflow: "wf-complete" } };
    },
  });
  const { pipeline, fragments } = compileWorkflow(wf);
  const engine = new PipelineEngine();
  engine.registerPipeline(pipeline);
  for (const [id, steps] of fragments) engine.registerFragment(id, steps);

  const items = [item("f1"), item("f2")];
  const finalized: Array<[string, unknown]> = [];
  const out = await engine.runPipeline(wf.id, {
    runtime: new MockAgentRuntime({ flash: FLASH }),
    defaultModel: "flash",
    select: async () => items,
    finalize: async (it, action) => void finalized.push([it.id, action]),
  });

  // The decider ran once per accepted target.
  assert.deepEqual(
    completeCalls.map((c) => c.id).sort(),
    ["f1", "f2"],
  );
  assert.deepEqual(ids(out.accepted).sort(), ["f1", "f2"]);
  // The engine finalized with the hook's CompletionAction (status MATCHED),
  // not the shipped { promote: true } bypass.
  assert.deepEqual(finalized.map(([, action]) => action), [
    { promote: true, status: "MATCHED", evidence: { workflow: "wf-complete" } },
    { promote: true, status: "MATCHED", evidence: { workflow: "wf-complete" } },
  ]);
});

test("agentLoop: without a complete hook, accepted items finalize with the default promote + completionStatus", async () => {
  const wf = new Workflow({
    id: "wf-no-complete",
    accepts: "function",
    statuses: ["IN_PROGRESS", "DONE"],
    startPrompt: async () => "p",
    reprompt: async (targets) => ({ accepted: targets, rejected: [] }),
  });
  const { pipeline, fragments } = compileWorkflow(wf);
  const engine = new PipelineEngine();
  engine.registerPipeline(pipeline);
  for (const [id, steps] of fragments) engine.registerFragment(id, steps);

  const items = [item("g1")];
  const finalized: Array<[string, unknown]> = [];
  await engine.runPipeline(wf.id, {
    runtime: new MockAgentRuntime({ flash: FLASH }),
    defaultModel: "flash",
    select: async () => items,
    finalize: async (it, action) => void finalized.push([it.id, action]),
  });

  // Default action promotes with the compiled ladder's LAST status.
  assert.deepEqual(finalized, [["g1", { promote: true, status: "DONE" }]]);
});
