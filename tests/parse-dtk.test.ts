/**
 * M1b tests for the dtk retail-asm parser (`src/parse/asm/dtk.ts`): parsing a
 * small `.s` dump into functions/instructions, `bl` call-graph edges, and the
 * r3-provenance instruction helpers (readsR3 / writesR3 / isIntegerOp /
 * derefLoadOffset / derefStoreOffset / passesConstInR3), mirroring the
 * semantics of `tools/coop/member_check.py`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blTarget,
  buildCallGraph,
  derefLoadOffset,
  derefStoreOffset,
  isIntegerOp,
  parseAsmFile,
  passesConstInR3,
  readsR3,
  writesR3,
} from "../src/parse/asm/dtk.js";

/**
 * Hand-written dtk-style dump: two functions, a `bl` edge, a `lwz r4, 0x10(r3)`,
 * a `li r3, 5`, a trailing `//` comment, a stray instruction and a `.4byte`
 * line that must be ignored.
 */
const SNIPPET = `# decomp.me dump of CfGameManager.o
.globl func_8007C0F8__Q22cf13CfGameManagerFv
/* 8007CA80 00045CC0  4E 80 00 20 */	blr
.fn func_8007C0F8__Q22cf13CfGameManagerFv, global
/* 8007CA94 00045CD4  94 21 FF F0 */	stwu r1, -0x10(r1)
/* 8007CA98 00045CD8  38 60 00 05 */	li r3, 5 // ctor null check
/* 8007CA9C 00045CDC  80 83 00 10 */	lwz r4, 0x10(r3)
/* 8007CAA0 00045CE0  90 83 00 04 */	stw r4, 0x4(r3)
/* 8007CAA4 00045CE4  4B FF FF F5 */	bl func_8007C140__Q22cf13CfGameManagerFv
/* 8007CAA8 00045CE8  4E 80 00 20 */	blr
.endfn func_8007C0F8__Q22cf13CfGameManagerFv

.fn func_8007C140__Q22cf13CfGameManagerFv, global
/* 8007CACC 00045CF0  7C 63 18 38 */	and r3, r3, r3
/* 8007CAD0 00045CF4  48 00 00 04 */	b .L_8007CAD4
/* 8007CAD4 00045CF8  4B FF FF ED */	bl .L_8007CADC
	.4byte 0x00000000
/* 8007CAD8 00045CFC  4E 80 00 20 */	blr
.endfn func_8007C140__Q22cf13CfGameManagerFv

.fn func_8007CADC__Q22cf13CfGameManagerFv, global
/* 8007CADE 00045D00  4E 80 00 20 */	blr
`;

test("parseAsmFile extracts functions, names, and instruction fields", () => {
  const parsed = parseAsmFile(SNIPPET);
  assert.equal(parsed.functions.length, 3);
  assert.deepEqual(
    parsed.functions.map((f) => f.name),
    [
      "func_8007C0F8__Q22cf13CfGameManagerFv",
      "func_8007C140__Q22cf13CfGameManagerFv",
      "func_8007CADC__Q22cf13CfGameManagerFv",
    ],
  );
  // stray blr before the first .fn and the .4byte line are not instructions.
  assert.deepEqual(
    parsed.functions.map((f) => f.instructions.length),
    [6, 4, 1],
  );
});

test("parseAsmFile decodes address / bytes / mnemonic / operands per instruction", () => {
  const parsed = parseAsmFile(SNIPPET);
  const fn = parsed.functions[0]!;
  const first = fn.instructions[0]!;
  assert.deepEqual(first, {
    address: 0x8007CA94,
    bytes: "94 21 FF F0",
    mnemonic: "stwu",
    operands: "r1, -0x10(r1)",
  });
  const li = fn.instructions[1]!;
  assert.equal(li.address, 0x8007CA98);
  assert.equal(li.bytes, "38 60 00 05");
  assert.equal(li.mnemonic, "li");
  // trailing `//` comment is stripped, like member_check._parse_file
  assert.equal(li.operands, "r3, 5");
  const lwz = fn.instructions[2]!;
  assert.deepEqual({ mnemonic: lwz.mnemonic, operands: lwz.operands }, { mnemonic: "lwz", operands: "r4, 0x10(r3)" });
});

test("parseAsmFile ignores double-space annotations after the operands", () => {
  const parsed = parseAsmFile(
    `.fn func_a, global\n/* 80000000 00000000  38 60 00 05 */\tli r3, 5  /* 0x5 */\n.endfn func_a\n`,
  );
  assert.deepEqual(parsed.functions[0]!.instructions[0]!.operands, "r3, 5");
});

