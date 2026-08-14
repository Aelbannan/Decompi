/**
 * M1a tests for `smell.define_rename_alias` (SPEC §B): a retail placeholder
 * (function/label/data family) renamed via a `#define` alias instead of in
 * the source/symbols. One finding per `preproc_def`, annotated
 * ` (alias block)` when a matching `#undef` for the same name exists
 * anywhere in the file. Non-goals: plain `#define`s (no placeholder name)
 * and placeholder→placeholder aliases (incl. cross-family).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCpp } from "../src/parse/cpp/tree.js";
import { makeDefineRenameAliasRule } from "../src/parse/cpp/rules/smell.js";
import { lintFile } from "../src/parse/cpp/registry.js";
import type { Finding } from "../src/parse/cpp/types.js";

/** Xenoblade-style placeholder families (SPEC §B factory signature). */
const PATTERNS = {
  function: /^func_[0-9A-Fa-f]{7,8}$/,
  label: /^lbl_[0-9A-Fa-f]{7,8}$/,
  data: /^data_[0-9A-Fa-f]{7,8}$/,
};

/** Run the factory rule directly over `source`. */
function runAlias(
  source: string,
  patterns: { function?: RegExp; label?: RegExp; data?: RegExp } = PATTERNS,
): Finding[] {
  const { root } = parseCpp(source);
  return makeDefineRenameAliasRule(patterns).run(root, source);
}

test("smell.define_rename_alias: one finding per #define, alias block annotated", () => {
  const src = `#define func_802A3680 battleManagerSuddenCommuVoiceUnused
#define func_802A3B84 battleManagerSuddenCommuVoiceHeard
#undef func_802A3680
#undef func_802A3B84
`;
  const hits = runAlias(src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.rule, "smell.define_rename_alias");
  assert.equal(hits[0]!.line, 1);
  assert.equal(hits[0]!.column, 1);
  assert.match(hits[0]!.snippet ?? "", /^#define func_802A3680/);
  assert.equal(
    hits[0]!.message,
    "retail symbol 'func_802A3680' renamed via #define alias — rename it in the source/symbols instead (alias block)",
  );
  assert.match(hits[1]!.message, /'func_802A3B84'/);
  assert.match(hits[1]!.message, /\(alias block\)/);
});

test("smell.define_rename_alias: no alias-block annotation without a matching #undef", () => {
  const hits = runAlias("#define func_802A3680 battleManagerSuddenCommuVoiceUnused\n");
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.message, /'func_802A3680'/);
  assert.doesNotMatch(hits[0]!.message, /alias block/);
  // A #undef for a DIFFERENT name does not annotate either.
  const other = runAlias(
    "#define func_802A3680 battleManagerSuddenCommuVoiceUnused\n#undef func_802A3681\n",
  );
  assert.equal(other.length, 1);
  assert.doesNotMatch(other[0]!.message, /alias block/);
});

test("smell.define_rename_alias: label/data families fire", () => {
  const src = `#define lbl_802A3680 lblRealName
#define data_802A3680 dataRealName
`;
  const hits = runAlias(src);
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.message, /'lbl_802A3680'/);
  assert.match(hits[1]!.message, /'data_802A3680'/);
});

test("smell.define_rename_alias: plain #define with a non-placeholder name → no finding", () => {
  const src = `#define FOO bar
#define FOO2
#define VALUE 42
#define ADDR ((u32*)0x80000000)
#define FN(x) realName
`;
  assert.deepEqual(runAlias(src), []);
});

test("smell.define_rename_alias: placeholder→placeholder aliases are a non-goal", () => {
  const src = `#define func_AAAA func_BBBB
#define func_0001 lbl_0001
#define lbl_0002 data_0002
#define data_0003 func_0003
`;
  assert.deepEqual(runAlias(src), []);
});

test("smell.define_rename_alias: non-identifier replacements (cast/number/empty) → no finding", () => {
  const src = `#define func_802A3680 ((u32*)0x80000000)
#define func_802A3681 42
#define func_802A3682 0x1234
#define func_802A3683
#define func_802A3684 (void)
#define func_802A3685 /* nothing */
`;
  assert.deepEqual(runAlias(src), []);
});

test("smell.define_rename_alias: trailing comments on the replacement still count", () => {
  const src = `#define func_802A3680 battleManagerSuddenCommuVoiceUnused // renamed
#define func_802A3681 otherRealName /* block */
`;
  const hits = runAlias(src);
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.message, /'func_802A3680'/);
  assert.match(hits[1]!.message, /'func_802A3681'/);
});

test("smell.define_rename_alias: no active patterns → no findings", () => {
  assert.deepEqual(runAlias("#define func_802A3680 realName\n", {}), []);
  assert.deepEqual(runAlias("#define func_802A3680 realName\n", { label: new RegExp("") }), []);
});

test("lintFile wires cfg.placeholderPatterns into the whole-file run", () => {
  const src = `#define func_802A3680 battleManagerSuddenCommuVoiceUnused
#undef func_802A3680
`;
  const withPatterns = lintFile("file.cpp", src, {
    placeholderPatterns: { function: /^func_[0-9A-Fa-f]{7,8}$/ },
  });
  const alias = withPatterns.filter((f) => f.rule === "smell.define_rename_alias");
  assert.equal(alias.length, 1);
  assert.match(alias[0]!.message, /alias block/);
  // Without placeholder patterns the rule is not wired in at all.
  const without = lintFile("file.cpp", src);
  assert.equal(
    without.filter((f) => f.rule === "smell.define_rename_alias").length,
    0,
  );
});

test("lintFile: empty-string placeholder patterns (adapter label/data) do not match every name", () => {
  const src = `#define func_802A3680 battleManagerSuddenCommuVoiceUnused
#define FOO bar
`;
  const hits = lintFile("file.cpp", src, {
    placeholderPatterns: {
      function: /^func_[0-9A-Fa-f]{7,8}$/,
      // `compileConfig` turns a `label: ""` JSON string into new RegExp("").
      label: new RegExp(""),
      data: new RegExp(""),
    },
  });
  const alias = hits.filter((f) => f.rule === "smell.define_rename_alias");
  assert.equal(alias.length, 1);
  assert.match(alias[0]!.message, /'func_802A3680'/);
});
