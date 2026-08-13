/**
 * M1a tests for the matched-function smell rules (`src/parse/cpp/rules/match.ts`):
 * `match.func_placeholder`, `match.class_placeholder`, `match.void_ptr_params`
 * — fixture-backed (accepted work items only), CST port of
 * `tools/coop/detect_smells.py` (SPEC §13.1, §19).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCpp } from "../src/parse/cpp/tree.js";
import {
  ACCEPTED_STATUSES,
  matchContextFromFixture,
  matchRules,
  type MatchRuleContext,
} from "../src/parse/cpp/rules/match.js";
import type { Finding } from "../src/parse/cpp/types.js";

/** A fixture-backed context with two accepted items and two unaccepted. */
const FIXTURE: MatchRuleContext = matchContextFromFixture([
  { id: "wi_func", kind: "function", status: "FULL_MATCH", symbol: "func_8004B0B0", unitId: "kyoshin/CGame", meta: { function: "func_8004B0B0" } },
  { id: "wi_fn", kind: "function", status: "EQUIVALENT_MATCH", symbol: "fn_800A2B1C", unitId: "kyoshin/CGame", meta: { function: "fn_800A2B1C" } },
  { id: "wi_unk", kind: "function", status: "FULL_MATCH", symbol: "UnkClass_8045F564__Fv", unitId: "kyoshin/CGame", meta: { function: "UnkClass_8045F564" } },
  { id: "wi_void", kind: "function", status: "FULL_MATCH", symbol: "fn_80112233", unitId: "kyoshin/CGame", meta: { function: "fn_80112233" } },
  { id: "wi_pending", kind: "function", status: "NOT_STARTED", symbol: "func_80000000", unitId: "kyoshin/CGame", meta: { function: "func_80000000" } },
]);

/** Run a single rule by id with the fixture context. */
function runRule(id: string, source: string, ctx: MatchRuleContext = FIXTURE): Finding[] {
  const { root } = parseCpp(source);
  const rule = matchRules(ctx).find((r) => r.id === id);
  assert.ok(rule, `no rule with id ${id}`);
  return rule.run(root, source);
}

test("matchRules exports the three SPEC §13.1 ids in order", () => {
  assert.deepEqual(
    matchRules(FIXTURE).map((r) => r.id),
    ["match.func_placeholder", "match.class_placeholder", "match.void_ptr_params"],
  );
});

test("match.func_placeholder: func_/fn_ names fire only on accepted work items", () => {
  const src = `void func_8004B0B0(void) { }
void fn_800A2B1C(void) { }
void func_80000000(void) { }
void real_helper(void) { }
`;
  const hits = runRule("match.func_placeholder", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 1);
  assert.equal(hits[0]!.snippet, "func_8004B0B0");
  assert.match(hits[0]!.message, /wi_func/);
  assert.match(hits[0]!.message, /FULL_MATCH/);
  assert.equal(hits[1]!.line, 2);
  assert.match(hits[1]!.snippet!, /fn_800A2B1C/);
  // func_80000000 is a placeholder name but its work item is NOT accepted.
  assert.equal(hits.some((h) => h.snippet === "func_80000000"), false);
});

test("match.func_placeholder: one finding per unique name (dedupe by name)", () => {
  const src = `void func_8004B0B0(void) { }\nvoid caller(void) { func_8004B0B0(); }\n`;
  const hits = runRule("match.func_placeholder", src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, 1);
});

test("match.func_placeholder: patterns are configurable", () => {
  const ctx = matchContextFromFixture([
    { id: "wi_x", kind: "function", status: "FULL_MATCH", symbol: "fn_thing", meta: { function: "fn_thing" } },
  ]);
  const src = "void fn_thing(void) { }\n";
  // Default fn_ pattern (hex suffix) does not match a wordy suffix.
  assert.equal(runRule("match.func_placeholder", src, ctx).length, 0);
  const custom = matchRules({ ...ctx, fnPattern: /^fn_thing$/ });
  const { root } = parseCpp(src);
  const hits = custom.find((r) => r.id === "match.func_placeholder")!.run(root, src);
  assert.equal(hits.length, 1);
});

test("match.class_placeholder: UnkClass and Class_ names on accepted items", () => {
  const src = `void UnkClass_8045F564(void) { }
void Class_8045FABC(void) { }
void plain_fn(void) { }
`;
  // UnkClass_8045F564 is accepted; Class_8045FABC is untracked (no work item).
  const hits = runRule("match.class_placeholder", src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, 1);
  assert.match(hits[0]!.message, /UnkClass_8045F564/);
});

test("match.void_ptr_params: void* parameters on accepted matched functions", () => {
  const src = `void fn_80112233(void* self, int x) { }
void fn_80112233(void *other) { }
void real_helper(void* p) { }
`;
  const hits = runRule("match.void_ptr_params", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 1);
  assert.match(hits[0]!.message, /'fn_80112233'/);
  assert.match(hits[0]!.message, /wi_void/);
  assert.equal(hits[1]!.line, 2);
  // A void* param on an untracked function does not fire.
  assert.equal(hits.some((h) => h.line === 3), false);
});

test("match rules: no fixture context fires nothing (byName defaults empty)", () => {
  const src = `void func_8004B0B0(void) { }\n`;
  const { root } = parseCpp(src);
  for (const rule of matchRules({})) {
    assert.deepEqual(rule.run(root, src), []);
  }
});

test("matchContextFromFixture derives acceptedIds from ACCEPTED_STATUSES", () => {
  assert.deepEqual([...ACCEPTED_STATUSES].sort(), ["EQUIVALENT_MATCH", "FULL_MATCH"]);
  const ctx = matchContextFromFixture([
    { id: "a", kind: "function", status: "FULL_MATCH", symbol: "f1" },
    { id: "b", kind: "function", status: "NOT_STARTED", symbol: "f2" },
  ]);
  assert.deepEqual([...ctx.acceptedIds!], ["a"]);
  assert.ok(ctx.byName!.has("f1"));
  assert.ok(ctx.byName!.has("f2"));
  assert.equal(ctx.byName!.size, 2);
});
