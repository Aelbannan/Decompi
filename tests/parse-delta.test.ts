/**
 * M1a delta-lint gate tests (SPEC §13.2) — `computeAddedLines` and
 * `lintDelta` covering the required rule surface: no_void_ptr, no_extern_c
 * (lbl_* allowed), no_asm, no_offset_arithmetic, no_unk_generated
 * (un-anchored substring), and the multi-line no_init_side_effect
 * (cast_pending) state machine — plus non_sjis_char, C-vs-C++ branching,
 * whitelist/configurable rules, and diff behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAddedLines,
  deltaRules,
  lintDelta,
  type AddedLine,
} from "../src/parse/cpp/delta.js";
import type { Finding } from "../src/parse/cpp/types.js";

/** Rule ids in emission order, for compact assertions. */
function ruleIds(findings: Finding[]): string[] {
  return findings.map((f) => f.rule);
}

/** Added lines as `"line: text"` strings, for compact assertions. */
function addedLines(lines: AddedLine[]): string[] {
  return lines.map((l) => `${l.line}: ${l.text}`);
}

test("computeAddedLines: oldText null → every new line added", () => {
  assert.deepEqual(addedLines(computeAddedLines(null, "a\nb\nc")), [
    "1: a",
    "2: b",
    "3: c",
  ]);
  assert.deepEqual(computeAddedLines(null, ""), []);
});

test("computeAddedLines: unchanged files produce no added lines", () => {
  assert.deepEqual(computeAddedLines("a\nb\nc\n", "a\nb\nc"), []);
  assert.deepEqual(computeAddedLines("a\nb", "a\nb"), []);
});

test("computeAddedLines: insert in the middle is a single added line", () => {
  const oldText = "int a;\nint b;\nint c;\n";
  const newText = "int a;\nint b;\nint X;\nint c;\n";
  assert.deepEqual(addedLines(computeAddedLines(oldText, newText)), [
    "3: int X;",
  ]);
});

test("computeAddedLines: replace reports the new line as added", () => {
  const oldText = "int a;\nint b;\nint c;\n";
  const newText = "int a;\nint B;\nint c;\n";
  assert.deepEqual(addedLines(computeAddedLines(oldText, newText)), [
    "2: int B;",
  ]);
});

test("computeAddedLines: append and delete-only", () => {
  assert.deepEqual(addedLines(computeAddedLines("a\nb\n", "a\nb\nc\n")), [
    "3: c",
  ]);
  // Delete-only: no added lines in the new file.
  assert.deepEqual(addedLines(computeAddedLines("a\nb\nc\n", "a\nc\n")), []);
});

test("computeAddedLines: CRLF and bare-CR line endings", () => {
  assert.deepEqual(addedLines(computeAddedLines("a\r\nb\r\n", "a\r\nX\r\nb\r\n")), [
    "2: X",
  ]);
  assert.deepEqual(addedLines(computeAddedLines("a\rb\rc\r", "a\rX\rc\r")), [
    "2: X",
  ]);
});

test("computeAddedLines: empty oldText (not null) adds everything", () => {
  assert.deepEqual(addedLines(computeAddedLines("", "a\nb")), ["1: a", "2: b"]);
});

test("computeAddedLines: common prefix/suffix is trimmed before the Myers diff", () => {
  // The OOM scenario the trim fixes: a huge file with a tiny changed middle.
  const common = Array.from({ length: 5000 }, (_, i) => `SAME_${i}`);
  const oldText = [...common.slice(0, 2500), "old1", "old2", ...common.slice(2500)].join("\n");
  const newText = [...common.slice(0, 2500), "new1", "new2", "new3", ...common.slice(2500)].join("\n");
  const added = addedLines(computeAddedLines(oldText, newText));
  assert.deepEqual(added, ["2501: new1", "2502: new2", "2503: new3"]);
  // Unchanged large files produce no added lines at all (suffix-only trim).
  assert.deepEqual(computeAddedLines(oldText, oldText), []);
});

