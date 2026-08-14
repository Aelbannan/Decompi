/**
 * Agent tool tests (SPEC §B): the typed `Tool` surface and the MockSession
 * scripted-tool-call hook (SPEC §B.5) — a scripted `tool` entry invokes the
 * registered handler and the following `reply` entry becomes the turn's
 * final text, with every executed call recorded in the session's `toolCalls`
 * log. Covers the mock contract only; engine-side `finish` draining lives in
 * `tests/pipeline-finish.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { ModelSpec } from "../src/types.js";
import type { Tool } from "../src/workflow/types.js";
import { MockAgentRuntime, MockSession } from "../src/agent/mock.js";

const SPEC: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 20,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

/** A spy hexdiff tool: records every invocation and returns a canned diff. */
function hexdiffTool(seen: Array<{ unit: string; symbol: string }>): Tool {
  return {
    name: "hexdiff",
    description: "diff one function against retail",
    inputSchema: z.object({ unit: z.string(), symbol: z.string() }),
    run: async (_ctx, args: { unit: string; symbol: string }) => {
      seen.push(args);
      return { mismatch_count: 3, unit: args.unit, symbol: args.symbol };
    },
  };
}

// ---------------------------------------------------------------------------
// (a) scripted tool call -> handler + reply text
// ---------------------------------------------------------------------------

test("MockSession script: a tool entry invokes the registered handler; the reply becomes finalText", async () => {
  const seen: Array<{ unit: string; symbol: string }> = [];
  const session = new MockSession([], [hexdiffTool(seen)]);
  session.setScript([
    { type: "tool", name: "hexdiff", args: { unit: "kyoshin/CGame", symbol: "func_80000000" } },
    { type: "reply", text: "diff is clean" },
  ]);

  const res = await session.prompt("work on these");

  // The handler ran with the scripted args (a real side effect, not a stub).
  assert.deepEqual(seen, [{ unit: "kyoshin/CGame", symbol: "func_80000000" }]);
  // The reply text is the turn's final text.
  assert.equal(res.finalText, "diff is clean");
  // The executed call is recorded in the session's tool log.
  assert.deepEqual(session.toolCalls, [
    { type: "tool", name: "hexdiff", args: { unit: "kyoshin/CGame", symbol: "func_80000000" } },
  ]);
});

test("MockSession script: multiple tool entries before a reply dispatch in order", async () => {
  const seen: string[] = [];
  const tool: Tool = {
    name: "poke",
    description: "record a value",
    inputSchema: z.object({ value: z.string() }),
    run: async (_ctx, args: { value: string }) => {
      seen.push(args.value);
      return "ok";
    },
  };
  const session = new MockSession([], [tool]);
  session.setScript([
    { type: "tool", name: "poke", args: { value: "one" } },
    { type: "tool", name: "poke", args: { value: "two" } },
    { type: "reply", text: "both recorded" },
  ]);

  assert.equal((await session.prompt("go")).finalText, "both recorded");
  assert.deepEqual(seen, ["one", "two"]);
  assert.equal(session.toolCalls.length, 2);
});

test("MockSession script: an unregistered tool name throws", async () => {
  const session = new MockSession();
  session.setScript([
    { type: "tool", name: "nope", args: {} },
    { type: "reply", text: "unreachable" },
  ]);
  await assert.rejects(session.prompt("go"), /no handler registered for tool "nope"/);
});

test("MockSession: no script keeps the canned-reply behavior unchanged", async () => {
  const session = new MockSession(["scripted one"]);
  assert.equal((await session.prompt("turn 1")).finalText, "scripted one");
  assert.equal((await session.prompt("RESPOND: hello")).finalText, "hello");
  assert.equal((await session.prompt("first line")).finalText, "echo: first line");
  assert.deepEqual(session.toolCalls, []);
});

// ---------------------------------------------------------------------------
// createSession wiring (tools allowlist + customTools definitions)
// ---------------------------------------------------------------------------

test("MockAgentRuntime.createSession wires customTools into the session and records their names", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  const seen: Array<{ unit: string; symbol: string }> = [];
  const session = (await rt.createSession({
    model: "spec",
    prompt: "sys",
    tools: ["hexdiff"],
    customTools: [hexdiffTool(seen)],
  })) as MockSession;

  session.setScript([
    { type: "tool", name: "hexdiff", args: { unit: "u", symbol: "s" } },
    { type: "reply", text: "ok" },
  ]);
  const res = await session.prompt("go");

  assert.equal(res.finalText, "ok");
  assert.deepEqual(seen, [{ unit: "u", symbol: "s" }]);
  assert.equal(session.toolCalls.length, 1);
  // Call history records the allowlist AND the custom tool names.
  assert.deepEqual(rt.calls, [
    { model: "spec", prompt: "sys", tools: ["hexdiff"], customTools: ["hexdiff"] },
  ]);
});

test("MockAgentRuntime.createSession without customTools records no customTools key", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  await rt.createSession({ model: "spec", prompt: "plain" });
  assert.deepEqual(rt.calls, [{ model: "spec", prompt: "plain" }]);
});
