/**
 * M1b tests for the member-vs-free classifier (`src/parse/asm/member.ts`), a
 * port of `tools/coop/member_check.py` (SPEC §13.3): tiered verdicts N1/N2/N3
 * (not a member), P1 (.data pointer hint), tier_b (review) / tier_c
 * (undecidable), `integer_only` / `vtable_dispatch`, plus the source-side
 * `header_drift` / `fake_members` evidence streams and `callee_params`.
 *
 * All cases are self-contained synthetic dtk dumps (no repo `.o`/`.s` files):
 * instructions are generated with plausible bytes, and the object-file data
 * hits for P1 are passed in as plain `DataHit` objects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMember } from "../src/parse/asm/member.js";
import type { ClassifyMemberInput } from "../src/parse/asm/member.js";
import { parseAsmFile } from "../src/parse/asm/dtk.js";
import { loadSymbols } from "../src/parse/symbols/table.js";
import type { DataHit } from "../src/parse/asm/objscan.js";

const TARGET = "func_8007C0F8__Q22cf13CfGameManagerFv";
const TARGET_ADDR = 0x8007c0f8;

/** Build one `.fn name, global` … `.endfn` block with fake-but-stable bytes. */
function fn(name: string, ...insns: string[]): string {
  const lines: string[] = [`.fn ${name}, global`];
  let addr = 0x8007c000;
  for (const insn of insns) {
    const bytes = [24, 16, 8, 0]
      .map((s) => ((addr >>> s) & 0xff).toString(16).padStart(2, "0").toUpperCase())
      .join(" ");
    lines.push(`/* ${addr.toString(16).padStart(8, "0").toUpperCase()} 00000000  ${bytes} */\t${insn}`);
    addr += 4;
  }
  lines.push(`.endfn ${name}`);
  return lines.join("\n");
}

/** Run `classifyMember` over a synthetic dump with sane defaults. */
function classify(
  dump: string,
  opts: {
    classSize?: number;
    symbolsText?: string;
    dataHits?: DataHit[];
    targetSymbol?: string;
    headerText?: string;
    classSourceText?: string;
  } = {}
): ReturnType<typeof classifyMember> {
  const target = opts.targetSymbol ?? TARGET;
  const symbolsText =
    opts.symbolsText ?? `${target} = .init:0x${TARGET_ADDR.toString(16)}; // type:function`;
  const input: ClassifyMemberInput = {
    asm: parseAsmFile(dump),
    symbols: loadSymbols(symbolsText),
    dataHits: opts.dataHits ?? [],
    targetSymbol: target,
    classSize: opts.classSize ?? 0,
  };
  if (opts.headerText !== undefined) {
    input.headerText = opts.headerText;
  }
  if (opts.classSourceText !== undefined) {
    input.classSourceText = opts.classSourceText;
  }
  return classifyMember(input);
}

test("N1: nonzero constant in r3 at a call site → not_member", () => {
  const v = classify(
    [fn("caller", "li r3, 5", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x10(r3)", "blr")].join("\n"),
    { classSize: 0x100 },
  );
  assert.equal(v.verdict, "not_member");
  assert.ok(v.reasons.some((r) => r.startsWith("N1:")));
  assert.ok(v.evidence.some((e) => e.includes("CONSTANT")));
  assert.ok(v.evidence.some((e) => e.includes("li r3, 5")));
});

test("N2: integer-only r3 use (never deref'd) → integer_only verdict", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "addi r3, r3, 1", "and r3, r3, r0", "blr")].join("\n"),
  );
  assert.equal(v.verdict, "integer_only");
  assert.ok(v.reasons.some((r) => r.startsWith("integer_only:")));
});

test("N2: r3 forwarded but never deref'd and no integer ops → not_member (N2)", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "mr r3, r5", "blr")].join("\n"),
  );
  assert.equal(v.verdict, "not_member");
  assert.ok(v.reasons.some((r) => r.startsWith("N2:")));
});

test("N3: max r3-relative access offset >= class size → not_member", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x20(r3)", "stw r5, 0x1C(r3)", "blr")].join("\n"),
    { classSize: 0x10 },
  );
  assert.equal(v.verdict, "not_member");
  assert.ok(v.reasons.some((r) => r.startsWith("N3:")));
  assert.ok(v.reasons.some((r) => r.includes("0x20") && r.includes("0x10")));
  assert.ok(v.evidence.some((e) => e.includes("max_offset=0x20")));
});