test("computeAddedLines matches difflib.SequenceMatcher(autojunk=False) added-line sets", () => {
  // Expected added lines below were produced by Python 3.13's difflib
  // (SequenceMatcher with autojunk=False) over these exact patch pairs —
  // hardcoded so the Myers port cannot silently drift. The pairs are chosen
  // where difflib and the LCS-optimal Myers diff agree (the documented
  // divergence only shows on ambiguous repeat-heavy inputs).
  const pairs: Array<{ name: string; oldText: string; newText: string; expected: string[] }> = [
    {
      name: "mid_insert",
      oldText: "int a;\nint b;\nint c;\n",
      newText: "int a;\nint b;\nint X;\nint c;\n",
      expected: ["3: int X;"],
    },
    {
      name: "replace",
      oldText: "int a;\nint b;\nint c;\n",
      newText: "int a;\nint B;\nint c;\n",
      expected: ["2: int B;"],
    },
    {
      name: "large_rewrite",
      oldText: ["L0", "L1", ...Array.from({ length: 5 }, () => "SAME"), "old1", "old2", ...Array.from({ length: 5 }, () => "SAME"), "L9"].join("\n"),
      newText: ["L0", "L1", ...Array.from({ length: 5 }, () => "SAME"), "new1", "new2", "new3", ...Array.from({ length: 5 }, () => "SAME"), "L9"].join("\n"),
      expected: ["8: new1", "9: new2", "10: new3"],
    },
    {
      name: "dup_lines",
      oldText: "x\ny\nx\ny\nz\n",
      newText: "x\ny\nx\ny\ny\nz\n",
      expected: ["5: y"],
    },
    {
      name: "crlf",
      oldText: "a\r\nb\r\n",
      newText: "a\r\nX\r\nb\r\n",
      expected: ["2: X"],
    },
    {
      name: "append",
      oldText: "a\nb\n",
      newText: "a\nb\nc\n",
      expected: ["3: c"],
    },
  ];
  for (const { name, oldText, newText, expected } of pairs) {
    assert.deepEqual(addedLines(computeAddedLines(oldText, newText)), expected, name);
  }
});

test("no_void_ptr: void* usage is flagged on the added line", () => {
  const findings = lintDelta("unit/cpp/Test.cpp", null, "void* buf = 0;\n");
  assert.deepEqual(ruleIds(findings), ["no_void_ptr"]);
  assert.equal(findings[0]!.line, 1);
  assert.equal(findings[0]!.rule, "no_void_ptr");
  assert.ok(findings[0]!.snippet!.includes("void* buf"));
});

test("no_extern_c: allowed only for lbl_* reloc names", () => {
  const plain = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    'extern "C" void helper(void);\n',
  );
  assert.deepEqual(ruleIds(plain), ["no_extern_c"]);

  const lbl = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    'extern "C" void lbl_Reloc0(void);\n',
  );
  assert.deepEqual(lbl, []);
});

test("extern_c_in_c: `extern \"C\"` is illegal in .c files (and still no_extern_c)", () => {
  const findings = lintDelta(
    "unit/c/Test.c",
    null,
    'extern "C" int g_thing;\n',
  );
  assert.deepEqual(ruleIds(findings), ["extern_c_in_c", "no_extern_c"]);

  // .h behaves as C too.
  const header = lintDelta("include/Test.h", null, 'extern "C" int g_x;\n');
  assert.deepEqual(ruleIds(header), ["extern_c_in_c", "no_extern_c"]);

  // A C++ TU only trips no_extern_c.
  const cpp = lintDelta("unit/cpp/Test.cpp", null, 'extern "C" int g_x;\n');
  assert.deepEqual(ruleIds(cpp), ["no_extern_c"]);
});

