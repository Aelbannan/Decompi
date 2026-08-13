/**
 * M1a tests for the clone/duplicate source rules (`src/parse/cpp/rules/clone.ts`):
 * `clone.repeated_code` (identical function bodies) and `clone.duplicate_class`
 * (identical class/struct definitions), via CST subtree-hash similarity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCpp } from "../src/parse/cpp/tree.js";
import { cloneRules } from "../src/parse/cpp/rules/clone.js";
import type { Finding } from "../src/parse/cpp/types.js";

/** Run a single rule by id over `source`. */
function runRule(id: string, source: string): Finding[] {
  const { root } = parseCpp(source);
  const rule = cloneRules.find((r) => r.id === id);
  assert.ok(rule, `no rule with id ${id}`);
  return rule.run(root, source);
}

const RULE_IDS = ["clone.repeated_code", "clone.duplicate_class"];

test("cloneRules exports the two SPEC §13.1 ids in order", () => {
  assert.deepEqual(
    cloneRules.map((r) => r.id),
    RULE_IDS,
  );
  for (const r of cloneRules) {
    assert.ok(r.description.length > 0);
    assert.equal(typeof r.run, "function");
  }
});

test("clone.repeated_code: identical function bodies fire on the copies", () => {
  const src = `int getA(void) {
  return mA;
}
int getB(void) {
  return mB;
}
int getC(void) {
  return mA;
}
`;
  const hits = runRule("clone.repeated_code", src);
  // getA (line 1) and getC (line 7) share an identical normalized body;
  // getB (line 4) differs (mB).
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, 7);
  assert.match(hits[0]!.message, /line 1/);
  assert.match(hits[0]!.message, /2 copies/);
});

test("clone.repeated_code: formatting/comments do not defeat the hash", () => {
  const src = `int f(void) {
  int total = 0;
  for (int i = 0; i < 4; ++i) { total += i; }  // loop
  return total;
}
int g(void) {
  int total = 0;
  for (int i = 0; i < 4; ++i) { total += i; }
  return total;
}
`;
  const hits = runRule("clone.repeated_code", src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.line, 6); // g's body starts on line 6
  // A real difference anywhere in the body breaks the clone.
  const near = `int f(void) { return a; }\nint g(void) { return b; }\n`;
  assert.deepEqual(runRule("clone.repeated_code", near), []);
});

test("clone.repeated_code: trivial bodies and single occurrences stay silent", () => {
  assert.deepEqual(runRule("clone.repeated_code", "int f(void) { return 0; }\n"), []);
  assert.deepEqual(runRule("clone.repeated_code", "int f(void) { return a; }\nint g(void) { return b; }\nint h(void) { return c; }\n"), []);
});

test("clone.duplicate_class: identical class/struct definitions fire", () => {
  const src = `class Point {
public:
  int x;
  int y;
};
class Coord {
public:
  int x;
  int y;
};
class Point2 {
public:
  int x;
  int y;
};
`;
  const hits = runRule("clone.duplicate_class", src);
  // Point (line 1), Coord (line 6), Point2 (line 11): all identical bodies.
  assert.equal(hits.length, 2); // Coord and Point2 both duplicate Point
  assert.equal(hits[0]!.line, 6);
  assert.match(hits[0]!.message, /'Coord'/);
  assert.match(hits[0]!.message, /line 1/);
  assert.equal(hits[1]!.line, 11);
  assert.match(hits[1]!.message, /'Point2'/);
  // Structs participate too, and distinct bodies do not.
  const mixed = `struct A { int x; int y; };\nstruct B { int x; int y; };\nstruct C { int x; };\n`;
  const shits = runRule("clone.duplicate_class", mixed);
  assert.equal(shits.length, 1);
  assert.match(shits[0]!.message, /'B'/);
});

test("clone.duplicate_class: forward declarations and single definitions stay silent", () => {
  assert.deepEqual(runRule("clone.duplicate_class", "class Foo;\nclass Bar;\n"), []);
  assert.deepEqual(runRule("clone.duplicate_class", "class Foo {\npublic:\n  int x;\n};\n"), []);
});