test("P1: symbol address as a 4-byte .data pointer → vtable hint (instance-anchored member)", () => {
  const v = classify(
    [
      fn("caller", "lwz r4, 0x14(r30)", "mr r3, r4", `bl ${TARGET}`),
      fn(TARGET, "lwz r4, 0x0(r3)", "blr"),
    ].join("\n"),
    {
      classSize: 0x40,
      dataHits: [
        { objectFile: "kyoshin/cf/CfGameManager.o", offset: 0x14, address: TARGET_ADDR, symbol: TARGET },
      ],
    },
  );
  assert.equal(v.verdict, "member"); // P1 is a hint; the member verdict comes from instance-anchored provenance
  assert.ok(v.reasons.some((r) => r.startsWith("P1:")));
  assert.ok(v.reasons.some((r) => r.startsWith("instance-anchored:")));
  assert.ok(v.evidence.some((e) => e.startsWith("P1 data hit:")));
});

test("P1: no .data hit for the symbol → no vtable hint reported", () => {
  const v = classify(
    [fn("caller", "lwz r4, 0x14(r30)", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x0(r3)", "blr")].join("\n"),
    { classSize: 0x40 },
  );
  assert.equal(v.verdict, "member");
  assert.ok(!v.reasons.some((r) => r.startsWith("P1:")));
  assert.ok(!v.evidence.some((e) => e.startsWith("P1 data hit:")));
});

test("tier_b: all-stack provenance with in-bounds deref → review", () => {
  const v = classify(
    [fn("caller", "addi r3, r1, 0x8", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x4(r3)", "blr")].join("\n"),
    { classSize: 0x40 },
  );
  assert.equal(v.verdict, "review");
  assert.ok(v.reasons.some((r) => r.startsWith("tier_b:")));
});

test("tier_c: in-bounds deref with ambiguous provenance → undecidable", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x4(r3)", "blr")].join("\n"),
    { classSize: 0x40 },
  );
  assert.equal(v.verdict, "undecidable");
  assert.ok(v.reasons.some((r) => r.startsWith("tier_c:")));
});

test("tier_c: verdictString carries the reference's exact Tier B string (fix #9)", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x4(r3)", "blr")].join("\n"),
    { classSize: 0x40 },
  );
  assert.equal(v.verdict, "undecidable");
  // the KIND follows SPEC §13.3 (tier_c -> undecidable); the verdictString is
  // the reference's EXACT string ("Tier B: flag for review (derefs r3; no
  // instance-anchored call sites)") — renamed from the misleading
  // `pythonVerdict` which claimed an exact reference string it did not carry
  assert.ok(v.reasons.some((r) => r === "verdict: undecidable — Tier B: flag for review (derefs r3; no instance-anchored call sites)"));
});

test("r3 provenance back-scans the FILE-GLOBAL list and can cross into the prior function (fix #6)", () => {
  // funcA ends with `li r3, 5`; caller's instructions never touch r3, so the
  // file-global window i-1..i-9 crosses the function boundary and classifies
  // r3 as CONSTANT (N1 -> not_member). Under the old function-local scan the
  // window stayed inside `caller` (no r3 write -> UNKNOWN -> tier_c).
  const v = classify(
    [
      fn("funcA", "li r3, 5", "blr"),
      fn("caller", "stw r0, 0x14(r1)", "stw r31, 0x1C(r1)", `bl ${TARGET}`),
      fn(TARGET, "lwz r4, 0x4(r3)", "blr"),
    ].join("\n"),
    { classSize: 0x40 },
  );
  assert.equal(v.verdict, "not_member");
  assert.ok(v.reasons.some((r) => r.startsWith("N1:")));
  // the call-site index is file-global (Python idx.calls parity) and the
  // provenance detail names the crossing instruction
  assert.ok(v.evidence.some((e) => e.includes("call site 1: caller@4 → r3 = CONSTANT (li r3, 5)")));
});

test("r3 provenance mr-chain window is file-global too (crosses via a load in the prior function)", () => {
  // funcA ends with `lwz r4, 0x8(r30)`; caller does `mr r3, r4`; the mr-chain
  // back-scan crosses into funcA and resolves LOAD_FIELD (instance-anchored)
  const v = classify(
    [
      fn("funcA", "lwz r4, 0x8(r30)", "blr"),
      fn("caller", "mr r3, r4", `bl ${TARGET}`),
      fn(TARGET, "lwz r4, 0x4(r3)", "blr"),
    ].join("\n"),
    { classSize: 0x40 },
  );
  assert.equal(v.verdict, "member"); // instance-anchored (LOAD_FIELD)
  assert.ok(v.evidence.some((e) => e.includes("r3 = LOAD_FIELD")));
});

