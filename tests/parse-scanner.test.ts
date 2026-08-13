/**
 * M1b tests for the extern "C" declaration scanner (`src/parse/symbols/
 * scanner.ts`), a line-based port of `tools/coop/extc.py`'s extractor
 * (`extract_entries` / `extern_c_defs_with_bodies` / `name_from` /
 * `logical_line`). Covers the single-line path, multi-line continuations,
 * true `extern "C" { … }` block bodies, pointer-to-function / pointer-to-
 * member names, and the reference's quirks (a col-0 line directly after a
 * definition is consumed by the definition's continuation scan and lost).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  extractEntries,
  externCDefsWithBodies,
  hasSelfStyleParam,
  nameFrom,
  RE_CLASS_CAST,
  stripComment,
} from "../src/parse/symbols/scanner.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("stripComment: strips /* */ and // comments", () => {
  assert.equal(stripComment("int x; // trailing"), "int x; ");
  assert.equal(stripComment("int /* mid */ x;"), "int   x;");
  assert.equal(stripComment("no comments"), "no comments");
});

test("nameFrom: plain function declaration", () => {
  assert.equal(nameFrom("int func_80295764(void* self)"), "func_80295764");
  assert.equal(nameFrom("void __dt__12CTaskGameEvtFv(void*, int)"), "__dt__12CTaskGameEvtFv");
});

test("nameFrom: pointer-to-function variable `int (*cb)(...)`", () => {
  assert.equal(nameFrom("int (*cb)(int a, int b)"), "cb");
  assert.equal(nameFrom("void (*const cb2)(void)"), "cb2");
});

test("nameFrom: pointer-to-member variable `int (Class::*pfn)(...)`", () => {
  assert.equal(nameFrom("int (CCtrlMovePC::*const lbl)(int)"), "lbl");
});

test("nameFrom: __declspec and attribute macros are stripped", () => {
  assert.equal(nameFrom("__declspec(noinline) void func_8022D1F8(void* self)"), "func_8022D1F8");
  assert.equal(nameFrom("__attribute__((noinline)) void f(void)"), "f");
  assert.equal(nameFrom("void f(void) __attribute__((noreturn))"), "f");
});

test("nameFrom: trailing plain name fallback", () => {
  assert.equal(nameFrom("extern int gGlobalValue"), "gGlobalValue");
  assert.equal(nameFrom("u8 gArray[16]"), "gArray");
  assert.equal(nameFrom(""), null);
  assert.equal(nameFrom("__attribute__((x))"), null);
});

test("extractEntries: single-line declarations only", () => {
  const lines = [
    'extern "C" int func_80295764(void* self);',
    "// a comment",
    "void not_extern(int x);",
    'extern "C" void __dt__12CTaskGameEvtFv(void*, int);',
  ];
  const entries = extractEntries(lines);
  assert.deepEqual(
    entries.map((e) => [e.lineno, e.name]),
    [
      [1, "func_80295764"],
      [4, "__dt__12CTaskGameEvtFv"],
    ],
  );
  assert.deepEqual(entries[0]!.raw, 'extern "C" int func_80295764(void* self);');
});

test("extractEntries: multi-line continuation declarations", () => {
  const lines = [
    'extern "C" void',
    "    func_80295764(void* self);",
    'extern "C" int',
    "    multi_line_fn(int a,",
    "                 int b);",
  ];
  const entries = extractEntries(lines);
  assert.deepEqual(
    entries.map((e) => [e.lineno, e.name]),
    [
      [1, "func_80295764"],
      [3, "multi_line_fn"],
    ],
  );
});

test("extractEntries: true extern \"C\" { … } block bodies are extracted", () => {
  const lines = [
    'extern "C" {',
    "  void blockFunc1(void* self);",
    "  int blockFunc2(void);",
    "  struct WithBraces { int x; }; // not a decl (typedef/using or `=` skipped)",
    "  void blockFunc3(void);",
    "}",
  ];
  const entries = extractEntries(lines);
  assert.deepEqual(
    entries.map((e) => [e.lineno, e.name]),
    [
      [2, "blockFunc1"],
      [3, "blockFunc2"],
      [5, "blockFunc3"],
    ],
  );
});

