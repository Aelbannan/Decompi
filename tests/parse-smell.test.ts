/**
 * M1a tests for the smell-scan source rules (`src/parse/cpp/rules/smell.ts`):
 * a port of `tools/coop/smell_scan.py` (SPEC §13.1) covering every rule id,
 * with focus on the required families: extern_c, self_param, void_ptr,
 * ptr_arith, class_in_cpp, fake_array_access, vtable_wrapper, init_side_effect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCpp } from "../src/parse/cpp/tree.js";
import { smellRules } from "../src/parse/cpp/rules/smell.js";
import type { Finding } from "../src/parse/cpp/types.js";

/** Run a single rule by id over `source`. */
function runRule(id: string, source: string): Finding[] {
  const { root } = parseCpp(source);
  const rule = smellRules.find((r) => r.id === id);
  assert.ok(rule, `no rule with id ${id}`);
  return rule.run(root, source);
}

/** Run all 21 rules over `source`, flattening in registry order. */
function runAll(source: string): Finding[] {
  const { root } = parseCpp(source);
  return smellRules.flatMap((r) => r.run(root, source));
}

const RULE_IDS = [
  "smell.extern_c",
  "smell.self_param",
  "smell.self_access",
  "smell.void_ptr",
  "smell.void_ptr_cast",
  "smell.ptr_arith",
  "smell.deref_arith",
  "smell.asm_code",
  "smell.fake_stack",
  "smell.rn_params",
  "smell.goto_count",
  "smell.decomp_macro",
  "smell.pragma",
  "smell.asm_insn_shim",
  "smell.schedule_pragma",
  "smell.init_side_effect",
  "smell.if0",
  "smell.class_in_cpp",
  "smell.struct_in_cpp",
  "smell.fake_array_access",
  "smell.vtable_wrapper",
];

test("smellRules exports the 21 SPEC §13.1 ids in order", () => {
  assert.deepEqual(
    smellRules.map((r) => r.id),
    RULE_IDS,
  );
  for (const r of smellRules) {
    assert.ok(r.description.length > 0);
    assert.equal(typeof r.run, "function");
  }
});

test("smell.extern_c: per-declaration split inside a block", () => {
  const src = `extern "C" {
  void lbl_fun(void) { }
  void foo(void);
  int bar;
}
`;
  const hits = runRule("smell.extern_c", src);
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.rule, "smell.extern_c");
  assert.equal(hits[0]!.line, 2);
  assert.match(hits[0]!.message, /kind=lbl/);
  assert.match(hits[0]!.message, /lbl_fun/);
  assert.match(hits[1]!.message, /kind=nonlbl-decl/);
  assert.match(hits[1]!.message, /foo/);
  assert.match(hits[2]!.message, /kind=other/);
  assert.match(hits[2]!.message, /bar/);
});

test("smell.extern_c: no-block form, defs, and empty blocks", () => {
  const decl = runRule("smell.extern_c", `extern "C" void foo(void);`);
  assert.equal(decl.length, 1);
  assert.match(decl[0]!.message, /kind=nonlbl-decl/);
  const def = runRule(
    "smell.extern_c",
    `extern "C" {\n  void foo(void) { }\n  void lbl_eu_1234(void);\n}`,
  );
  assert.equal(def.length, 2);
  assert.match(def[0]!.message, /kind=nonlbl-def/);
  assert.match(def[1]!.message, /kind=lbl/);
  // Empty block, and a non-C linkage (extern "C++"), emit nothing.
  assert.deepEqual(runRule("smell.extern_c", `extern "C" { }`), []);
  assert.deepEqual(runRule("smell.extern_c", `extern "C++" { void foo(void); }`), []);
});

test("smell.extern_c: lbl_* is an UN-ANCHORED search over the declarator text", () => {
  // Python's RE_LBL matches `\blbl_…` anywhere in the line; the anchored
  // form misses function-pointer declarators, whose text starts with `(`.
  const src = `extern "C" {\n  void (*lbl_fp)(void);\n  void (*plain_fp)(void);\n}`;
  const hits = runRule("smell.extern_c", src);
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.message, /kind=lbl/);
  assert.match(hits[0]!.message, /lbl_fp/);
  assert.match(hits[1]!.message, /kind=nonlbl-decl/);
});

