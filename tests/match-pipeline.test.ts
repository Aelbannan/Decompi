/**
 * M3 builtin `match` pipeline tests (SPEC §10/§19): `registerMatchPipelines`
 * on a `PipelineEngine` with `MockAgentRuntime` + a fake `diff` verifier.
 * Covers: a batch of 5 items drives one agent session whose DRAFT is verified
 * by the body's diff check; rejected items route to the right fragment by
 * size (small → rebatch, large → singleton); the singleton fragment retries
 * one item per session; the sizeBelow threshold is strict; and batching
 * chunking (6 items → 5 + 1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelSpec, Verifier, WorkItem } from "../src/types.js";
import { MockAgentRuntime } from "../src/agent/mock.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import {
  registerMatchPipelines,
  MATCH_PIPELINE_ID,
  MATCH_REBATCH_SIZE_BELOW,
  MATCH_REBATCH_MODEL,
  MATCH_SINGLETON_MODEL,
} from "../src/pipeline/builtin/match.js";

const LOW: ModelSpec = {
  provider: "nube",
  model: "ds4-flash-low",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 20,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

const HIGH: ModelSpec = {
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

/** Fake diff verifier: accepts only items flagged `meta.accept === true`. */
const diff: Verifier = {
  id: "diff",
  verify: async (it) => ({
    accepted: it.meta.accept === true,
    evidence: { source: "fake" },
  }),
};

function newEngine(): PipelineEngine {
  const engine = new PipelineEngine();
  registerMatchPipelines(engine);
  return engine;
}

function newRuntime(): MockAgentRuntime {
  return new MockAgentRuntime({
    [MATCH_REBATCH_MODEL]: LOW,
    [MATCH_SINGLETON_MODEL]: HIGH,
  });
}

/** Run the builtin match pipeline over `items` (fake diff rejects by default). */
function runMatch(rt: MockAgentRuntime, engine: PipelineEngine, items: WorkItem[]) {
  return engine.runPipeline(MATCH_PIPELINE_ID, {
    runtime: rt,
    defaultModel: MATCH_REBATCH_MODEL,
    verifiers: [diff],
    select: async () => items,
  });
}

test("match pipeline: a batch of 5 items drives one agent session", async () => {
  const rt = newRuntime();
  const engine = newEngine();
  const items = [0, 1, 2, 3, 4].map((i) =>
    item(`f${i}`, { size: i % 2 === 0 ? 10 : 1000 }),
  );

  const out = await runMatch(rt, engine, items);

  // Batch agent session (the foreach body, [agent, verify]): exactly one
  // call carries all 5. The body's diff check rejects every draft.
  const batchCall = rt.calls.filter((c) =>
    items.every((it) => c.prompt.includes(`- ${it.id}`)),
  );
  assert.equal(batchCall.length, 1);
  assert.equal(batchCall[0]!.model, MATCH_REBATCH_MODEL);
  // Routing adds fragment sessions: 3 small -> one rebatch, 2 big -> one
  // singleton session EACH (the singleton fragment is batch:1).
  assert.equal(rt.calls.length, 4);
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(
    out.rejected.map((i) => i.id).sort(),
    ["f0", "f1", "f2", "f3", "f4"],
  );
});

test("match pipeline: a rejected item routes to the right fragment by size", async () => {
  const rt = newRuntime();
  const engine = newEngine();
  const small = item("small-fn", { size: 10 });
  const big = item("big-fn", { size: 1000 });

  const out = await runMatch(rt, engine, [small, big]);

  // call[0] = batch agent (default model, both items); then routing:
  // small -> rebatch (cheap model), big -> singleton (hard model).
  assert.equal(rt.calls.length, 3);
  const rebatch = rt.calls[1]!;
  const singleton = rt.calls[2]!;
  assert.equal(rebatch.model, MATCH_REBATCH_MODEL);
  assert.match(rebatch.prompt, /- small-fn\b/);
  assert.doesNotMatch(rebatch.prompt, /- big-fn\b/);
  assert.equal(singleton.model, MATCH_SINGLETON_MODEL);
  assert.match(singleton.prompt, /- big-fn\b/);
  assert.doesNotMatch(singleton.prompt, /- small-fn\b/);
  // Fragments end with the diff verifier: the fake still rejects both.
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(
    out.rejected.map((i) => i.id).sort(),
    ["big-fn", "small-fn"],
  );
});