test("extractEntries: a col-0 decl directly after a def is EATEN (reference quirk)", () => {
  // the def's logical_line consumes the first col-0 line after it (breaks
  // without yielding) and the outer loop resumes past it — mirroring
  // extc.py's extract_entries on the frozen CTaskGameEvt.cpp fixture
  const lines = [
    'extern "C" void cbRenderBefore__12CTaskGameEvtFv(void* self) { (void)self; }',
    'extern "C" void __dt__12CTaskGameEvtFv(void*, int);',
    "// unrelated",
    "int plain(void);",
  ];
  const entries = extractEntries(lines);
  assert.deepEqual(entries, []);
  // ...only the FIRST col-0 decl after a def is eaten; the next survives
  const entries2 = extractEntries([
    'extern "C" void cbRenderBefore__12CTaskGameEvtFv(void* self) { (void)self; }',
    'extern "C" void first_eaten(void* self);',
    'extern "C" void __dt__12CTaskGameEvtFv(void*, int);',
  ]);
  assert.deepEqual(
    entries2.map((e) => e.name),
    ["__dt__12CTaskGameEvtFv"],
  );
});

test("extractEntries: definitions are never yielded (defs carry {)", () => {
  const lines = [
    'extern "C" void OnFileEvent__12CTaskGameEvtFP10CEventFile(void* self) { (void)self; }',
    'extern "C" int func_80295764(void* self) { (void)self; return 0; }',
  ];
  assert.deepEqual(extractEntries(lines), []);
});

test("externCDefsWithBodies: definitions with brace-balanced bodies", () => {
  const lines = [
    'extern "C" void OnFileEvent__12CTaskGameEvtFP10CEventFile(void* self) { ((void(*)(void*))func_80295764)((char*)self - 0x54); }',
    'extern "C" void cbRenderBefore__12CTaskGameEvtFv(void* self) { (void)self; }',
    "void plain(void) { }", // not extern C
  ];
  const defs = externCDefsWithBodies(lines);
  assert.deepEqual(
    defs.map((d) => [d.lineno, d.name, d.header]),
    [
      [1, "OnFileEvent__12CTaskGameEvtFP10CEventFile", "void OnFileEvent__12CTaskGameEvtFP10CEventFile(void* self)"],
      [2, "cbRenderBefore__12CTaskGameEvtFv", "void cbRenderBefore__12CTaskGameEvtFv(void* self)"],
    ],
  );
  assert.match(defs[0]!.body, /func_80295764/);
});

test("hasSelfStyleParam / RE_CLASS_CAST mirrors extc.py", () => {
  assert.equal(hasSelfStyleParam("void f(void* self)"), true);
  assert.equal(hasSelfStyleParam("void f(CExchangeWin* _this)"), true);
  assert.equal(hasSelfStyleParam("void f(T * p, int x)"), true);
  assert.equal(hasSelfStyleParam("void f(int x, void* self)"), false); // first param only
  assert.equal(hasSelfStyleParam("void f(void)"), false);

  const cast = RE_CLASS_CAST.exec(" { ((CExchangeWin*)self)->field = 0; }");
  assert.equal(cast?.[1], "CExchangeWin");
  assert.equal(RE_CLASS_CAST.exec(" { (void*)self; }"), null);
});

test("scanner parity on the frozen CTaskGameEvt.cpp source (recorded entries)", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURES, "parity-extc-scan.json"), "utf8")
  ) as { source: string; sourceEntries: Array<{ lineno: number; name: string | null; raw: string }> };
  const entries = extractEntries(fixture.source.split(/\r?\n/));
  assert.deepEqual(
    entries.map((e) => ({ lineno: e.lineno, name: e.name, raw: e.raw })),
    fixture.sourceEntries.map((e) => ({ lineno: e.lineno, name: e.name, raw: e.raw })),
  );
  // defs recorded separately by extern_c_defs_with_bodies
  const defs = externCDefsWithBodies(fixture.source.split(/\r?\n/));
  assert.ok(defs.length >= 5, "real file has the void* self defs");
  assert.ok(defs.some((d) => d.name === "OnFileEvent__12CTaskGameEvtFP10CEventFile"));
  assert.ok(defs.some((d) => d.name === "func_80295870"));
});
