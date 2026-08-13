/**
 * M1b tests for the extern "C" classifier + member-conversion planner
 * (`src/parse/symbols/extc.ts`): port of `tools/coop/extc.py` (`scan` /
 * `plan`) against a synthetic retail table. Covers the two INDEPENDENT axes —
 * the name-based category (exact / drift / invented / jp_stale / unparsed)
 * and the member-candidate hint (`'__' in name` OR self-style first param,
 * regardless of category) — plus the source-scan hit list for
 * `planMemberConversion` (self-cast defs / typed-self defs / declarations).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSymbols } from "../src/parse/symbols/table.js";
import {
  classifyExternC,
  planMemberConversion,
  scanExternC,
  mangleMember,
  mangleCtor,
  mangleDtor,
  memberRenameTarget,
} from "../src/parse/symbols/extc.js";

const TABLE_TEXT = `# synthetic retail table (config/us/symbols.txt format)
__ct__5CGameFv = .text:0x80004000; // type:function
__dt__5CGameFv = .text:0x80004100; // type:function
Init__5CGameFv = .text:0x80004200; // type:function
OnFrame__5CGameFv = .text:0x80004300; // type:function
lbl_80004200 = .text:0x80007000; // type:label
__ct__CExchangeWin = .text:0x8022ED68; // type:function (sloppy JP name)
__dt__12CExchangeWinFv = .text:0x8022EDD0; // type:function
getField25__12CExchangeWinFv = .text:0x8022EF84; // type:function
OnFileEvent__12CExchangeWinFP10CEventFile = .text:0x8022F18C; // type:function
func_80047814__Q22cf13CfObjectPointFv = .text:0x80047DFC; // type:function
func_8006EF04__Q22cf13CfObjectPointFv = .text:0x8006EF04; // type:function
// the classic func_X / lbl_X alias at ONE address (must never fire jp-stale)
func_80137038 = .text:0x80137038; // type:function
lbl_80137038 = .text:0x80137038; // type:label
`;

const table = loadSymbols(TABLE_TEXT);

test("classifyExternC: retail-exact name", () => {
  const r = classifyExternC({ name: "__ct__5CGameFv", returnType: "void", params: [], line: 10 }, table);
  assert.equal(r.category.category, "exact");
  if (r.category.category === "exact") {
    assert.equal(r.category.address, 0x80004000);
    assert.match(r.category.reason, /retail symbol at 0x80004000/);
  }
});

test("classifyExternC: memberCandidateHint is INDEPENDENT of category (mangled exact name)", () => {
  const r = classifyExternC({ name: "__dt__12CExchangeWinFv", params: [], line: 3 }, table);
  assert.equal(r.category.category, "exact");
  // `'__' in name` → hint true even though the category is exact (extc.py
  // appends to member_candidates for EVERY declaration, regardless of class)
  assert.equal(r.memberCandidateHint, true);
});

test("classifyExternC: hint via self-style first param even when the name is invented", () => {
  const r = classifyExternC({ name: "CGame_DoThing", params: ["void* self"], line: 30 }, table);
  assert.equal(r.category.category, "invented");
  assert.equal(r.memberCandidateHint, true);
});

test("classifyExternC: no hint without '__' or a self-style param", () => {
  const r = classifyExternC({ name: "CGame_DoThing", params: ["int x"], line: 31 }, table);
  assert.equal(r.category.category, "invented");
  assert.equal(r.memberCandidateHint, false);
});

test("classifyExternC: drift via embedded stale address", () => {
  const r = classifyExternC({ name: "func_8006EF04", returnType: "void", params: [], line: 20 }, table);
  assert.equal(r.category.category, "drift");
  if (r.category.category === "drift") {
    assert.equal(r.category.resolved, "func_8006EF04__Q22cf13CfObjectPointFv");
    assert.match(r.category.reason, /embedded address 0x8006ef04 is retail symbol func_8006EF04__Q22cf13CfObjectPointFv/);
  }
});

test("classifyExternC: drift via retail name extending the declared name", () => {
  const r = classifyExternC({ name: "func_80047814", params: [], line: 21 }, table);
  assert.equal(r.category.category, "drift");
  if (r.category.category === "drift") {
    assert.equal(r.category.resolved, "func_80047814__Q22cf13CfObjectPointFv");
    assert.match(r.category.reason, /extends the declared name/);
  }
});

test("classifyExternC: drift via JP-region suffix on the declared name", () => {
  const r = classifyExternC({ name: "OnFrame__5CGameFv_jp", params: [], line: 22 }, table);
  assert.equal(r.category.category, "drift");
  if (r.category.category === "drift") {
    assert.equal(r.category.resolved, "OnFrame__5CGameFv");
    assert.match(r.category.reason, /adds region\/JP suffix '_jp' to retail symbol OnFrame__5CGameFv/);
  }
});

test("classifyExternC: drift via shared mangled qualifier tail", () => {
  const r = classifyExternC({ name: "func_80000000__5CGameFv", params: [], line: 23 }, table);
  assert.equal(r.category.category, "drift");
  if (r.category.category === "drift") {
    assert.equal(r.category.resolved, "__ct__5CGameFv");
    assert.match(r.category.reason, /mangled qualifier tail '5CGameFv'/);
  }
});

test("classifyExternC: invented name", () => {
  const r = classifyExternC({ name: "CGame_DoThing", params: [], line: 30 }, table);
  assert.equal(r.category.category, "invented");
  if (r.category.category === "invented") {
    assert.equal(r.category.name, "CGame_DoThing");
    assert.match(r.category.reason, /no retail symbol/);
  }
});

test("classifyExternC: invented name that only looks mangled", () => {
  const r = classifyExternC({ name: "OnFileEvent__99CGameFv", params: [], line: 31 }, table);
  assert.equal(r.category.category, "invented");
  assert.equal(r.memberCandidateHint, true); // '__' in name → candidate hint
});

test("classifyExternC: void* self is a member-candidate hint (no table membership needed)", () => {
  // Foo is NOT a table class — the hint still fires (fix: drop the
  // table-membership requirement from the hint axis)
  const r = classifyExternC({ name: "Foo_DoThing", params: ["Foo* self"], line: 42 }, table);
  assert.equal(r.category.category, "invented");
  assert.equal(r.memberCandidateHint, true);
});

test("classifyExternC: jp-stale address (name retail, embedded address now another symbol)", () => {
  const r = classifyExternC({ name: "lbl_80004200", params: [], line: 50 }, table);
  assert.equal(r.category.category, "jp_stale");
  if (r.category.category === "jp_stale") {
    assert.equal(r.category.address, 0x80007000);
    assert.equal(r.category.staleAddress, 0x80004200);
    assert.equal(r.category.resolved, "Init__5CGameFv");
    assert.match(r.category.reason, /stale JP layout/);
  }
});

test("classifyExternC: aliased func_X/lbl_X at one address does NOT fire jp-stale (fix #1 regression)", () => {
  // 0x80137038 is occupied by BOTH func_80137038 and lbl_80137038; a declared
  // name that IS among the occupants must classify exact, not jp_stale
  // (Python's `any(rn == name)` guard).
  const r = classifyExternC({ name: "func_80137038", params: [], line: 51 }, table);
  assert.equal(r.category.category, "exact");
  const l = classifyExternC({ name: "lbl_80137038", params: [], line: 52 }, table);
  assert.equal(l.category.category, "exact");
});

test("classifyExternC: unparsed when no name could be extracted", () => {
  const r = classifyExternC({ name: "", params: [], line: 60 }, table);
  assert.equal(r.category.category, "unparsed");
});

test("classifyExternC: unparsed is reachable via the scanner front-end", () => {
  // an extern "C" line whose body has no recoverable name; note the decl
  // must NOT directly follow a def/`{ }` line (the reference scanner's
  // continuation scan consumes the first col-0 line after one — parity quirk)
  const scanned = scanExternC(
    [
      {
        path: "src/kyoshin/weird.cpp",
        text: 'extern "C" void __dt__5CGameFv(void* self);\nextern "C" { }\nextern "C" __attribute__((x)) ;\nextern "C" __attribute__((y)) ;\n',
      },
    ],
    table,
  );
  const unparsed = scanned.filter((s) => s.classification.category.category === "unparsed");
  assert.ok(unparsed.length >= 1, "scanner front-end must feed classifyExternC so unparsed is reachable");
  const dt = scanned.find((s) => s.entry.name === "__dt__5CGameFv");
  assert.equal(dt?.classification.category.category, "exact");
  assert.equal(dt?.classification.memberCandidateHint, true); // '__' in name
});

test("scanExternC: extern \"C\" block bodies are extracted", () => {
  const src = {
    path: "src/kyoshin/block.cpp",
    text: [
      'extern "C" {',
      "  void blockFunc1(void* self);",
      "  void blockFunc2(void);",
      "}",
    ].join("\n"),
  };
  const scanned = scanExternC([src], table);
  assert.deepEqual(
    scanned.map((s) => s.entry.name),
    ["blockFunc1", "blockFunc2"],
  );
});

test("planMemberConversion: unscoped class (CGame) rename targets + ceremony", () => {
  const plan = planMemberConversion("CGame", table);
  assert.equal(plan.className, "CGame");
  assert.deepEqual(plan.namespacePath, []);
  assert.equal(plan.ctorTarget, "__ct__5CGameFv");
  assert.equal(plan.dtorTarget, "__dt__5CGameFv");
  assert.equal(plan.methodTargetTemplate, "<member>__5CGameFv");
  assert.deepEqual(
    plan.existingMembers.map((m) => m.name),
    ["Init__5CGameFv", "OnFrame__5CGameFv", "__ct__5CGameFv", "__dt__5CGameFv"],
  );
  for (const m of plan.existingMembers) {
    assert.equal(m.canonicalTarget, null, `${m.name} should already be canonical`);
  }
  assert.deepEqual(
    plan.ceremony.map((s) => s.step),
    ["rename-decl", "rename-def", "fix-call-sites", "update-symbols"],
  );
});

test("planMemberConversion: class with a sloppy JP ctor entry (CExchangeWin)", () => {
  const plan = planMemberConversion("CExchangeWin", table);
  assert.equal(plan.ctorTarget, "__ct__12CExchangeWinFv");
  const names = plan.existingMembers.map((m) => m.name);
  assert.ok(names.includes("__ct__CExchangeWin"));
  assert.ok(names.includes("getField25__12CExchangeWinFv"));
  assert.ok(names.includes("OnFileEvent__12CExchangeWinFP10CEventFile"));

  const sloppy = plan.existingMembers.find((m) => m.name === "__ct__CExchangeWin");
  assert.equal(sloppy?.canonicalTarget, "__ct__12CExchangeWinFv");

  const update = plan.ceremony.find((s) => s.step === "update-symbols");
  assert.ok(update?.instruction.includes("__ct__CExchangeWin -> __ct__12CExchangeWinFv"));
});

test("planMemberConversion: scoped class (cf::CfObjectPoint) uses __Q mangling", () => {
  const plan = planMemberConversion("CfObjectPoint", table);
  assert.deepEqual(plan.namespacePath, ["cf", "CfObjectPoint"]);
  assert.equal(plan.ctorTarget, "__ct__Q22cf13CfObjectPointFv");
  assert.equal(plan.dtorTarget, "__dt__Q22cf13CfObjectPointFv");
  assert.equal(plan.methodTargetTemplate, "<member>__Q22cf13CfObjectPointFv");
  assert.deepEqual(
    plan.existingMembers.map((m) => m.name),
    ["func_80047814__Q22cf13CfObjectPointFv", "func_8006EF04__Q22cf13CfObjectPointFv"],
  );
});

test("planMemberConversion: source-scan finds defs (typed-self param) + decls + targets", () => {
  const src = {
    path: "src/kyoshin/CExchangeWin.cpp",
    text: [
      'extern "C" void OnFileEvent__12CExchangeWinFP10CEventFile(void* self);',
      'extern "C" CExchangeWin* __ct__CExchangeWin(CExchangeWin* self) { return self; }',
      'extern "C" void func_8022D0A4(CExchangeWin* self) { (void)self; }',
      "// a def with a self-CAST body (def-selfcast)",
      'extern "C" void func_8022CF2C(CExchangeWin* self) { ((CExchangeWin*)self)->field_25 = 0; }',
      "void caller1(void) { func_8022D0A4(0); }",
      "void caller2(void) { func_8022CF2C(0); }",
    ].join("\n"),
  };
  const plan = planMemberConversion("CExchangeWin", table, [src]);
  assert.deepEqual(
    plan.hits.map((h) => `${h.kind}@${h.line}:${h.name}`),
    [
      "decl@1:OnFileEvent__12CExchangeWinFP10CEventFile",
      "def-param@2:__ct__CExchangeWin",
      "def-param@3:func_8022D0A4",
      "def-selfcast@5:func_8022CF2C",
    ],
  );
  // call sites: source lines that mention a def name, excluding the def lines
  assert.deepEqual(
    plan.callSites.map((c) => `${c.name}@${c.line}`),
    ["func_8022D0A4@6", "func_8022CF2C@7"],
  );
  assert.ok(plan.ceremony.find((s) => s.step === "fix-call-sites")!.instruction.includes("2 source call site(s)"));
  // per-hit targets: Python-parity naive mangling + canonical (ct-aware)
  const ctor = plan.targets.find((t) => t.name === "__ct__CExchangeWin");
  assert.equal(ctor?.mangled, "__ct__CExchangeWin__12CExchangeWinFv"); // Python member_mangled verbatim
  assert.equal(ctor?.canonical, "__ct__12CExchangeWinFv"); // canonical MWCC (documented deviation)
  const f = plan.targets.find((t) => t.name === "func_8022D0A4");
  assert.equal(f?.mangled, "func_8022D0A4__12CExchangeWinFv");
  assert.equal(f?.canonical, "func_8022D0A4__12CExchangeWinFv");
  // retailSymbols = every retail name containing the token (Python class_syms)
  assert.deepEqual(plan.retailSymbols, [
    "OnFileEvent__12CExchangeWinFP10CEventFile",
    "__ct__CExchangeWin",
    "__dt__12CExchangeWinFv",
    "getField25__12CExchangeWinFv",
  ]);
});

test("mangle helpers: MWCC member-mangling forms", () => {
  assert.equal(mangleCtor("CGame"), "__ct__5CGameFv");
  assert.equal(mangleDtor("CGame"), "__dt__5CGameFv");
  assert.equal(mangleMember("CGame", "OnFrame"), "OnFrame__5CGameFv");
  assert.equal(mangleMember("CExchangeWin", "OnFileEvent", "P10CEventFile"), "OnFileEvent__12CExchangeWinFP10CEventFile");
  assert.equal(mangleCtor("CfObjectPoint", "v", ["cf", "CfObjectPoint"]), "__ct__Q22cf13CfObjectPointFv");
  assert.equal(mangleMember("MTRand", "getInstance", "v", ["ml", "MTRand"]), "getInstance__Q22ml6MTRandFv");
});

test("memberRenameTarget: ctor / dtor / method dispatch", () => {
  assert.equal(memberRenameTarget("CGame", "CGame"), "__ct__5CGameFv");
  assert.equal(memberRenameTarget("CGame", "~CGame"), "__dt__5CGameFv");
  assert.equal(memberRenameTarget("CGame", "OnFrame"), "OnFrame__5CGameFv");
  assert.equal(
    memberRenameTarget("CfObjectPoint", "foo", "v", ["cf", "CfObjectPoint"]),
    "foo__Q22cf13CfObjectPointFv",
  );
});

test("classifyExternC: same table reused for classification then planning", () => {
  // the class index is cached per table; ensure repeated calls stay consistent
  const a = classifyExternC({ name: "CGame_OnFrame", params: ["void* self"], line: 70 }, table);
  const b = classifyExternC({ name: "CGame_OnFrame", params: ["void* self"], line: 71 }, table);
  assert.deepEqual(a, b);
  assert.equal(a.category.category, "invented");
  assert.equal(a.memberCandidateHint, true);
  const plan = planMemberConversion("CGame", table);
  assert.equal(plan.ctorTarget, "__ct__5CGameFv");
});
