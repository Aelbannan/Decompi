/**
 * M1a tests for the pointer-arithmetic source rules
 * (`src/parse/cpp/rules/pointer.ts`): one representative snippet per SPEC
 * §13.1 category (port of `tools/coop/detect_pointer_arithmetic.py`), plus
 * overlap-suppression and negative cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCpp } from "../src/parse/cpp/tree.js";
import { pointerRules } from "../src/parse/cpp/rules/pointer.js";
import type { Finding } from "../src/parse/cpp/types.js";

/** Run a single rule by id over `source`. */
function runRule(id: string, source: string): Finding[] {
  const { root } = parseCpp(source);
  const rule = pointerRules.find((r) => r.id === id);
  assert.ok(rule, `no rule with id ${id}`);
  return rule.run(root, source);
}

/** Run all six rules over `source`, flattening in registry order. */
function runAll(source: string): Finding[] {
  const { root } = parseCpp(source);
  return pointerRules.flatMap((r) => r.run(root, source));
}

const RULE_IDS = [
  "ptr.cast_byte_offset_deref",
  "ptr.cast_byte_ptr_arith",
  "ptr.cast_int_arith",
  "ptr.subscript_on_cast",
  "ptr.ptr_offset_deref",
  "ptr.reinterpret_arith",
];

test("pointerRules exports the six SPEC §13.1 categories in order", () => {
  assert.deepEqual(
    pointerRules.map((r) => r.id),
    RULE_IDS,
  );
  for (const r of pointerRules) {
    assert.ok(r.description.length > 0);
    assert.equal(typeof r.run, "function");
  }
});

test("ptr.cast_byte_offset_deref: *(T*)((byte*)expr + N)", () => {
  const src = `void f(char* p) {
  int x = *(int*)((char*)p + 4);
  int y = *(MyType*)((u8*)p - 8);
}
`;
  const hits = runRule("ptr.cast_byte_offset_deref", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 2);
  assert.equal(hits[0]!.column, 11);
  assert.equal(hits[0]!.snippet, "*(int*)((char*)p + 4)");
  assert.match(hits[0]!.message, /char/);
  assert.match(hits[1]!.message, /u8/);
  // Integer-cast inner bases do NOT fire the byte rule.
  assert.equal(
    runRule("ptr.cast_byte_offset_deref", "void f(char* p) { int x = *(int*)((u32)p + 4); }").length,
    0,
  );
});

test("ptr.cast_byte_ptr_arith: (byte*)expr + N", () => {
  const src = `void f(void* p) {
  char* a = (char*)p + 4;
  char* b = (unsigned char*)p + 0x10;
  char* c = (u8*)p - 2;
}
`;
  const hits = runRule("ptr.cast_byte_ptr_arith", src);
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.line, 2);
  assert.equal(hits[0]!.snippet, "(char*)p + 4");
  assert.equal(hits[1]!.snippet, "(unsigned char*)p + 0x10");
  // Integer-pointer casts are not byte casts.
  assert.equal(
    runRule("ptr.cast_byte_ptr_arith", "void f(char* p) { char* q = (u32*)p + 4; }").length,
    0,
  );
});

test("ptr.cast_int_arith: (T*)((int-type)expr + N)", () => {
  const src = `void f(char* p) {
  int* a = (int*)((u32)p + 4);
  int* b = (int*)((unsigned int)p + 0x10);
  int* c = (MyType*)((uintptr_t)p - 2);
}
`;
  const hits = runRule("ptr.cast_int_arith", src);
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.line, 2);
  assert.equal(hits[0]!.snippet, "(int*)((u32)p + 4)");
  // Byte-cast inner bases are not integer casts.
  assert.equal(
    runRule("ptr.cast_int_arith", "void f(char* p) { int* q = (int*)((char*)p + 4); }").length,
    0,
  );
});