test("smell.self_param: parameter named self", () => {
  const src = `int f(int* self, int x) { return *self; }
void g(void) { auto h = [](int self) { return self; }; }
int k(int x, int self) { return self; }
`;
  const hits = runRule("smell.self_param", src);
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.line, 1);
  assert.match(hits[0]!.message, /'self'/);
  // No param named self.
  assert.deepEqual(runRule("smell.self_param", "int f(int* s, int x) { return *s; }"), []);
});

test("smell.self_access: self-> member-style access", () => {
  const src = `int f(void* self) { return self->x; }
int g(void* self) { return self->method(); }
`;
  const hits = runRule("smell.self_access", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 1);
  assert.match(hits[0]!.snippet!, /self->x/);
  // Dot access and non-self bases do not fire.
  assert.deepEqual(runRule("smell.self_access", "int f(void* s) { return s->x; }"), []);
  assert.deepEqual(runRule("smell.self_access", "int f(void* self) { return self.x; }"), []);
});

test("smell.void_ptr: named void* declarators (params, locals, returns)", () => {
  const src = `void* foo(void* p) {
  void* q = p;
  return q;
}
`;
  const hits = runRule("smell.void_ptr", src);
  assert.equal(hits.length, 3); // return type foo, param p, local q
  assert.match(hits[0]!.message, /foo/);
  assert.match(hits[1]!.message, /'p'/);
  // C-style casts are not void_ptr (they are void_ptr_cast); typed pointers are fine.
  assert.equal(runRule("smell.void_ptr", "void f(int* p) { int* q = (int*)p; }").length, 0);
  // void** counts once (Python misses it).
  assert.equal(runRule("smell.void_ptr", "void f(void) { void** p; }").length, 1);
});

test("smell.void_ptr_cast: C-style cast to void*", () => {
  const src = `void f(int* p) { void* q = (void*)p; void** r = (void**)q; }`;
  const hits = runRule("smell.void_ptr_cast", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 1);
  assert.match(hits[0]!.message, /void\*/);
  // static_cast / reinterpret_cast are not C-style casts.
  assert.equal(
    runRule("smell.void_ptr_cast", "void f(int* p) { void* q = static_cast<void*>(p); }").length,
    0,
  );
});

test("smell.ptr_arith: scalar-pointer cast with numeric offset", () => {
  const src = `void f(char* p) {
  char* a = (char*)p + 4;
  char* b = (char*)p - 0x10;
  u32* c = (u32*)(p + 0x20);
  char* d = (char*)(p) + 8;
}
`;
  const hits = runRule("smell.ptr_arith", src);
  assert.equal(hits.length, 4);
  assert.equal(hits[0]!.line, 2);
  assert.match(hits[0]!.snippet!, /\(char\*\)p \+ 4/);
  assert.match(hits[1]!.message, /offset 0x10/);
  // Form B (cast whose parenthesized value is the arithmetic) is emitted last.
  assert.equal(hits[3]!.line, 4);
  assert.match(hits[3]!.message, /offset 0x20/);
  // Non-scalar targets, missing literals, and reverse orientation do not fire.
  // (A deref form like `*(int*)((char*)p + 4)` DOES fire, mirroring Python's
  // per-line cast+offset count — that line is deref_arith AND ptr_arith.)
  const neg = `void f(char* p, int q) {
  char* a = (MyType*)p + 4;
  char* b = (char*)p + q;
  char* c = 4 + (char*)p;
}`;
  assert.equal(runRule("smell.ptr_arith", neg).length, 0);
});

test("smell.ptr_arith: Python RE_DEC_OFF terminator after a decimal offset", () => {
  // `;` terminator fires (canonical statement form).
  assert.equal(
    runRule("smell.ptr_arith", "void f(char* p) { char* a = (char*)p + 4; }").length,
    1,
  );
  // `)` / `,` / `]` terminators fire.
  assert.equal(
    runRule("smell.ptr_arith", "void f(char* p) { foo((char*)p + 4, x); }").length,
    1,
  );
  assert.equal(
    runRule("smell.ptr_arith", "void f(char* p) { u8 b = ((char*)p + 4)[0]; }").length,
    1,
  );
  // A decimal offset followed by anything else (here `==`) is NOT terminated
  // and never fires — Python RE_DEC_OFF requires `)`/`,`/`;`/`]`.
  assert.equal(
    runRule("smell.ptr_arith", "void f(char* p) { bool b = (char*)p + 4 == 0; }").length,
    0,
  );
  // Hex offsets (RE_HEX_OFF) need no terminator.
  assert.equal(
    runRule("smell.ptr_arith", "void f(char* p) { return (char*)p + 0x10; }").length,
    1,
  );
});