test("parseAsmFile closes an unterminated final function at EOF", () => {
  const parsed = parseAsmFile(
    `.fn func_a, global\n/* 80000000 00000000  4E 80 00 20 */\tblr\n`,
  );
  assert.equal(parsed.functions.length, 1);
  assert.equal(parsed.functions[0]!.name, "func_a");
  assert.equal(parsed.functions[0]!.instructions.length, 1);
});

test("buildCallGraph indexes bl targets per function", () => {
  const graph = buildCallGraph(parseAsmFile(SNIPPET));
  const caller = "func_8007C0F8__Q22cf13CfGameManagerFv";
  const target = "func_8007C140__Q22cf13CfGameManagerFv";
  assert.deepEqual(graph.callers[caller], [target]);
  assert.deepEqual(graph.callees[target], [caller]);
  // leaf function calls nobody; local `.L_` bl targets are not edges.
  assert.equal(graph.callers[target], undefined);
  assert.equal(blTarget(".L_8007CADC"), null);
  assert.equal(blTarget("@sda21(0)"), null);
  assert.equal(blTarget(""), null);
  assert.equal(blTarget("func_8007C140__Q22cf13CfGameManagerFv"), target);
});

test("readsR3 / writesR3 classify r3 usage", () => {
  // pure immediate write
  assert.equal(readsR3({ mnemonic: "li", operands: "r3, 5" }), false);
  assert.equal(writesR3({ mnemonic: "li", operands: "r3, 5" }), true);
  // read-modify-write
  assert.equal(readsR3({ mnemonic: "and", operands: "r3, r3, r3" }), true);
  assert.equal(writesR3({ mnemonic: "and", operands: "r3, r3, r3" }), true);
  // r3 as deref base (load: read only; store: READERS prefix)
  assert.equal(readsR3({ mnemonic: "lwz", operands: "r4, 0x10(r3)" }), true);
  assert.equal(writesR3({ mnemonic: "lwz", operands: "r4, 0x10(r3)" }), false);
  assert.equal(readsR3({ mnemonic: "stw", operands: "r4, 0x4(r3)" }), true);
  assert.equal(writesR3({ mnemonic: "stw", operands: "r4, 0x4(r3)" }), false);
  // r3 as source, destination elsewhere
  assert.equal(readsR3({ mnemonic: "addi", operands: "r4, r3, 8" }), true);
  assert.equal(writesR3({ mnemonic: "addi", operands: "r4, r3, 8" }), false);
  // indexed load: r3 is the destination, no read
  assert.equal(readsR3({ mnemonic: "lwzx", operands: "r3, r1, r4" }), false);
  assert.equal(writesR3({ mnemonic: "lwzx", operands: "r3, r1, r4" }), true);
  // compares / ctrl moves read r3
  assert.equal(readsR3({ mnemonic: "cmpwi", operands: "r3, 0x0" }), true);
  assert.equal(writesR3({ mnemonic: "cmpwi", operands: "r3, 0x0" }), false);
  assert.equal(readsR3({ mnemonic: "mtctr", operands: "r3" }), true);
  assert.equal(writesR3({ mnemonic: "mtctr", operands: "r3" }), false);
  // r31 is not r3; no r3 mention at all
  assert.equal(readsR3({ mnemonic: "stwu", operands: "r1, -0x10(r1)" }), false);
  assert.equal(writesR3({ mnemonic: "stwu", operands: "r1, -0x10(r1)" }), false);
  assert.equal(readsR3({ mnemonic: "mr", operands: "r3, r31" }), false);
  assert.equal(writesR3({ mnemonic: "mr", operands: "r3, r31" }), true);
  // READERS quirk kept for member_check parity: mfspr r3 never counts as a write
  assert.equal(readsR3({ mnemonic: "mfspr", operands: "r3, LR" }), true);
  assert.equal(writesR3({ mnemonic: "mfspr", operands: "r3, LR" }), false);
});

test("isIntegerOp uses the exact INTEGER_OPS set", () => {
  for (const mnemonic of ["and", "add", "sub", "rlwinm", "slwi", "srawi", "or", "xor", "neg"]) {
    assert.equal(isIntegerOp({ mnemonic, operands: "r3, r3, r4" }), true, mnemonic);
  }
  // addi is NOT in INTEGER_OPS (member_check treats it separately); neither are loads/stores
  assert.equal(isIntegerOp({ mnemonic: "addi", operands: "r3, r3, 8" }), false);
  assert.equal(isIntegerOp({ mnemonic: "lwz", operands: "r4, 0x10(r3)" }), false);
  assert.equal(isIntegerOp({ mnemonic: "cmpwi", operands: "r3, 0x0" }), false);
  assert.equal(isIntegerOp({ mnemonic: "stwu", operands: "r1, -0x10(r1)" }), false);
});

