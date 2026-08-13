/**
 * Mock AgentRuntime tests (SPEC §11, §14): model resolution against the local
 * registry, scripted + deterministic prompt replies, per-session usage
 * accounting, call history, and session independence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelSpec } from "../src/types.js";
import {
  MockAgentRuntime,
  MockSession,
  respondTo,
} from "../src/agent/mock.js";

const SPEC: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 20,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

const FLASH: ModelSpec = {
  provider: "nube",
  model: "ds4-flash-fast",
  thinkingLevel: "off",
  maxTokens: 4096,
  rpm: 1000,
  cost: { inputPerM: 0.1, outputPerM: 0.3, cacheReadPerM: 0.05, cacheWritePerM: 0.3 },
};

test("resolveModel returns the registered spec, or null for unknown names", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  assert.deepEqual(await rt.resolveModel("spec"), SPEC);
  assert.equal(await rt.resolveModel("missing"), null);

  // register() adds (and can overwrite) after construction.
  rt.register("flash", FLASH);
  assert.deepEqual(await rt.resolveModel("flash"), FLASH);
  rt.register("spec", FLASH);
  assert.deepEqual(await rt.resolveModel("spec"), FLASH);

  // Iterable (Map) constructor input works too.
  const fromMap = new MockAgentRuntime(new Map([["m", SPEC]]));
  assert.deepEqual(await fromMap.resolveModel("m"), SPEC);
  assert.equal(await fromMap.resolveModel("nope"), null);
});

test("prompt returns scripted responses FIFO, then falls back to prompt-derived text", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  const session = (await rt.createSession({
    model: "spec",
    prompt: "system: be terse",
  })) as MockSession;
  session.responses.push("scripted one", "scripted two");

  assert.equal((await session.prompt("turn 1")).finalText, "scripted one");
  assert.equal((await session.prompt("turn 2")).finalText, "scripted two");
  // Queue drained → deterministic prompt-derived reply.
  assert.equal((await session.prompt("RESPOND: hello")).finalText, "hello");
});

test("prompt derives replies deterministically: RESPOND: marker, else canned echo", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  const session = (await rt.createSession({
    model: "spec",
    prompt: "system",
  })) as MockSession;

  // Marker extraction ignores surrounding context and trims trailing space.
  assert.equal(
    (await session.prompt("Context here.\nRESPOND:   hello world  \ntail")).finalText,
    "hello world",
  );
  assert.equal((await session.prompt("RESPOND:")).finalText, "");
  // No marker → canned echo of the first line.
  assert.equal((await session.prompt("first line\nsecond line")).finalText, "echo: first line");
  assert.equal((await session.prompt("   ")).finalText, "echo:");
});

test("usage counters accumulate per prompt call (input/output = chars)", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  const session = (await rt.createSession({
    model: "spec",
    prompt: "system",
  })) as MockSession;
  assert.deepEqual(session.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  // "RESPOND: hello" (14 chars) → "hello" (5 chars).
  const r1 = await session.prompt("RESPOND: hello");
  assert.deepEqual(session.usage, { input: 14, output: 5, cacheRead: 14, cacheWrite: 5 });
  assert.equal(r1.finalText, "hello");
  // Result carries a snapshot, not a live alias of the session counter.
  assert.deepEqual(r1.usage, session.usage);

  const r2 = await session.prompt("RESPOND: world"); // 14 → 5 again
  assert.deepEqual(session.usage, { input: 28, output: 10, cacheRead: 28, cacheWrite: 10 });
  assert.deepEqual(r2.usage, session.usage);

  // Scripted responses count the scripted text, not a derived reply.
  session.responses.push("scripted long reply");
  const r3 = await session.prompt("whatever");
  assert.equal(r3.finalText, "scripted long reply");
  assert.deepEqual(session.usage, {
    input: 28 + "whatever".length,
    output: 10 + "scripted long reply".length,
    cacheRead: 28 + "whatever".length,
    cacheWrite: 10 + "scripted long reply".length,
  });
});

test("runtime records call history (model, prompt, tools)", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  await rt.createSession({ model: "spec", prompt: "first" });
  await rt.createSession({ model: "spec", prompt: "second", tools: ["bash", "read"] });

  assert.deepEqual(rt.calls, [
    { model: "spec", prompt: "first" },
    { model: "spec", prompt: "second", tools: ["bash", "read"] },
  ]);
});

test("createSession rejects for unknown models, recording the failed call", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  await assert.rejects(
    rt.createSession({ model: "ghost", prompt: "hi" }),
    /unknown model "ghost"/,
  );
  assert.deepEqual(rt.calls, [{ model: "ghost", prompt: "hi" }]);
});

test("sessions are independent (usage, promptHistory, responses)", async () => {
  const rt = new MockAgentRuntime({ spec: SPEC });
  const a = (await rt.createSession({ model: "spec", prompt: "sys" })) as MockSession;
  const b = (await rt.createSession({ model: "spec", prompt: "sys" })) as MockSession;

  a.responses.push("for a only");
  assert.equal((await a.prompt("RESPOND: hi")).finalText, "for a only");
  assert.equal((await b.prompt("RESPOND: hi")).finalText, "hi"); // untouched queue

  assert.deepEqual(a.usage, { input: 11, output: 10, cacheRead: 11, cacheWrite: 10 }); // "for a only" is 10 chars
  assert.deepEqual(b.usage, { input: 11, output: 2, cacheRead: 11, cacheWrite: 2 });
  assert.deepEqual(a.promptHistory, ["RESPOND: hi"]);
  assert.deepEqual(b.promptHistory, ["RESPOND: hi"]);
  // Mutating one session never leaks into the other.
  assert.deepEqual(rt.calls, [
    { model: "spec", prompt: "sys" },
    { model: "spec", prompt: "sys" },
  ]);
});

test("respondTo is a pure deterministic function", () => {
  assert.equal(respondTo("x\nRESPOND: y"), "y");
  assert.equal(respondTo("RESPOND:  a  b  "), "a  b");
  assert.equal(respondTo("no marker"), "echo: no marker");
  assert.equal(respondTo(""), "echo:");
  assert.equal(respondTo("RESPOND: first\nRESPOND: second"), "first");
});
