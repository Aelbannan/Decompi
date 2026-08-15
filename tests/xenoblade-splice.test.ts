/**
 * Splice/candidate tests for the xenoblade workflow helpers (SPEC §3): the
 * function-span extractor, the candidate validator, and applyCandidate's
 * splice semantics (extern "C" preservation, verification-speak rejection).
 * Pure-string for the extractor/validator; applyCandidate uses a small
 * frozen fixture root (no live xenoblade checkout).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCandidate,
  extractFunctionSpan,
  validateCandidate,
  type FunctionWorkItem,
} from "../adapters/xenoblade/workflow.js";

const STUB_SRC = `// header
void other(int a) {
    return;
}

extern "C" void func_80291204(int unused, int unused2, int flag, u8 value) {
    if (lbl) return;
    func_8023F860((s8)1, (void*)func_80291204);
    lbl->mField121 = 0xB;
}

void tail(void) {}
`;

function item(symbol: string): FunctionWorkItem {
  return { id: `us-x`, kind: "function", unitId: "kyoshin/CSaveLoad", symbol, asmText: "" };
}

test("extractFunctionSpan locates the LAST definition (not call sites)", () => {
  const span = extractFunctionSpan(STUB_SRC, "func_80291204");
  assert.ok(span, "definition found");
  const text = STUB_SRC.slice(span!.start, span!.end);
  assert.match(text, /^extern "C" void func_80291204/);
  assert.match(text, /mField121 = 0xB;\s*}$/);
  assert.ok(!text.includes("other(int a)"), "does not include the preceding function");
});

test("extractFunctionSpan matches class-qualified members via the demangled stem", () => {
  const src = `bool ExternalSoundPlayer::detail_CanPlaySound(int count) {\n    return count > 0;\n}\n`;
  const span = extractFunctionSpan(src, "detail_CanPlaySound__Q44nw4r3snd6detail19ExternalSoundPlayerFi");
  assert.ok(span);
  assert.match(src.slice(span!.start, span!.end), /^bool ExternalSoundPlayer::detail_CanPlaySound/);
});

test("extractFunctionSpan handles multiline signatures", () => {
  const src = `void ReplaceImage__Q34nw4r3lyt6TexMapFP10TPLPaletteUl(\n    Rep* self, TPLPalette* p, u32 id) {\n    self->img = p;\n}\n`;
  const span = extractFunctionSpan(src, "ReplaceImage__Q34nw4r3lyt6TexMapFP10TPLPaletteUl");
  assert.ok(span);
  assert.match(src.slice(span!.start, span!.end), /^void ReplaceImage__/);
});

test("extractFunctionSpan returns null when the symbol is only called", () => {
  const src = `void f(void) { g((void*)func_80291204); }\n`;
  assert.equal(extractFunctionSpan(src, "func_80291204"), null);
});

test("validateCandidate rejects verification-speak garbage", () => {
  assert.throws(
    () => validateCandidate(`extern "C" PASS &#8212; func_80291204 matches retail exactly (0xd0/0xd0 bytes).`, "func_80291204"),
    /verification output/,
  );
  assert.throws(
    () => validateCandidate(`PASS\nvoid func_80291204(void) {}`, "func_80291204"),
    /verification output/,
  );
});

test("validateCandidate rejects non-definitions and accepts real ones", () => {
  assert.throws(() => validateCandidate(`func_80291204();`, "func_80291204"), /no function body/);
  assert.throws(() => validateCandidate(`void other(void) { }`, "func_80291204"), /does not name/);
  assert.throws(() => validateCandidate(`void func_80291204(void) { if (x) { }`, "func_80291204"), /unbalanced/);
  assert.equal(
    validateCandidate("```c\nextern \"C\" void func_80291204(int a, int b, u8 c) {\n    return;\n}\n```", "func_80291204"),
    'extern "C" void func_80291204(int a, int b, u8 c) {\n    return;\n}',
  );
});

test("applyCandidate splices and preserves extern \"C\"", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-splice-"));
  const root = join(dir, "repo");
  mkdirSync(join(root, "src", "kyoshin"), { recursive: true });
  mkdirSync(join(root, ".venv", "bin"), { recursive: true });
  mkdirSync(join(root, "tools", "coop"), { recursive: true });
  writeFileSync(join(root, ".venv", "bin", "python3"), "");
  for (const f of ["hexdiff.py", "batch-cycle.py"]) {
    writeFileSync(join(root, "tools", "coop", f), "");
  }
  writeFileSync(join(root, "tools", "struct_layout.py"), "");
  const srcPath = join(root, "src", "kyoshin", "CSaveLoad.cpp");
  writeFileSync(srcPath, STUB_SRC);
  const target = {
    ...item("func_80291204"),
    source: "src/kyoshin/CSaveLoad.cpp",
  };
  const oldEnv = process.env.DECOMPI_XENOBLADE_ROOT;
  process.env.DECOMPI_XENOBLADE_ROOT = root;
  try {
    const updated = await applyCandidate(
      target,
      'void func_80291204(int a, int b, int c, u8 v) {\n    if (!lbl) return;\n    lbl->mField121 = 0xB;\n}\n',
    );
    assert.match(updated, /extern "C" void func_80291204\(int a, int b, int c, u8 v\)/);
    assert.ok(!updated.includes("func_8023F860"), "call-site line replaced");
    assert.match(updated, /void tail\(void\) \{\}\s*$/, "tail function preserved");
  } finally {
    if (oldEnv === undefined) delete process.env.DECOMPI_XENOBLADE_ROOT;
    else process.env.DECOMPI_XENOBLADE_ROOT = oldEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});