test("smell.deref_arith: Python RE_DEREF_ARITH semantics (inner scalar cast + `+`)", () => {
  const src = `void f(char* p) {
  int x = *(int*)((char*)p + 4);
  int y = *(u32*)((u8*)p + 0x10);
  int z = *(int*)((u32)p + q);
}
`;
  const hits = runRule("smell.deref_arith", src);
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.line, 2);
  assert.match(hits[0]!.snippet!, /\*\(int\*\)\(\(char\*\)p \+ 4\)/);
  // Scalar cast without a trailing `*` also fires: `(u32)p` (Python `\*?`).
  assert.match(hits[2]!.message, /u32/);
  // Python parity: NO inner scalar cast, a `-` offset, or a non-enumerated
  // inner base never fires — `*(int*)(p + 4)` is not deref_arith.
  assert.equal(runRule("smell.deref_arith", "void f(int* p) { int x = *(int*)(p + 4); }").length, 0);
  assert.equal(
    runRule("smell.deref_arith", "void f(char* p) { int x = *(int*)((char*)p - 4); }").length,
    0,
  );
  assert.equal(
    runRule("smell.deref_arith", "void f(char* p) { int x = *(int*)((uint32_t*)p + 4); }").length,
    0,
  );
  // Calls in the value cannot cross a `)` (Python `[^)]*`) — no fire.
  assert.equal(
    runRule("smell.deref_arith", "void f(int* p) { int x = *(int*)(get() + 4); }").length,
    0,
  );
  // Plain deref without arithmetic is fine.
  assert.equal(runRule("smell.deref_arith", "void f(int* p) { int x = *(int*)p; }").length, 0);
});

test("smell.asm_code: gnu asm, register keyword, and unparsed MWCC asm", () => {
  const src = `void f(void) {
  asm("lis r3, 0");
  register int r3 = 0;
}
asm void g(register u32 r4) { }
`;
  const hits = runRule("smell.asm_code", src);
  // One per line: asm expr, register decl, and the asm fn line (asm + register deduped).
  assert.equal(hits.length, 3);
  assert.deepEqual(
    hits.map((h) => h.line),
    [2, 3, 5],
  );
  // Comment-only asm text is stripped like Python.
  assert.deepEqual(runRule("smell.asm_code", "// asm(\"x\")\nint f(void) { return 0; }"), []);
});

test("smell.fake_stack: volatile byte arrays and sp/stack arrays", () => {
  const src = `void f(void) {
  volatile u8 sp[0x100];
  char stack[4];
  u8 buf[64];
  volatile u32 sp2[4];
}
`;
  const hits = runRule("smell.fake_stack", src);
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.message, /'sp'/);
  assert.match(hits[0]!.message, /volatile/);
  assert.match(hits[1]!.message, /'stack'/);
});

test("smell.rn_params: register-named parameters r3..r31", () => {
  const src = `void f(u32 r3) { }
void g(u32 r31, u32 r4) { }
`;
  const hits = runRule("smell.rn_params", src);
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.line, 1);
  assert.match(hits[0]!.message, /'r3'/);
  // r2 and locals are not register-named *parameters*.
  assert.equal(runRule("smell.rn_params", "void f(u32 r2) { }").length, 0);
  assert.equal(runRule("smell.rn_params", "void f(void) { u32 r3 = 0; }").length, 0);
});

test("smell.goto_count: one finding per goto", () => {
  const src = `void f(void) {
  goto done;
  goto done;
done:
  return;
}
`;
  const hits = runRule("smell.goto_count", src);
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => h.line),
    [2, 3],
  );
});

test("smell.decomp_macro: DECOMP_* macros (comment-stripped)", () => {
  const src = `void f(void) { DECOMP_FORCELITERAL(1); }
void g(void) { DECOMP_PPC(lis r3, 0); }
// DECOMP_FORCEACTIVE(1) in a comment
`;
  const hits = runRule("smell.decomp_macro", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 1);
  assert.equal(hits[1]!.line, 2);
});