test("zero constant in r3 is NOT N1 (null-this ambiguity); falls to tier_c", () => {
  const v = classify(
    [fn("caller", "li r3, 0", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x4(r3)", "blr")].join("\n"),
    { classSize: 0x40 },
  );
  assert.equal(v.verdict, "undecidable");
  assert.ok(!v.reasons.some((r) => r.startsWith("N1:")));
  assert.ok(v.reasons.some((r) => r.startsWith("tier_c:")));
});

test("vtable_dispatch: r12 loaded via (r3) then bctrl → vtable_dispatch", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "lwz r12, 0x0(r3)", "bctrl", "blr")].join("\n"),
    { classSize: 0x40 },
  );
  assert.equal(v.verdict, "vtable_dispatch");
  assert.ok(v.reasons.some((r) => r.startsWith("vtable_dispatch:")));
});

test("header_drift: static header decl contradicted by this-taking binary → drift", () => {
  const v = classify(
    [
      fn("caller", "lwz r4, 0x14(r30)", "mr r3, r4", `bl ${TARGET}`),
      fn(TARGET, "lwz r4, 0x0(r3)", "blr"),
    ].join("\n"),
    {
      classSize: 0x40,
      headerText: "class CfGameManager {\n  static void func_8007C0F8(int a, int b);\n};",
    },
  );
  assert.equal(v.verdict, "member");
  assert.ok(v.reasons.some((r) => r.startsWith("header_drift:")));
  assert.ok(v.reasons.some((r) => r.includes("header declares static but binary shows this-taking")));
  assert.ok(v.reasons.some((r) => r.includes("header 2 params, binary 1")));
  assert.ok(v.evidence.some((e) => e.startsWith("header drift:")));
});

test("fake_members: this==nullptr register-read trick in class TU → flagged", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x4(r3)", "blr")].join("\n"),
    {
      classSize: 0x40,
      classSourceText: [
        "void CfGameManager::Reset() {",
        "  if (this == nullptr) return;",
        "}",
      ].join("\n"),
    },
  );
  assert.ok(v.reasons.some((r) => r.startsWith("fake_members:")));
  assert.ok(v.reasons.some((r) => r.includes("line 2")));
  assert.ok(v.evidence.some((e) => e.startsWith("fake member:")));
});

test("callee_params: binary param classes from first-use consumption", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x0(r3)", "add r5, r5, r0", "blr")].join("\n"),
  );
  assert.ok(v.evidence.some((e) => e.includes("r3=ptr") && e.includes("r5=int")));
});

test("callee_params: bool classification (compared only against 0x0/0x1)", () => {
  const v = classify(
    [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "cmpwi r3, 0x1", "blr")].join("\n"),
  );
  assert.ok(v.evidence.some((e) => e.includes("r3=bool")));
});

test("symbol absent from dump: no body / no call sites → reference fallback not_member", () => {
  const v = classify(fn("unrelated", "blr"), { targetSymbol: TARGET });
  assert.equal(v.verdict, "not_member");
  assert.ok(v.reasons.some((r) => r.includes("r3 never used as object base")));
  assert.ok(v.evidence.some((e) => e === "no call sites in dump"));
  assert.ok(v.evidence.some((e) => e === "body present: false"));
});

test("classifyMember is deterministic for identical inputs", () => {
  const dump = [fn("caller", "mr r3, r4", `bl ${TARGET}`), fn(TARGET, "lwz r4, 0x4(r3)", "blr")].join("\n");
  const a = classify(dump, { classSize: 0x40 });
  const b = classify(dump, { classSize: 0x40 });
  assert.deepEqual(a, b);
});

test("verdict shape contract: enum kind + non-empty evidence and reasons", () => {
  const v = classify([fn("caller", "li r3, 5", `bl ${TARGET}`), fn(TARGET, "blr")].join("\n"));
  assert.ok(["not_member", "member", "undecidable", "integer_only", "vtable_dispatch", "review"].includes(v.verdict));
  assert.ok(v.evidence.length > 0);
  assert.ok(v.reasons.length > 0);
  assert.ok(v.reasons.at(-1)!.startsWith("verdict:"));
});