test("match pipeline: sizeBelow is strict — an item at the threshold routes to singleton", async () => {
  const rt = newRuntime();
  const engine = newEngine();
  const atThreshold = item("at-edge", { size: MATCH_REBATCH_SIZE_BELOW });

  await runMatch(rt, engine, [atThreshold]);

  const routing = rt.calls.filter((c) => c.model === MATCH_SINGLETON_MODEL);
  assert.equal(routing.length, 1);
  assert.match(routing[0]!.prompt, /- at-edge\b/);
});

test("match pipeline: the body agent draft is verified (body is [agent, verify])", async () => {
  const rt = newRuntime();
  const engine = newEngine();
  const good = [
    item("ok-1", { size: 10, meta: { accept: true } }),
    item("ok-2", { size: 1000, meta: { accept: true } }),
  ];

  const out = await runMatch(rt, engine, good);

  // The agent runs FIRST (one batch session for both), then the diff
  // verifier finalizes the drafts — no fragment routing at all.
  assert.equal(rt.calls.length, 1);
  assert.match(rt.calls[0]!.prompt, /- ok-1\b/);
  assert.match(rt.calls[0]!.prompt, /- ok-2\b/);
  assert.deepEqual(
    out.accepted.map((i) => i.id).sort(),
    ["ok-1", "ok-2"],
  );
  assert.deepEqual(out.rejected, []);
});

test("match pipeline: large items retry one-per-session (singleton is truly singleton)", async () => {
  const rt = newRuntime();
  const engine = newEngine();
  const items = [item("big-1", { size: 500 }), item("big-2", { size: 600 }), item("big-3", { size: 700 })];

  const out = await runMatch(rt, engine, items);

  // Body: one batch session for all three (then diff rejects).
  // Singleton fragment: one session PER item, each carrying exactly one item.
  const singleton = rt.calls.filter((c) => c.model === MATCH_SINGLETON_MODEL);
  assert.equal(singleton.length, 3);
  for (const call of singleton) {
    const idsInPrompt = (call.prompt.match(/- big-\d\b/g) ?? []).length;
    assert.equal(idsInPrompt, 1, `singleton session must carry one item: ${call.prompt}`);
  }
  const seen = new Set(singleton.flatMap((c) => c.prompt.match(/- big-\d\b/g) ?? []));
  assert.deepEqual([...seen].sort(), ["- big-1", "- big-2", "- big-3"]);
  assert.deepEqual(
    out.rejected.map((i) => i.id).sort(),
    ["big-1", "big-2", "big-3"],
  );
});

test("match pipeline: 6 items chunk into 5 + 1 batch sessions", async () => {
  const rt = newRuntime();
  const engine = newEngine();
  const items = [0, 1, 2, 3, 4, 5].map((i) => item(`g${i}`, { size: 10 }));

  const out = await runMatch(rt, engine, items);

  // Two body batches ([5, 1]) on the default model ([agent, verify] each),
  // plus one rebatch fragment run carrying all 6 (fragment buckets
  // accumulate across batches). The fragment session is the one call that
  // lists every item; the two body sessions are the rest.
  assert.equal(rt.calls.length, 3);
  const allIds = items.map((i) => i.id);
  const fragment = rt.calls.filter((c) => allIds.every((id) => c.prompt.includes(`- ${id}`)));
  assert.equal(fragment.length, 1);
  const body = rt.calls.filter((c) => c !== fragment[0]);
  assert.equal(body.length, 2);
  const prompts = body.map((c) => c.prompt).join("\n");
  for (const it of items) assert.match(prompts, new RegExp(`- ${it.id}\\b`));
  assert.deepEqual(
    out.rejected.map((i) => i.id).sort(),
    items.map((i) => i.id).sort(),
  );
});