test("smell.pragma / smell.schedule_pragma / smell.asm_insn_shim / smell.if0", () => {
  const src = `#pragma schedule once
void f(void) { DECOMP_ASM_INSN_BEGIN; }
#pragma some_other
#if 0
void dead(void) {}
#endif
`;
  assert.equal(runRule("smell.pragma", src).length, 2);
  const sched = runRule("smell.schedule_pragma", src);
  assert.equal(sched.length, 1);
  assert.equal(sched[0]!.line, 1);
  const shim = runRule("smell.asm_insn_shim", src);
  assert.equal(shim.length, 1);
  assert.equal(shim[0]!.line, 2);
  const if0 = runRule("smell.if0", src);
  assert.equal(if0.length, 1);
  assert.equal(if0[0]!.line, 4);
});

test("smell.init_side_effect: assignment inside a cast used as a value", () => {
  // Single-line and the two-line SeqSound shape (assignment on a later line).
  const src = `void f(void) {
  mHandle = reinterpret_cast<void*>(mFlag = false);
  mTempSpecialHandle(reinterpret_cast<SeqSoundHandle*>(
      mPreparedFlag = mLoadingFlag = false)),
}
`;
  const hits = runRule("smell.init_side_effect", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 2);
  assert.equal(hits[1]!.line, 3);
  // `==` comparisons and assignments inside nested parens do not fire.
  assert.equal(
    runRule("smell.init_side_effect", "void f(void) { void* h = reinterpret_cast<T*>(mFlag == false); }").length,
    0,
  );
  assert.equal(
    runRule("smell.init_side_effect", "void f(void) { void* h = reinterpret_cast<T*>(wrap(mFlag = false)); }").length,
    0,
  );
});

test("smell.class_in_cpp / smell.struct_in_cpp: definitions only", () => {
  const src = `class Foo {
public:
  int x;
};
struct Bar { int y; };
class Fwd;
struct S;
`;
  const classes = runRule("smell.class_in_cpp", src);
  assert.equal(classes.length, 1);
  assert.equal(classes[0]!.line, 1);
  assert.match(classes[0]!.message, /'Foo'/);
  const structs = runRule("smell.struct_in_cpp", src);
  assert.equal(structs.length, 1);
  assert.match(structs[0]!.message, /'Bar'/);
});

test("smell.fake_array_access: constant index on a non-array identifier", () => {
  const src = `void f(int* p, int arr[4]) {
  int a = p[0];
  int b = p[2];
  int c = arr[1];
}
`;
  const hits = runRule("smell.fake_array_access", src);
  assert.equal(hits.length, 2); // p is a pointer param, arr is an array param
  assert.deepEqual(
    hits.map((h) => h.line),
    [2, 3],
  );
  assert.match(hits[0]!.message, /'p'/);
  // Real arrays, member bases, and non-constant indices do not fire.
  assert.deepEqual(
    runRule("smell.fake_array_access", "void f(void) { int p[4]; int x = p[0]; }"),
    [],
  );
  assert.deepEqual(
    runRule("smell.fake_array_access", "void f(int* p, int i) { int x = p[i]; }"),
    [],
  );
  assert.deepEqual(
    runRule("smell.fake_array_access", "struct S { int a[4]; }; void f(S* s) { int x = s->a[0]; }"),
    [],
  );
});

test("smell.vtable_wrapper: ((Fn**)(*(u32*)obj))[i]", () => {
  const src = `void f(void* obj) {
  Fn fn = ((Fn**)(*(u32*)obj))[3];
  int slot = ((VTable**)(*(int*)obj))[0x24 / 4];
}
`;
  const hits = runRule("smell.vtable_wrapper", src);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 2);
  assert.match(hits[0]!.snippet!, /\(\(Fn\*\*\)\(\*\(u32\*\)obj\)\)\[3\]/);
  // Single-star casts, non-integer inner bases, and plain subscripts do not fire.
  assert.equal(
    runRule("smell.vtable_wrapper", "void f(void* obj) { Fn fn = ((Fn*)(*(u32*)obj))[3]; }").length,
    0,
  );
  assert.equal(
    runRule("smell.vtable_wrapper", "void f(void* obj) { Fn fn = ((Fn**)(*(char*)obj))[3]; }").length,
    0,
  );
  assert.equal(runRule("smell.vtable_wrapper", "void f(int* p) { int x = p[3]; }").length, 0);
});

test("benign code produces no smell findings", () => {
  const src = `#include <stdint.h>
typedef uint32_t u32;
struct Point;
class Helper;
static int sum(const int* arr, int n) {
  int total = 0;
  for (int i = 0; i < n; ++i) {
    total += arr[i];
  }
  return total;
}
`;
  assert.deepEqual(runAll(src), []);
});