test("no_asm: asm keyword, __asm, and .s includes are all flagged", () => {
  const keyword = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    "asm volatile(\"\twait\");\n",
  );
  assert.deepEqual(ruleIds(keyword), ["no_asm"]);

  const dunder = lintDelta("unit/cpp/Test.cpp", null, "__asm { nop }\n");
  assert.deepEqual(ruleIds(dunder), ["no_asm"]);

  const sInclude = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    '#include "code.s"\n',
  );
  assert.deepEqual(ruleIds(sInclude), ["no_asm"]);

  const angleS = lintDelta("unit/cpp/Test.cpp", null, "#include <boot.s>\n");
  assert.deepEqual(ruleIds(angleS), ["no_angle_include", "no_asm"]);
});

test("no_asm: assembly hidden in comments is not flagged", () => {
  const findings = lintDelta("unit/cpp/Test.cpp", null, "// asm volatile\n");
  assert.deepEqual(findings, []);
});

test("no_offset_arithmetic: cast + hex offset is flagged", () => {
  const findings = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    "u8 b = ((u8*)p + 0x20)[0];\n",
  );
  assert.deepEqual(ruleIds(findings), ["no_offset_arithmetic"]);

  // A plain cast or a plain hex literal alone is fine.
  assert.deepEqual(
    lintDelta("unit/cpp/Test.cpp", null, "u8 b = (u8)v;\n"),
    [],
  );
  assert.deepEqual(
    lintDelta("unit/cpp/Test.cpp", null, "u8 b = v + 0x20;\n"),
    [],
  );
});

test("no_unk_generated: un-anchored substring matches inside longer identifiers", () => {
  for (const line of [
    "CActorParam_UnkStruct2* p = 0;\n",
    "CCBattleManager_UnkVirtualFunc9 vf;\n",
    "UnkClass_8045F564* x = 0;\n",
  ]) {
    const findings = lintDelta("unit/cpp/Test.cpp", null, line);
    assert.deepEqual(ruleIds(findings), ["no_unk_generated"], `for ${line}`);
  }

  // Real type names are untouched.
  assert.deepEqual(
    lintDelta("unit/cpp/Test.cpp", null, "CActorParam* p = 0;\n"),
    [],
  );
});

test("no_unk_name: offset-style unk0/unk4/unkC placeholders are flagged", () => {
  for (const line of ["u32 unk4 = 0;\n", "this->unk10 = 1;\n", "unkC();\n"]) {
    const findings = lintDelta("unit/cpp/Test.cpp", null, line);
    assert.deepEqual(ruleIds(findings), ["no_unk_name"], `for ${line}`);
  }
  assert.deepEqual(lintDelta("unit/cpp/Test.cpp", null, "u32 unk = 0;\n"), []);
});

test("no_unk_name / no_unk_generated: patterns are configurable", () => {
  const findings = lintDelta("unit/cpp/Test.cpp", null, "u32 placeholder1 = 0;\n", {
    unkNamePattern: /placeholder\d+/,
  });
  assert.deepEqual(ruleIds(findings), ["no_unk_name"]);

  const gen = lintDelta("unit/cpp/Test.cpp", null, "u32 tmpThing2 = 0;\n", {
    unkGeneratedPattern: /tmpThing\d+/,
  });
  assert.deepEqual(ruleIds(gen), ["no_unk_generated"]);
});

test("no_init_side_effect: multi-line cast with assignment (cast_pending)", () => {
  const oldText = "int a;\n";
  const newText = [
    "int a;",
    "SeqSoundHandle h = reinterpret_cast<SeqSoundHandle*>(",
    "    mPreparedFlag = mLoadingFlag = false));",
    "",
  ].join("\n");
  const findings = lintDelta("unit/cpp/Test.cpp", oldText, newText);
  // lint.py flags BOTH added lines: line 2 opens the cast and already
  // carries an assignment (`h = …`), line 3 the member-store assignment
  // inside the still-pending cast. `)` on line 3 closes the state.
  assert.deepEqual(ruleIds(findings), [
    "no_init_side_effect",
    "no_init_side_effect",
  ]);
  assert.deepEqual(findings.map((f) => f.line), [2, 3]);
});

