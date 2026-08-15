/**
 * M1a tests for the rule registry (`src/parse/cpp/registry.ts`): `sourceRules`
 * aggregation, `lintFile` whole-file scans, `lintDelta` with configurable
 * placeholder patterns / angle whitelist, and `formatFindings` output
 * (SPEC §13.1, §13.2, §13.4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatFindings,
  lintDelta,
  lintFile,
  sourceRules,
  type LintConfig,
} from "../src/parse/cpp/registry.js";
import { smellRules } from "../src/parse/cpp/rules/smell.js";
import { pointerRules } from "../src/parse/cpp/rules/pointer.js";
import { cloneRules } from "../src/parse/cpp/rules/clone.js";
import { matchContextFromFixture, matchRules } from "../src/parse/cpp/rules/match.js";
import type { Finding } from "../src/parse/cpp/types.js";

test("sourceRules aggregates the smell + pointer + clone rule families in order", () => {
  assert.deepEqual(
    sourceRules.map((r) => r.id),
    [...smellRules.map((r) => r.id), ...pointerRules.map((r) => r.id), ...cloneRules.map((r) => r.id)],
  );
  assert.equal(sourceRules.length, smellRules.length + pointerRules.length + cloneRules.length);
  for (const rule of sourceRules) {
    assert.equal(typeof rule.run, "function");
    assert.ok(rule.description.length > 0);
  }
});

test("lintFile gates class_in_cpp/struct_in_cpp on .cpp TUs and runs match rules from cfg", () => {
  const src = `class Widget {
public:
  int x;
};
`;
  // .hpp/.h never fire the definition-in-TU smell, .cpp does.
  assert.equal(lintFile("include/Widget.hpp", src).filter((f) => f.rule === "smell.class_in_cpp").length, 0);
  assert.equal(lintFile("unit/cpp/Widget.cpp", src).filter((f) => f.rule === "smell.class_in_cpp").length, 1);
  assert.equal(lintFile("unit/cpp/Widget.cc", src).filter((f) => f.rule === "smell.class_in_cpp").length, 1);
  assert.equal(lintFile("unit/cpp/Widget.cxx", src).filter((f) => f.rule === "smell.class_in_cpp").length, 1);

  // match.* rules run only when cfg.match (the fixture-backed source) is set.
  const fnSrc = `void func_8004B0B0(void) { }
void helper(void) { }
`;
  const ctx = matchContextFromFixture([
    { id: "wi_1", kind: "function", status: "FULL_MATCH", symbol: "func_8004B0B0", unitId: "kyoshin/CGame" },
    { id: "wi_2", kind: "function", status: "NOT_STARTED", symbol: "helper", unitId: "kyoshin/CGame" },
  ]);
  assert.equal(lintFile("unit/cpp/Test.cpp", fnSrc).filter((f) => f.rule.startsWith("match.")).length, 0);
  const withMatch = lintFile("unit/cpp/Test.cpp", fnSrc, { match: ctx });
  assert.deepEqual(withMatch.filter((f) => f.rule.startsWith("match.")).map((f) => f.rule), [
    "match.func_placeholder",
  ]);
  assert.equal(withMatch.find((f) => f.rule === "match.func_placeholder")!.line, 1);
  // matchRules is the same factory lintFile uses.
  assert.equal(matchRules(ctx).length, 3);
});

test("lintDelta honors a configurable unknown placeholder pattern", () => {
  const oldText = "int a;\n";
  const newText = "int a;\nvoid f(void) {\n  int foo1 = 0;\n  int foo2 = 0;\n}\n";
  const cfg: LintConfig = { placeholderPatterns: { unknown: /\bfoo\d+\b/ } };
  const findings = lintDelta("unit/cpp/Test.cpp", oldText, newText, cfg);
  const unk = findings.filter((f) => f.rule === "no_unk_name");
  assert.equal(unk.length, 2);
  assert.deepEqual(
    unk.map((f) => f.line),
    [3, 4],
  );
  // The default pattern (unkN) does not match fooN.
  const defaults = lintDelta("unit/cpp/Test.cpp", oldText, newText);
  assert.equal(defaults.filter((f) => f.rule === "no_unk_name").length, 0);
});

test("lintDelta applies the class placeholder pattern and the angle whitelist", () => {
  const cfg: LintConfig = {
    placeholderPatterns: { class: /\bTmpCls\d+\b/ },
    angleIncludeWhitelist: ["my_header.h"],
  };
  const src =
    "#include <my_header.h>\n#include <stdlib.h>\nvoid f(void) { TmpCls3* p; }\n";
  const findings = lintDelta("unit/cpp/Test.cpp", null, src, cfg);
  // Custom class pattern feeds no_unk_generated (line 3).
  const generated = findings.filter((f) => f.rule === "no_unk_generated");
  assert.equal(generated.length, 1);
  assert.equal(generated[0]!.line, 3);
  // my_header.h is whitelisted; stdlib.h is not in the custom whitelist.
  const angles = findings.filter((f) => f.rule === "no_angle_include");
  assert.deepEqual(
    angles.map((f) => f.line),
    [2],
  );
});

test("formatFindings json is parseable and round-trips; text/markdown render", () => {
  const findings: Finding[] = [
    { rule: "smell.void_ptr", line: 4, column: 3, snippet: "void* p", message: "untyped pointer" },
    { rule: "smell.ptr_arith", line: 7, message: "manual field access" },
  ];
  const json = formatFindings(findings, "json");
  assert.deepEqual(JSON.parse(json), findings);

  // Text is grouped by rule: `rule: count` header, then `line:col  snippet`
  // (message when the finding has no snippet).
  const text = formatFindings(findings, "text");
  assert.match(text, /smell\.void_ptr: 1/);
  assert.match(text, /4:3\s+void\* p/);
  assert.match(text, /smell\.ptr_arith: 1/);
  assert.match(text, /7\s+manual field access/);
  assert.equal(formatFindings([], "text"), "");

  // Markdown is a report table with the six-column header.
  const md = formatFindings(findings, "markdown");
  assert.match(md, /\| rule \| line \| column \| snippet \| message \|/);
  assert.match(md, /\| smell\.void_ptr \| 4 \| 3 \| `void\* p` \| untyped pointer \|/);
  assert.match(md, /\| smell\.ptr_arith \| 7 \|  \|  \| manual field access \|/);
  assert.match(formatFindings([], "markdown"), /No findings/);
});
