/**
 * Workflow authoring API — compile-time typing test + runtime smoke
 * (SPEC §2–§3, §8).
 *
 * The compile-time half is the point of this file: it is the ONLY tests/**
 * file in tsconfig `include`, so `npm run typecheck` really checks it. Every
 * positive line must typecheck; every `@ts-expect-error` line must actually
 * error (an un-triggered directive fails typecheck too).
 *
 * It also exercises the SPEC §8 package `exports` self-reference: the
 * `declare module "decompi"` augmentations below only attach to the core
 * `WorkItemKindMap` / `WorkflowHelpers` interfaces if `"decompi"` resolves to
 * `src/index.ts` (via package.json `exports`). If that wiring breaks, the
 * positives fail (TS2664/TS2339) and typecheck goes red.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { Workflow, type WorkItemOf } from "../src/workflow/types.js";
import { HelperRegistry, makeBuiltinHelpers } from "../src/workflow/helpers.js";
import type { Selector, WorkItem } from "../src/types.js";
import type { SqlAdapter } from "../src/core/store/adapter.js";

/** Local adapter vocab — mirrors what adapters/xenoblade would declare. */
type FunctionWorkItem = WorkItem & { kind: "function"; asmText: string };

declare module "decompi" {
  interface WorkItemKindMap {
    function: FunctionWorkItem;
  }
  interface WorkflowHelpers {
    getAsm(t: FunctionWorkItem): Promise<string>;
  }
}

test("Workflow: kind narrowing, augmented + local helpers, typed verdict", async () => {
  const wf = new Workflow({
    id: "basic-match",
    accepts: "function",
    canBatch: true,
    defaultBatchSize: 5,
    rejectionRetries: 1,
    select: { filter: { status: ["NOT_STARTED"] }, sort: [{ by: "size", dir: "asc" }], limit: 100 },
    helpers: { d: (t: FunctionWorkItem) => "x" },
    startPrompt: async (targets, ctx) => {
      const t = targets[0]!;
      t.asmText; // narrowed: `targets` is WorkItemOf<"function"> = FunctionWorkItem
      await ctx.helpers.getAsm(t); // adapter-augmented helper (declare module "decompi")
      await ctx.helpers.d(t); // local helper, typed H
      void ctx.helpers.select; // built-ins present on the merged surface
      void ctx.helpers.render;
      void ctx.helpers.emit;
      void ctx.helpers.log;
      void ctx.helpers.store;
      return "";
    },
    reprompt: async (targets, _ctx, lastTurn) => {
      void lastTurn.text; // AgentTurn available as third hook param
      return { accepted: targets, rejected: [], feedback: `turn said: ${lastTurn.text}` };
    },
  });

  assert.equal(wf.id, "basic-match");
  assert.equal(wf.accepts, "function");
  // The compiler landed (SPEC §4): compile() emits the agentLoop pipeline.
  const compiled = wf.compile();
  assert.equal(compiled.id, "basic-match");
  assert.equal(compiled.adapter, "workflow");
  assert.equal(compiled.steps.length, 1);
  assert.equal(compiled.steps[0]!.kind, "foreach");
});

test("Workflow: negative typing cases (@ts-expect-error)", () => {
  // Wrong kind access: `object` is NOT declared in WorkItemKindMap, so
  // WorkItemOf<"object"> falls back to `WorkItem & { kind: "object" }` — no asmText.
  const obj = {} as unknown as WorkItemOf<"object">;
  // @ts-expect-error asmText exists only on the declared "function" kind
  void obj.asmText;

  new Workflow({
    id: "negative-case",
    accepts: "function",
    helpers: { d: (t: FunctionWorkItem) => "x" },
    startPrompt: async (_targets, ctx) => {
      // @ts-expect-error `nope` is neither a built-in helper nor in local H
      void ctx.helpers.nope;
      // @ts-expect-error local helper `d` requires FunctionWorkItem, not the fallback kind
      await ctx.helpers.d(null as unknown as WorkItemOf<"object">);
      return "";
    },
    reprompt: async () => ({ accepted: [], rejected: [] }),
  });
});

test("makeBuiltinHelpers: render, emit stub, log, read-only store", async (t) => {
  const storeStub = {
    query: async <T,>(_sql: string, _params?: unknown[]): Promise<T[]> => [{ id: "f1" } as T],
  } as unknown as SqlAdapter;
  const helpers = makeBuiltinHelpers(storeStub, async (_s: Selector): Promise<WorkItem[]> => []);

  assert.equal(
    helpers.render("hi ${name}, ${obj.a}!", { name: "world", obj: { a: 42 } }),
    "hi world, 42!",
  );
  assert.equal(helpers.render("missing ${nope}", {}), "missing ");

  // emit is a stub resolving 0 until the daemon path wires the real INSERT.
  assert.equal(await helpers.emit("target-accepted", { id: "f1" }), 0);

  const spy = t.mock.method(console, "log", () => {});
  helpers.log("info", "hello");
  assert.equal(spy.mock.callCount(), 1);

  const rows = await helpers.store.query<{ id: string }>("SELECT id FROM work_items");
  assert.deepEqual(rows, [{ id: "f1" }]);

  // @ts-expect-error ReadonlyStore exposes `query` only (no execute/transaction)
  void helpers.store.execute;
});

test("makeBuiltinHelpers: emit override", async () => {
  let emitted: [string, unknown] | undefined;
  const helpers = makeBuiltinHelpers(
    {} as unknown as SqlAdapter,
    async () => [],
    async (type, data) => {
      emitted = [type, data];
      return 1;
    },
  );
  assert.equal(await helpers.emit("e", { x: 1 }), 1);
  assert.deepEqual(emitted, ["e", { x: 1 }]);
});

test("HelperRegistry: register/get/has, last wins", () => {
  const reg = new HelperRegistry();
  assert.equal(reg.has("a"), false);
  reg.register("a", () => 1);
  assert.equal(reg.has("a"), true);
  assert.equal(typeof reg.get("a"), "function");
  reg.register("a", "overwrite");
  assert.equal(reg.get("a"), "overwrite"); // last registration wins
  assert.equal(reg.get("missing"), undefined);
});