test("ptr.subscript_on_cast: ((T*)expr)[...]", () => {
  const src = `void f(char* p) {
  int x = ((int*)p)[2];
  int y = ((MyType*)p + 1)[0];
}
`;
  const hits = runRule("ptr.subscript_on_cast", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 2);
  assert.equal(hits[0]!.column, 11);
  assert.equal(hits[0]!.snippet, "((int*)p)[2]");
  // Plain subscript without a cast is fine.
  assert.equal(
    runRule("ptr.subscript_on_cast", "void f(char* p) { int x = p[2]; }").length,
    0,
  );
});

test("ptr.ptr_offset_deref: *(T*)(expr + N)", () => {
  const src = `void f(int* p) {
  int x = *(int*)(p + 4);
  int y = *(MyType*)(p - 0x10);
}
`;
  const hits = runRule("ptr.ptr_offset_deref", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 2);
  assert.equal(hits[0]!.snippet, "*(int*)(p + 4)");
  assert.match(hits[0]!.message, /variable p/);
  // Non-identifier bases (literals, NULL, calls) do not fire.
  const neg =
    "void f(int* p) { " +
    "int a = *(int*)(NULL + 4); " +
    "int b = *(int*)(get() + 4); " +
    "int c = *(int*)(0x8000 + 4); " +
    "}";
  assert.equal(runRule("ptr.ptr_offset_deref", neg).length, 0);
});

test("ptr.reinterpret_arith: reinterpret_cast<T*>(reinterpret_cast<byte*>(p) + N)", () => {
  const src = `void f(char* p) {
  int* a = reinterpret_cast<int*>(reinterpret_cast<char*>(p) + 4);
  char* b = reinterpret_cast<char*>(p) + 0x10;
}
`;
  const hits = runRule("ptr.reinterpret_arith", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 2);
  assert.equal(hits[0]!.snippet, "reinterpret_cast<int*>(reinterpret_cast<char*>(p) + 4)");
  assert.match(hits[0]!.message, /target int\*/);
  assert.match(hits[1]!.message, /baseCast char\*/);
  // reinterpret_cast without arithmetic is not flagged.
  assert.equal(
    runRule("ptr.reinterpret_arith", "void f(char* p) { int* q = reinterpret_cast<int*>(p); }").length,
    0,
  );
  // Outer target may be any type (Python `[^>]+`), not just a pointer.
  const scalar = runRule(
    "ptr.reinterpret_arith",
    "void f(char* p) { u32 q = reinterpret_cast<u32>(reinterpret_cast<u8*>(p) + 4); }",
  );
  assert.equal(scalar.length, 1);
  assert.match(scalar[0]!.message, /target u32/);
});

test("cross-rule overlap suppression matches the Python full-scan dedupe", () => {
  // `*(int*)((char*)p + 4)` → cast_byte_offset_deref wins; the nested
  // `(char*)p + 4` binary is dropped from cast_byte_ptr_arith.
  const src = `void f(char* p) {
  int x = *(int*)((char*)p + 4);
  int* q = (int*)((u32)p + 4);
}
`;
  const byRule = new Map<string, number>();
  for (const f of runAll(src)) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(byRule), {
    "ptr.cast_byte_offset_deref": 1,
    "ptr.cast_int_arith": 1,
  });
  // Nested reinterpret: inner `reinterpret_cast<char*>(p) + 4` is dropped.
  const r2 = runAll(
    "void f(char* p) { int* q = reinterpret_cast<int*>(reinterpret_cast<char*>(p) + 4); }",
  );
  assert.deepEqual(r2.map((f) => f.rule), ["ptr.reinterpret_arith"]);
  assert.equal(r2.length, 1);
});

test("benign pointer use produces no findings", () => {
  const src = `void f(char* p) {
  int x = p[2];
  char* q = p + 4;
  int y = *(p + 4);
  int* r = reinterpret_cast<int*>(p);
  int s = *(int*)p;
  int* t = (int*)p;
  for (int i = 0; i < 4; ++i) { x += *(p + i); }
}
`;
  assert.deepEqual(runAll(src), []);
});