test("no_init_side_effect: pending cast without assignment is fine", () => {
  const findings = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    "foo(reinterpret_cast<Bar*>(\n    0x10);\n",
  );
  assert.deepEqual(findings, []);
});

test("no_init_side_effect: one-line cast assignment is flagged directly", () => {
  const findings = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    "x = reinterpret_cast<int>(mFlag = 0);\n",
  );
  assert.deepEqual(ruleIds(findings), ["no_init_side_effect"]);
});

test("no_register_keyword and no_register_names", () => {
  const kw = lintDelta("unit/cpp/Test.cpp", null, "register int x;\n");
  assert.deepEqual(ruleIds(kw), ["no_register_keyword"]);

  const name = lintDelta("unit/cpp/Test.cpp", null, "u32 r3 = value;\n");
  assert.deepEqual(ruleIds(name), ["no_register_names"]);

  // r3 as a bare use (no declaration-like prefix) is not flagged.
  assert.deepEqual(lintDelta("unit/cpp/Test.cpp", null, "foo(r3);\n"), []);
});

test("cpp_free_ctor: __ct__/__dt__ as C-style free functions are flagged", () => {
  const bad = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    "void __ct__MyClass(MyClass* self) {}\n",
  );
  assert.deepEqual(ruleIds(bad), ["cpp_free_ctor"]);

  // Member-style ctor and free functions without a `* self` param are fine.
  assert.deepEqual(
    lintDelta("unit/cpp/Test.cpp", null, "void MyClass::MyClass() {}\n"),
    [],
  );
  assert.deepEqual(
    lintDelta("unit/cpp/Test.cpp", null, "void __ct__MyClass(int x) {}\n"),
    [],
  );
  // Not applicable to C files.
  assert.deepEqual(
    lintDelta("unit/c/Test.c", null, "void __ct__MyClass(MyClass* self) {}\n"),
    [],
  );
});

test("no_angle_include: whitelist enforced, quoted includes unaffected", () => {
  const evil = lintDelta("unit/cpp/Test.cpp", null, "#include <evil.h>\n");
  assert.deepEqual(ruleIds(evil), ["no_angle_include"]);

  for (const ok of [
    "#include <string.h>\n",
    "#include <new>\n",
    "#include <stdio.h>\n",
    '#include "local.h"\n',
  ]) {
    assert.deepEqual(
      lintDelta("unit/cpp/Test.cpp", null, ok),
      [],
      `expected clean: ${ok}`,
    );
  }
});

test("codegen / pragma / if0 / section / binpatch escapes", () => {
  assert.deepEqual(ruleIds(lintDelta("u.cpp", null, "#pragma push\n")), [
    "no_pragmas",
  ]);
  assert.deepEqual(ruleIds(lintDelta("u.cpp", null, "#if 0\n")), ["no_if0"]);
  assert.deepEqual(
    ruleIds(lintDelta("u.cpp", null, '__declspec(section ".init") void f();\n')),
    ["no_section_attr"],
  );
  assert.deepEqual(
    ruleIds(lintDelta("u.cpp", null, "__attribute__((section(\".data\"))) int x;\n")),
    ["no_section_attr"],
  );
  assert.deepEqual(
    ruleIds(lintDelta("u.cpp", null, "DECOMP_FORCELITERAL int x;\n")),
    ["no_codegen_macros"],
  );
  assert.deepEqual(
    ruleIds(lintDelta("u.cpp", null, "apply_insn_patches();\n")),
    ["no_binary_patching"],
  );
  assert.deepEqual(
    ruleIds(lintDelta("u.cpp", null, "DECOMP_ASM_INSN_BEGIN\n")),
    ["no_asm_insn_shim"],
  );
});

test("no_volatile_fake_stack", () => {
  assert.deepEqual(
    ruleIds(lintDelta("u.cpp", null, "volatile u8 buf[0x40];\n")),
    ["no_volatile_fake_stack"],
  );
  assert.deepEqual(
    ruleIds(lintDelta("u.cpp", null, "char stack16[16];\n")),
    ["no_volatile_fake_stack"],
  );
});