test("derefLoadOffset / derefStoreOffset extract r3-relative offsets", () => {
  // 0x10 and 0xA parse as hex (member_check uses int(..., 16))
  assert.equal(derefLoadOffset({ mnemonic: "lwz", operands: "r4, 0x10(r3)" }), 16);
  assert.equal(derefLoadOffset({ mnemonic: "lwz", operands: "r4, 0xA(r3)" }), 10);
  assert.equal(derefLoadOffset({ mnemonic: "lhz", operands: "r5, 0x2(r3)" }), 2);
  // FPR destinations never match the reference `r\d+` pattern (lfs/lfd quirk)
  assert.equal(derefLoadOffset({ mnemonic: "lfs", operands: "f1, 0x8(r3)" }), null);
  // base must be r3; negative offsets do not match (reference regex)
  assert.equal(derefLoadOffset({ mnemonic: "lwz", operands: "r4, 0x10(r4)" }), null);
  assert.equal(derefLoadOffset({ mnemonic: "lwz", operands: "r4, -0x4(r3)" }), null);
  assert.equal(derefLoadOffset({ mnemonic: "stw", operands: "r4, 0x4(r3)" }), null);

  assert.equal(derefStoreOffset({ mnemonic: "stw", operands: "r4, 0x4(r3)" }), 4);
  assert.equal(derefStoreOffset({ mnemonic: "stb", operands: "r0, 0x24(r3)" }), 0x24);
  assert.equal(derefStoreOffset({ mnemonic: "stw", operands: "r4, 0x4(r4)" }), null);
  assert.equal(derefStoreOffset({ mnemonic: "lwz", operands: "r4, 0x10(r3)" }), null);
  // FPR sources never match the reference `r\d+` pattern (stfs/stfd quirk)
  assert.equal(derefStoreOffset({ mnemonic: "stfs", operands: "f1, 0x8(r3)" }), null);
  assert.equal(derefStoreOffset({ mnemonic: "stfd", operands: "f1, 0x8(r3)" }), null);
});

test("passesConstInR3 returns the immediate passed in r3 (N1 evidence)", () => {
  assert.equal(passesConstInR3({ mnemonic: "li", operands: "r3, 5" }), 5);
  assert.equal(passesConstInR3({ mnemonic: "li", operands: "r3, 0x0" }), 0);
  assert.equal(passesConstInR3({ mnemonic: "li", operands: "r3, 0" }), 0); // decimal
  assert.equal(passesConstInR3({ mnemonic: "lis", operands: "r3, 0x8000" }), 0x8000);
  assert.equal(passesConstInR3({ mnemonic: "lis", operands: "r3, 0x8000@ha" }), 0x8000);
  // not r3, not an immediate, not li/lis
  assert.equal(passesConstInR3({ mnemonic: "li", operands: "r4, 5" }), null);
  assert.equal(passesConstInR3({ mnemonic: "li", operands: "r3, lbl_eu_80571658@l" }), null);
  assert.equal(passesConstInR3({ mnemonic: "mr", operands: "r3, r31" }), null);
  assert.equal(passesConstInR3({ mnemonic: "addi", operands: "r3, r3, 5" }), null);
  // signed immediates do not match (member_check._const_imm parity)
  assert.equal(passesConstInR3({ mnemonic: "li", operands: "r3, -0x1" }), null);
});

test("parseAsmFile drops instructions OUTSIDE .fn/.endfn (documented deviation, fix #10)", () => {
  // `member_check._parse_file` keeps every instruction line in the file,
  // whether or not it sits inside a function; this port only keeps
  // `.fn`-wrapped code (real dtk always wraps, so the deviation is
  // theoretical). Proven here: an instruction line before the first `.fn`,
  // between two functions, and after the last `.endfn` are all dropped.
  const dump = `/* 8007CA80 00045CC0  4E 80 00 20 */\tblr
.fn a, global
/* 8007CA84 00045CC4  4E 80 00 20 */\tblr
.endfn a
/* 8007CA88 00045CC8  4E 80 00 20 */\tblr
.fn b, global
/* 8007CA8C 00045CCC  4E 80 00 20 */\tblr
.endfn b
/* 8007CA90 00045CD0  4E 80 00 20 */\tblr
`;
  const parsed = parseAsmFile(dump);
  assert.deepEqual(
    parsed.functions.map((f) => [f.name, f.instructions.length]),
    [["a", 1], ["b", 1]],
  );
});
