/**
 * M1a tests for the C++ parser foundation: `src/parse/cpp/tree.ts` +
 * `src/parse/cpp/types.ts`. Parses a snippet with a class, an `extern "C"`
 * block, and pointer arithmetic, then asserts tree shape and helper output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  descendants,
  nodeLoc,
  nodeText,
  parseCpp,
  walk,
} from "../src/parse/cpp/tree.js";
import type { DeltaRule, Finding, SourceRule } from "../src/parse/cpp/types.js";

/** Class + extern "C" + pointer arithmetic, no deliberate syntax errors. */
const SNIPPET = `class Robot {
public:
  int x;
};

extern "C" {
  int sum(int* arr, int n) {
    int total = 0;
    for (int i = 0; i < n; ++i) {
      total += *(arr + i);
    }
    return total;
  }
}
`;

test("parseCpp returns a clean translation_unit root", () => {
  const { tree, root } = parseCpp(SNIPPET);
  assert.equal(root.type, "translation_unit");
  assert.equal(root.hasError, false);
  assert.equal(tree.rootNode, root);
});

test("descendants finds expected named node counts", () => {
  const { root } = parseCpp(SNIPPET);
  assert.equal(descendants(root, "class_specifier").length, 1);
  assert.equal(descendants(root, "linkage_specification").length, 1);
  assert.equal(descendants(root, "pointer_declarator").length, 1);
  // Unknown / unnamed node types find nothing.
  assert.equal(descendants(root, "no_such_type").length, 0);
});

test("walk visits the root first in pre-order", () => {
  const { root } = parseCpp(SNIPPET);
  const seen: string[] = [];
  walk(root, (n) => seen.push(n.type));
  assert.equal(seen[0], "translation_unit");
  assert.ok(seen.includes("class_specifier"));
  assert.ok(seen.includes("linkage_specification"));
});

test("nodeText / nodeLoc report exact span and 1-indexed position", () => {
  const { root } = parseCpp(SNIPPET);
  const classNode = descendants(root, "class_specifier")[0]!;
  assert.equal(nodeText(classNode, SNIPPET), "class Robot {\npublic:\n  int x;\n}");
  // `class` starts at line 1, column 1 (1-indexed).
  assert.deepEqual(nodeLoc(classNode), { line: 1, column: 1 });
  const linkage = descendants(root, "linkage_specification")[0]!;
  assert.deepEqual(nodeLoc(linkage), { line: 6, column: 1 });
});

test("types.ts rule interfaces are usable (shape contract)", () => {
  const rule: SourceRule = {
    id: "test/example",
    description: "example rule",
    run: (root, source) => {
      const out: Finding[] = [];
      for (const n of descendants(root, "class_specifier")) {
        out.push({ rule: "test/example", line: nodeLoc(n).line, message: "found class" });
      }
      return out;
    },
  };
  const { root } = parseCpp(SNIPPET);
  assert.deepEqual(rule.run(root, SNIPPET), [{ rule: "test/example", line: 1, message: "found class" }]);

  const delta: DeltaRule = {
    id: "test/delta",
    description: "example delta rule",
    check: (line, ctx) => {
      ctx.state["last"] = line.text;
      return line.text.includes("total") ? { rule: "test/delta", line: line.line, message: "has total" } : undefined;
    },
  };
  const hit = delta.check({ line: 7, text: "  int total = 0;" }, { sourcePath: "a.cpp", state: {} });
  assert.equal(hit?.rule, "test/delta");
});