test("non_sjis_char: em-dash and non-encodable chars are flagged, Japanese is not", () => {
  const bad = lintDelta("unit/cpp/Test.cpp", null, "const char* s = \"a\u2014b\";\n");
  assert.deepEqual(ruleIds(bad), ["non_sjis_char"]);

  // Latin-1 supplement (é) has no Shift-JIS encoding.
  const latin = lintDelta("unit/cpp/Test.cpp", null, "// caf\u00e9\n");
  assert.deepEqual(ruleIds(latin), ["non_sjis_char"]);

  // Genuine Japanese round-trips through Shift-JIS.
  const jp = lintDelta(
    "unit/cpp/Test.cpp",
    null,
    "// \u3057 \u30ab \u6f22 \u3002 \u301c\n",
  );
  assert.deepEqual(jp, []);

  // U+FF5E (full-width tilde) is NOT encodable in the Python codec;
  // U+301C (wave dash) is. Ports lint.py's codec behavior exactly.
  const tilde = lintDelta("unit/cpp/Test.cpp", null, "// a\uFF5Eb\n");
  assert.deepEqual(ruleIds(tilde), ["non_sjis_char"]);
  const wave = lintDelta("unit/cpp/Test.cpp", null, "// a\u301Cb\n");
  assert.deepEqual(wave, []);

  // Non-BMP (emoji) never encodes.
  const emoji = lintDelta("unit/cpp/Test.cpp", null, "// \u{1F600}\n");
  assert.deepEqual(ruleIds(emoji), ["non_sjis_char"]);
});

test("non_sjis_char: curly quotes are encodable (port of lint.py's code, not its comment)", () => {
  // lint.py's comment claims U+2018/2019 fail the build, but its code uses
  // Python's shift_jis codec, which DOES encode them (JIS X 0208 row 1). We
  // port the code.
  const curly = lintDelta("unit/cpp/Test.cpp", null, "// 'quote'\n".replace("'", "\u2018").replace("'", "\u2019"));
  assert.deepEqual(curly, []);
});

test("findings carry stable rule/line/snippet/message fields", () => {
  const [f] = lintDelta("unit/cpp/Test.cpp", null, "  void* p = 0;  \n");
  assert.ok(f);
  assert.equal(f.rule, "no_void_ptr");
  assert.equal(f.line, 1);
  assert.ok(f.snippet!.startsWith("void* p = 0;"));
  assert.match(f.message, /void\* is forbidden/);
  assert.equal(f.column, undefined);
});

test("deltaRules registry exposes every gate rule id", () => {
  const ids = new Set(deltaRules.map((r) => r.id));
  for (const id of [
    "non_sjis_char",
    "extern_c_in_c",
    "no_pragmas",
    "no_if0",
    "no_section_attr",
    "no_codegen_macros",
    "no_binary_patching",
    "no_extern_c",
    "cpp_free_ctor",
    "no_angle_include",
    "no_asm",
    "no_volatile_fake_stack",
    "no_asm_insn_shim",
    "no_init_side_effect",
    "no_register_keyword",
    "no_register_names",
    "no_void_ptr",
    "no_unk_name",
    "no_unk_generated",
    "no_offset_arithmetic",
  ]) {
    assert.ok(ids.has(id), `missing rule ${id}`);
  }
});

test("lintDelta only lints added lines, not untouched context", () => {
  const oldText = "int keep = 0;\nvoid* old_bad = 0;\n";
  const newText = "int keep = 0;\nvoid* old_bad = 0;\nvoid* new_bad = 0;\n";
  const findings = lintDelta("unit/cpp/Test.cpp", oldText, newText);
  assert.deepEqual(ruleIds(findings), ["no_void_ptr"]);
  assert.equal(findings[0]!.line, 3); // only the NEW line is flagged
});
