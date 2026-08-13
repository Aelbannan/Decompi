#!/usr/bin/env node
/**
 * M1a golden-corpus parity harness (SPEC §13.4).
 *
 * Measures how closely the TS source rules (src/parse/cpp: `lintFile` +
 * `lintDelta`) reproduce the reference Python tools on real Xenoblade source:
 *
 *   - tools/coop/detect_pointer_arithmetic.py  6 pointer-arithmetic categories
 *   - tools/coop/smell_scan.py                 21 smell-scan families (+ CLI table)
 *   - tools/pi_harness/lint.py                 delta-lint gate (lint_delta)
 *
 * Per SPEC §13.4, parity is DEFINED as golden-corpus comparison with a
 * documented deviation list — NOT count-identical output. This script
 * produces the counts and writes the deviation report to docs/m1a-parity.md.
 *
 * For each corpus file it runs, on the same source text:
 *   1. TS whole-file scan  : lintFile(path, code)
 *   2. TS all-lines-added  : lintDelta(path, null, code)   (approximates lint.py
 *      with old_text=None, which marks every line as added)
 *   3. Python pointer scan : detect_pointer_arithmetic.py --dirs … (real CLI,
 *      JSON output; per-file category counts extracted from `findings`)
 *   4. Python smell scan   : smell_scan.py <file…> (real CLI; markdown table
 *      rows parsed) PLUS a shim importing `scan_file` for the full per-family
 *      breakdown the table projection does not expose
 *   5. Python delta lint   : lint.py `lint_delta(path, None, code)` via a
 *      python -c shim
 *
 * Usage:
 *   npx tsx scripts/parity.ts             # run the hardcoded 25-file corpus
 *   npx tsx scripts/parity.ts FILE…       # override the corpus (positional)
 *
 * Reproducibility: the default corpus is hardcoded below as absolute paths;
 * the reference tools are pinned to the Xenoblade repo venv python.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lintDelta, lintFile } from "../src/parse/cpp/registry.js";
import type { Finding } from "../src/parse/cpp/types.js";

/* ------------------------------------------------------------------ *
 * Configuration — pinned, reproducible
 * ------------------------------------------------------------------ */

/** Xenoblade co-op fork repo root (reference tools + corpus live here). */
const XENOBLADE_ROOT = "/Users/ahmedelbannan/Ahmed/xenoblade";

/** Reference Python interpreter (project venv; Python 3.13.6). */
const PYTHON = join(XENOBLADE_ROOT, ".venv", "bin", "python3");

/** Directories scanned by the real detect_pointer_arithmetic.py CLI run. */
const POINTER_DIRS = ["src/kyoshin", "libs/monolib/src", "libs/nw4r/src"];

/** Corpus entry: absolute source path + why it was picked. */
interface CorpusEntry {
  path: string;
  why: string;
}

/**
 * Hardcoded golden corpus — 25 TUs (15 src/kyoshin, 5 libs/monolib/src,
 * 5 libs/nw4r/src), chosen for breadth across the smell families the rules
 * track (self-params, void*, ptr/deref arith, extern "C", asm, fake stack,
 * pragmas, gotos) and for size spread (2 KB … 178 KB).
 */
const CORPUS: CorpusEntry[] = [
  // ---- src/kyoshin (game code; heavy decomp-generated smells) ----
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CBattery.cpp"), why: "near-clean TU (void* only)" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CCur.cpp"), why: 'extern "C" def-heavy block' },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CFade.cpp"), why: "sparse mixed smells + cast ptr arithmetic" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CCol6System.cpp"), why: "self-param / self-> access" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CEquipChange.cpp"), why: "self + ptr_arith + pragma mix" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CMiniMap.cpp"), why: "lbl extern C + heavy ptr/deref arith" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/COption.cpp"), why: "self-heavy + pragma directives" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CTaskGame.cpp"), why: "self / rn_params / goto / pragma" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CItemBoxGrid.cpp"), why: "largest TU; stress case (all families)" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CSaveLoad.cpp"), why: "self + void*/cast + ptr arith" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CErrMes.cpp"), why: "cast-heavy + lbl extern C" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CFloorMap.cpp"), why: "deref_arith-heavy" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/code_80135FDC.cpp"), why: 'extern "C" other-kind + labels' },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CSortMenu.cpp"), why: "fake_stack (volatile byte array)" },
  { path: join(XENOBLADE_ROOT, "src/kyoshin/CUIBattleManager.cpp"), why: "asm shim + goto-heavy" },
  // ---- libs/monolib/src ----
  { path: join(XENOBLADE_ROOT, "libs/monolib/src/core/CView.cpp"), why: "goto / #if 0-heavy + asm + rN params" },
  { path: join(XENOBLADE_ROOT, "libs/monolib/src/effect/code_804C8718.cpp"), why: "self-heavy library TU" },
  { path: join(XENOBLADE_ROOT, "libs/monolib/src/scn/CScn_80496B0C.cpp"), why: 'large extern "C" block' },
  { path: join(XENOBLADE_ROOT, "libs/monolib/src/device/CDeviceFileDvd.cpp"), why: "ptr arith, no extern C" },
  { path: join(XENOBLADE_ROOT, "libs/monolib/src/scn/CScnEnvLgtCtrl.cpp"), why: "deref / ptr arith" },
  // ---- libs/nw4r/src ----
  { path: join(XENOBLADE_ROOT, "libs/nw4r/src/math/math_types.cpp"), why: "paired-single asm kernels (asm_code)" },
  { path: join(XENOBLADE_ROOT, "libs/nw4r/src/snd/snd_VoiceManager.cpp"), why: "reinterpret_cast byte stepping" },
  { path: join(XENOBLADE_ROOT, "libs/nw4r/src/ut/ut_PackedFont.cpp"), why: "subscript on cast" },
  { path: join(XENOBLADE_ROOT, "libs/nw4r/src/ut/ut_ArchiveFontBase.cpp"), why: "reinterpret + int-cast arith" },
  { path: join(XENOBLADE_ROOT, "libs/nw4r/src/g3d/g3d_draw1mat1shp.cpp"), why: "byte-cast offset deref" },
];

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** Per-file result bag: every count the comparison needs. */
interface FileResult {
  path: string;
  lines: number;
  /** lintFile findings grouped by rule id. */
  tsWhole: Record<string, number>;
  /** smell.extern_c findings split by kind=lbl|nonlbl-decl|nonlbl-def|other. */
  tsExternKinds: Record<string, number>;
  /** lintDelta(path, null, code) findings grouped by rule id. */
  tsDelta: Record<string, number>;
  /** detect_pointer_arithmetic category counts for this file. */
  pyPointer: Record<string, number>;
  /** smell_scan.py scan_file() full-family counts. */
  pySmell: Record<string, number>;
  /** smell_scan.py CLI markdown-table row (null when no row was printed). */
  pySmellCli: Record<string, number> | null;
  /** lint.py lint_delta() violations grouped by rule id. */
  pyLint: Record<string, number>;
}

/** One compared family: the TS rule key and the Python family key. */
interface FamilyDef {
  py: string;
  ts: string;
}

/** Aggregated comparison row for one family across the corpus. */
interface RuleRow {
  rule: string;
  tsTotal: number;
  pyTotal: number;
  matchedFiles: number;
  totalFiles: number;
  /** Sum over files of |TS − PY| — the honest divergence magnitude. */
  absDev: number;
  note: string;
}

/* ------------------------------------------------------------------ *
 * Python runner
 * ------------------------------------------------------------------ */

function runPython(args: string[], what: string): string {
  const res = spawnSync(PYTHON, args, {
    cwd: XENOBLADE_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error !== undefined) {
    throw new Error(`failed to spawn ${PYTHON} for ${what}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const err = (res.stderr ?? "").slice(0, 4000);
    throw new Error(`python ${what} exited ${res.status}\n${err}`);
  }
  return res.stdout ?? "";
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Count findings by rule id. */
function countByRule(findings: Finding[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const f of findings) m.set(f.rule, (m.get(f.rule) ?? 0) + 1);
  return Object.fromEntries(m);
}

/** Split smell.extern_c findings by the kind=… tag in their message. */
function externKindCounts(findings: Finding[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const f of findings) {
    if (f.rule !== "smell.extern_c") continue;
    const k = /kind=(lbl|nonlbl-decl|nonlbl-def|other)/.exec(f.message)?.[1];
    if (k === undefined) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Object.fromEntries(m);
}

/** Corpus-file path relative to the Xenoblade repo root. */
const relOf = (abs: string): string => abs.slice(XENOBLADE_ROOT.length + 1);

/**
 * Look up the TS count for a comparison key ("smell.extern_c" or
 * "smell.extern_c#kind"). The extern_c kind split always comes from the
 * whole-file scan; every other key reads from the group's own count map
 * (tsWhole for smell/pointer, tsDelta for the delta gate).
 */
function tsCount(r: FileResult, key: string, group: Record<string, number>): number {
  const kindPrefix = "smell.extern_c#";
  if (key.startsWith(kindPrefix)) {
    return r.tsExternKinds[key.slice(kindPrefix.length)] ?? 0;
  }
  return group[key] ?? 0;
}

/* ------------------------------------------------------------------ *
 * Family registries (Python family ↔ TS rule id)
 * ------------------------------------------------------------------ */

/** The 21 smell_scan.py families with a TS counterpart. */
const SMELL_FAMILIES: FamilyDef[] = [
  { py: "extern_c_total", ts: "smell.extern_c" },
  { py: "extern_c_lbl", ts: "smell.extern_c#lbl" },
  { py: "extern_c_nonlbl_decl", ts: "smell.extern_c#nonlbl-decl" },
  { py: "extern_c_nonlbl_def", ts: "smell.extern_c#nonlbl-def" },
  { py: "extern_c_other", ts: "smell.extern_c#other" },
  { py: "self_params", ts: "smell.self_param" },
  { py: "self_access", ts: "smell.self_access" },
  { py: "void_ptr", ts: "smell.void_ptr" },
  { py: "void_ptr_cast", ts: "smell.void_ptr_cast" },
  { py: "ptr_arith", ts: "smell.ptr_arith" },
  { py: "deref_arith", ts: "smell.deref_arith" },
  { py: "asm_code", ts: "smell.asm_code" },
  { py: "fake_stack", ts: "smell.fake_stack" },
  { py: "rn_params", ts: "smell.rn_params" },
  { py: "goto_count", ts: "smell.goto_count" },
  { py: "decomp_macro", ts: "smell.decomp_macro" },
  { py: "pragma", ts: "smell.pragma" },
  { py: "asm_insn_shim", ts: "smell.asm_insn_shim" },
  { py: "schedule_pragma", ts: "smell.schedule_pragma" },
  { py: "init_side_effect", ts: "smell.init_side_effect" },
  { py: "if0", ts: "smell.if0" },
];

/** smell_scan.py family with NO TS counterpart (informational only). */
const SMELL_INCLUDES = "includes";

/** TS smell rules with no Python equivalent (SPEC §13.1 additions). */
const TS_ONLY_SMELL = [
  "smell.class_in_cpp",
  "smell.struct_in_cpp",
  "smell.fake_array_access",
  "smell.vtable_wrapper",
];

/** detect_pointer_arithmetic.py categories ↔ TS pointer rules (1:1). */
const POINTER_FAMILIES: FamilyDef[] = [
  { py: "cast_byte_offset_deref", ts: "ptr.cast_byte_offset_deref" },
  { py: "cast_byte_ptr_arith", ts: "ptr.cast_byte_ptr_arith" },
  { py: "cast_int_arith", ts: "ptr.cast_int_arith" },
  { py: "subscript_on_cast", ts: "ptr.subscript_on_cast" },
  { py: "ptr_offset_deref", ts: "ptr.ptr_offset_deref" },
  { py: "reinterpret_arith", ts: "ptr.reinterpret_arith" },
];

/** lint.py rule ids (both duplicate-id checks collapse into one row). */
const DELTA_RULES = [
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
];

/* ------------------------------------------------------------------ *
 * Comparison
 * ------------------------------------------------------------------ */

interface CompareInput {
  results: FileResult[];
  /** TS counts for the group being compared (whole-file or delta gate). */
  tsLookup: (r: FileResult) => Record<string, number>;
  pyLookup: (r: FileResult) => Record<string, number>;
}

function compareFamily(fam: FamilyDef, input: CompareInput, note: string): RuleRow {
  let tsTotal = 0;
  let pyTotal = 0;
  let matchedFiles = 0;
  let absDev = 0;
  for (const r of input.results) {
    const t = tsCount(r, fam.ts, input.tsLookup(r));
    const p = input.pyLookup(r)[fam.py] ?? 0;
    tsTotal += t;
    pyTotal += p;
    absDev += Math.abs(t - p);
    if (t === p) matchedFiles++;
  }
  return {
    rule: fam.ts,
    tsTotal,
    pyTotal,
    matchedFiles,
    totalFiles: input.results.length,
    absDev,
    note,
  };
}

/** "match" | "match Σ (cells differ)" | "divergence". */
function statusOf(row: RuleRow): string {
  if (row.tsTotal === row.pyTotal && row.matchedFiles === row.totalFiles) return "match";
  if (row.tsTotal === row.pyTotal) return "match (Σ)";
  return "divergence";
}

/* ------------------------------------------------------------------ *
 * Report rendering
 * ------------------------------------------------------------------ */

function mdTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const fmt = (cells: string[]): string =>
    "| " + cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ") + " |";
  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  return [fmt(headers), sep, ...rows.map(fmt)].join("\n");
}

/** Root-cause notes for the top divergences, keyed by TS rule id. */
const ROOT_CAUSE: Record<string, string> = {
  "smell.extern_c":
    "Python counts LINES inside extern \"C\" blocks: the `extern \"C\" {` line, every body line " +
    "(multi-line function bodies inflate extern_c_total), def only on the line with `{`, closing `}` " +
    "line dropped. The CST emits one finding per top-level declaration/definition and classifies it " +
    "by shape (lbl / nonlbl-decl / nonlbl-def / other) — the registry documents this as a deliberate " +
    "semantic change (per-declaration, not per-line). Measured: CScn_80496B0C.cpp 21 declarations vs " +
    "207 Python lines; CCur.cpp (all single-line decls) matches 46 = 46.",
  "smell.extern_c#other":
    "Python's `other` bucket counts EVERY non-lbl, non-`(` line inside an extern \"C\" block — including " +
    "BLANK lines and comment lines (CScn_80496B0C.cpp: 134 other lines, 18 blank + 28 comment). The " +
    "CST classifies one finding per actual declaration that has no function declarator (TS 6 vs " +
    "Python 196 across the corpus).",
  "smell.self_param":
    "Python's `^`-anchored RE_PARAM_BY_NAME matches ANY line whose leading text (before the first " +
    "`;`/`{`/`}`) contains `self` followed by `)` or `,` — that includes CALL SITES " +
    "(`func(self)`, `f(self, x)`, `reinterpret_cast<T*>(self)`), which inflate the Python count " +
    "(CEquipChange.cpp: 107 Python vs 42 TS; 65 missing TS lines are all calls). The regex also " +
    "folds rN names into self_params (overlapping rn_params). The CST counts only real " +
    "`parameter_declaration` nodes named `self`, in any function (including lambdas and " +
    "function-pointer typedefs the anchored regex misses).",
  "smell.self_access":
    "Python's unanchored `\\bself\\s*->` counts the LINE once (comment-stripped); the CST emits one " +
    "finding per `self->` field_expression node, so lines with multiple `self->` accesses count " +
    "multiple times (TS 1648 vs Python 1507).",
  "smell.void_ptr":
    "Python's `\\bvoid\\s*\\*\\s*\\w+` counts one per LINE and misses `void** p`; the CST counts one per " +
    "named declarator (`void *p, *q;` yields two) and covers `void**` and multi-line declarators.",
  "smell.void_ptr_cast":
    "Python's `\\(\\s*void\\s*\\*\\s*\\)` counts one per line and cannot match `(void**)` (the regex " +
    "needs `void*` immediately followed by `)`); the CST counts C-style cast_expression nodes to " +
    "`void*`, covering `(void**)` and multi-line casts — TS 828 vs Python 485.",
  "smell.ptr_arith":
    "Python regexes fire on `+ <digits><terminator>` only (`+`-only, requires a numeric terminator) " +
    "and also match `N + (char*)p` layouts; the CST requires a scalar-base pointer cast (RE_CAST set) " +
    "as the LEFT operand of a `+`/`-` binary with an integer/hex literal on the right (Form A) or as " +
    "a cast of such a binary (Form B), fires for `-` offsets Python never sees, and suppresses " +
    "intra-rule overlap. Net: TS 1061 vs Python 1003 — close, offset by different constructs.",
  "smell.deref_arith":
    "Python's RE_DEREF_ARITH requires an INNER scalar cast with an enumerated " +
    "scalar base (char/u8/u16/u32/u64/int/s8/s16/s32/s64/float/double, with or " +
    "without a trailing `*`) and a `+` — `*(int*)(p + 4)` never fires, and " +
    "`*(int*)(get() + 4)` cannot fire because `[^)]*` cannot cross a `)`. The " +
    "old CST fired on any single-word base with +/- and no inner cast (TS 960 " +
    "vs Python 363); the CST now ports the Python semantics exactly (inner " +
    "scalar cast required, enumerated set, `+` only) — TS 498 vs Python 363. " +
    "The remaining gap is the per-LINE Python regex: `*(int*)((char*)p + 4)` " +
    "split across lines never fires there, while the CST is whole-node.",
  "smell.asm_code":
    "Both count per line, but Python's `\\basm\\b|__asm|\\bregister\\b` regex is applied to each " +
    "comment-stripped line with no node awareness; the CST emits one finding per line from " +
    "gnu_asm_expression nodes, `register` storage-class specifiers, and a text fallback for MWCC " +
    "`asm { }` / `asm void f(…)` bodies (tree-sitter ERROR nodes). Dedupe is per line in both — " +
    "this family matches 25/25 (incl. the 28 PS-kernel asm lines in math_types.cpp).",
  "smell.fake_stack":
    "Python's `[^;]` spans can cross newlines; the CST requires a whole byte-array declarator (u8/char) " +
    "that is volatile or named sp/stack. Matches 25/25 on this corpus.",
  "smell.rn_params":
    "Python's RE_RN_PARAM is unanchored (`\\b rN [,)]`) and fires on ANY rN token followed by `,` or " +
    "`)` — including rN in CALLS and register-text (CItemBoxGrid.cpp: 32 TS vs 71 Python); the CST " +
    "counts only rN parameter declarations.",
  "smell.goto_count":
    "Python counts any line containing `goto`; the CST counts goto_statement nodes. Matches 25/25.",
  "smell.decomp_macro":
    "Text rule: same regex over `//`-stripped lines as Python — expected identical (0/0 here).",
  "smell.pragma":
    "Text rule: same anchored regex over `//`-stripped lines as Python — matches 25/25.",
  "smell.asm_insn_shim":
    "Text rule: same regex as Python — matches 25/25.",
  "smell.schedule_pragma":
    "Text rule: same anchored regex as Python — matches 25/25.",
  "smell.init_side_effect":
    "Python runs one global regex over the RAW text (may cross lines); the CST uses the same global " +
    "regex over raw text — matches 25/25.",
  "smell.if0":
    "Text rule: same anchored regex over `//`-stripped lines as Python — matches 25/25.",
  "ptr.cast_byte_offset_deref":
    "The Python regexes require a `)` IMMEDIATELY before the `+`/`-` (`[^)]+?)\\s*[+\\-]`), which only " +
    "exists when the base expression itself contains a closing paren (call/nested parens). The " +
    "canonical form `*(T*)((u8*)p + N)` with a plain identifier base therefore NEVER fires in Python " +
    "(contradicting its own doc labels), while the CST implements the documented semantics — TS 510 " +
    "vs Python 5 on this corpus. Python also dedupes per line and skips lines starting with " +
    "`//`, `/*`, `*`, `#`, `\"`, `'`.",
  "ptr.cast_byte_ptr_arith":
    "Same `)`-before-operator regex artifact as ptr.cast_byte_offset_deref: `(u8*)p + N` with a plain " +
    "identifier base never fires in Python (TS 294 vs Python 10); the CST implements the documented " +
    "label. Python's only fires on bases with their own parens, e.g. `(char*)self - 0x58)->` which " +
    "even reports the offset as `>` (regex artifact).",
  "ptr.cast_int_arith":
    "Same line-regex vs CST difference; Python's non-greedy `(.+?)\\s*[+\\-]` also matches casts where " +
    "the int-cast is not the exact left operand. Near-match on this corpus (TS 4 vs Python 5).",
  "ptr.subscript_on_cast":
    "Python's `[^)]+` base also accepts `((T*)p + N)[M]`; the CST handles the plain cast form and the " +
    "cast+arith binary form explicitly, and excludes shapes whose base is not an identifier-level cast. " +
    "Near-match (TS 171 vs Python 163).",
  "ptr.ptr_offset_deref":
    "Python requires a SINGLE-WORD target (`[a-zA-Z_][a-zA-Z0-9_]*(?:" +
    "\\s*\\*)+`) — qualified/multi-word targets (`const u32*`, `A::B*`) never fire there — dedupes per " +
    "line, skips comment/`#`/string-prefix lines, and its `[^)]+?` offset span cannot cross a `)`. The " +
    "CST accepts any pointer target, works over the whole file (multi-line expressions), and drops the " +
    "Python false positive where a member base `c->field + 4` is reported as variable `c`. TS 453 vs " +
    "Python 279.",
  "ptr.reinterpret_arith":
    "Python runs two regexes (nested REINTERPRET_ARITH then top-level REINTERPRET_BYTE_ARITH); the CST " +
    "collects the nested form first in source order, then the top-level byte variant — same overlap " +
    "suppression semantics, CST-based. Matches 25/25 here.",
};

const ROOT_CAUSE_FALLBACK =
  "CST-based structural scan vs Python line/regex scan (comment stripping, line skipping, and " +
  "overlap dedupe differ); see the faithful-port notes in src/parse/cpp/rules/*.ts.";

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main(): void {
  const requested = process.argv.slice(2);
  const corpus: CorpusEntry[] =
    requested.length > 0
      ? requested.map((p) => ({ path: p, why: "CLI override" }))
      : CORPUS;

  const missing = corpus.filter((c) => !existsSync(c.path));
  if (missing.length > 0) {
    throw new Error(
      `corpus files missing: ${missing.map((c) => c.path).join(", ")}`,
    );
  }

  /* ---- 1. TS rules over the corpus ------------------------------ */
  console.log(`TS: lintFile + lintDelta over ${corpus.length} files…`);
  const results: FileResult[] = corpus.map((entry) => {
    const code = readFileSync(entry.path, "utf8");
    const whole = lintFile(entry.path, code);
    const delta = lintDelta(entry.path, null, code);
    return {
      path: entry.path,
      lines: code.split(/\r\n|\n|\r/).length,
      tsWhole: countByRule(whole),
      tsExternKinds: externKindCounts(whole),
      tsDelta: countByRule(delta),
      pyPointer: {},
      pySmell: {},
      pySmellCli: null,
      pyLint: {},
    };
  });

  /* ---- 2. detect_pointer_arithmetic.py (real CLI, one run) ------- */
  console.log("Python: detect_pointer_arithmetic.py --json…");
  const ptrJson = JSON.parse(
    runPython(["tools/coop/detect_pointer_arithmetic.py", "--dirs", ...POINTER_DIRS], "detect_pointer_arithmetic"),
  ) as { findings?: Array<{ file: string; category: string }> };
  const ptrByFile = new Map<string, Record<string, number>>();
  for (const f of ptrJson.findings ?? []) {
    const cur = ptrByFile.get(f.file) ?? {};
    cur[f.category] = (cur[f.category] ?? 0) + 1;
    ptrByFile.set(f.file, cur);
  }
  for (const r of results) r.pyPointer = ptrByFile.get(relOf(r.path)) ?? {};

  /* ---- 3a. smell_scan.py CLI (real tool; markdown table parsed) -- */
  console.log("Python: smell_scan.py CLI table…");
  const smellCliOut = runPython(
    ["tools/coop/smell_scan.py", ...corpus.map((c) => c.path)],
    "smell_scan CLI",
  );
  const cliRows = new Map<string, Record<string, number>>();
  let inTable = false;
  for (const line of smellCliOut.split(/\r?\n/)) {
    if (!inTable) {
      if (line.startsWith("| TU |")) inTable = true;
      continue;
    }
    if (line.startsWith("|--")) continue;
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = line.split("|").map((c) => c.trim());
    const nums = cells.slice(2, 12).map((c) => (c === "" ? 0 : Number(c)));
    if (nums.some((n) => Number.isNaN(n))) continue;
    cliRows.set(cells[1]!, {
      extern_c_total: nums[0]!,
      extern_c_nonlbl_decl: nums[1]!,
      extern_c_nonlbl_def: nums[2]!,
      self: nums[3]!,
      void_ptr: nums[4]!,
      ptr_arith: nums[5]!,
      deref_arith: nums[6]!,
      asm_code: nums[7]!,
      rn_params: nums[8]!,
      goto_count: nums[9]!,
    });
  }
  for (const r of results) r.pySmellCli = cliRows.get(relOf(r.path)) ?? null;

  /* ---- 3b. smell_scan.py scan_file shim (full family breakdown) -- */
  console.log("Python: smell_scan.py scan_file shim (full families)…");
  const SMELL_SHIM = [
    "import json, sys",
    'sys.path.insert(0, "tools/coop")',
    "from pathlib import Path",
    "from smell_scan import scan_file",
    'fams = ["extern_c_total","extern_c_lbl","extern_c_nonlbl_decl","extern_c_nonlbl_def","extern_c_other","self_params","self_access","void_ptr","void_ptr_cast","ptr_arith","deref_arith","asm_code","fake_stack","rn_params","goto_count","decomp_macro","pragma","asm_insn_shim","schedule_pragma","init_side_effect","if0","includes"]',
    "out = {}",
    "for p in sys.argv[1:]:",
    "    s = scan_file(Path(p))",
    "    out[p] = {f: getattr(s, f) for f in fams}",
    "print(json.dumps(out))",
  ].join("\n");
  const smellJson = JSON.parse(
    runPython(["-c", SMELL_SHIM, ...corpus.map((c) => c.path)], "smell_scan scan_file"),
  ) as Record<string, Record<string, number>>;
  for (const r of results) r.pySmell = smellJson[r.path] ?? {};

  /* ---- 4. lint.py lint_delta shim -------------------------------- */
  console.log("Python: lint.py lint_delta shim…");
  const LINT_SHIM = [
    "import json, sys",
    'sys.path.insert(0, "tools/pi_harness")',
    "from lint import lint_delta",
    "out = {}",
    "for p in sys.argv[1:]:",
    '    with open(p, encoding="utf-8", errors="replace") as f:',
    "        code = f.read()",
    "    c = {}",
    "    for v in lint_delta(p, None, code):",
    "        c[v.rule] = c.get(v.rule, 0) + 1",
    "    out[p] = c",
    "print(json.dumps(out))",
  ].join("\n");
  const lintJson = JSON.parse(
    runPython(["-c", LINT_SHIM, ...corpus.map((c) => c.path)], "lint.py lint_delta"),
  ) as Record<string, Record<string, number>>;
  for (const r of results) r.pyLint = lintJson[r.path] ?? {};

  /* ---- 5. Comparison --------------------------------------------- */
  const smellRows = SMELL_FAMILIES.map((fam) =>
    compareFamily(
      fam,
      { results, tsLookup: (r) => r.tsWhole, pyLookup: (r) => r.pySmell },
      ROOT_CAUSE[fam.ts] ?? ROOT_CAUSE_FALLBACK,
    ),
  );
  const pointerRows = POINTER_FAMILIES.map((fam) =>
    compareFamily(
      fam,
      { results, tsLookup: (r) => r.tsWhole, pyLookup: (r) => r.pyPointer },
      ROOT_CAUSE[fam.ts] ?? ROOT_CAUSE_FALLBACK,
    ),
  );
  const deltaRows = DELTA_RULES.map((rule) =>
    compareFamily(
      { py: rule, ts: rule },
      { results, tsLookup: (r) => r.tsDelta, pyLookup: (r) => r.pyLint },
      ROOT_CAUSE[rule] ?? ROOT_CAUSE_FALLBACK,
    ),
  );

  const rate = (rows: RuleRow[]): string => {
    const cells = rows.reduce((a, r) => a + r.totalFiles, 0);
    const matched = rows.reduce((a, r) => a + r.matchedFiles, 0);
    return `${matched}/${cells} (${((100 * matched) / cells).toFixed(1)}%)`;
  };
  const allRows = [...smellRows, ...pointerRows, ...deltaRows];
  const overallCells = allRows.reduce((a, r) => a + r.totalFiles, 0);
  const overallMatched = allRows.reduce((a, r) => a + r.matchedFiles, 0);
  const overallRate = `${overallMatched}/${overallCells} (${((100 * overallMatched) / overallCells).toFixed(1)}%)`;

  /* ---- 6. Report -------------------------------------------------- */
  const now = new Date().toISOString();
  const L: string[] = [];
  L.push("# M1a golden-corpus parity report");
  L.push("");
  L.push(`Generated by \`scripts/parity.ts\` at \`${now}\` (UTC).`);
  L.push("");
  L.push(
    "**Parity definition (SPEC §13.4): golden-corpus comparison WITH a documented deviation list — " +
      "NOT count-identical output.** CST rewrites are not count-identical to the line/regex scanners; " +
      "the value of this report is the per-family divergence ledger and its root causes.",
  );
  L.push("");
  L.push(`- **Corpus:** ${corpus.length} files — 15 \`src/kyoshin\`, 5 \`libs/monolib/src\`, 5 \`libs/nw4r/src\``);
  L.push(`- **Lines scanned:** ${results.reduce((a, r) => a + r.lines, 0)}`);
  L.push(`- **Reference Python:** \`${PYTHON}\`, run with cwd \`${XENOBLADE_ROOT}\``);
  L.push("");

  /* Headline */
  L.push("## Headline");
  L.push("");
  L.push(
    `Per-(rule, file) count parity across the corpus: **${overallRate}** ` +
      "(a cell matches when the TS rule count equals the Python family count for that file).",
  );
  L.push("");
  L.push("| Group | Files × rules compared | Cells matching TS == Python |");
  L.push("|---|---|---|");
  L.push(`| smell-scan families (21) | ${smellRows.length * corpus.length} | ${rate(smellRows)} |`);
  L.push(`| pointer-arithmetic categories (6) | ${pointerRows.length * corpus.length} | ${rate(pointerRows)} |`);
  L.push(`| delta-lint rules (20) | ${deltaRows.length * corpus.length} | ${rate(deltaRows)} |`);
  L.push(`| **All comparable rules (47)** | ${overallCells} | **${overallMatched} (${((100 * overallMatched) / overallCells).toFixed(1)}%)** |`);
  L.push("");

  /* Smell table */
  L.push("## Smell-scan families (`lintFile` vs `smell_scan.py`)");
  L.push("");
  L.push(
    "Python reference = \`smell_scan.scan_file()\` per family (same function the CLI uses). " +
      "The CLI's markdown table is a lossy projection (see *Skipped / degraded comparisons*), so the " +
      "full families come from the shim; the CLI cross-check is a separate section below.",
  );
  L.push("");
  L.push(
    mdTable(
      ["Rule", "TS Σ", "Python Σ", "Δ", "Files matched", "Status"],
      smellRows.map((r) => [
        r.rule,
        String(r.tsTotal),
        String(r.pyTotal),
        String(r.tsTotal - r.pyTotal),
        `${r.matchedFiles}/${r.totalFiles}`,
        statusOf(r),
      ]),
    ),
  );
  L.push("");
  L.push("**TS-only rules** (SPEC §13.1 additions — no Python equivalent, not compared):");
  L.push("");
  L.push(`\`${TS_ONLY_SMELL.join("`, `")}\``);
  L.push("");
  L.push(
    `**Not compared:** \`includes\` (Python-only preprocessor counter, no TS rule) and ` +
      "`extern_c_*` kind split detail (Python classifies lines, TS classifies declarations).",
  );
  L.push("");

  /* Pointer table */
  L.push("## Pointer-arithmetic categories (`lintFile` vs `detect_pointer_arithmetic.py`)");
  L.push("");
  L.push(
    "Python reference = the real CLI run (\`--dirs src/kyoshin libs/monolib/src libs/nw4r/src\`), " +
      "per-file category counts extracted from its JSON \`findings\`.",
  );
  L.push("");
  L.push(
    mdTable(
      ["Rule", "TS Σ", "Python Σ", "Δ", "Files matched", "Status"],
      pointerRows.map((r) => [
        r.rule,
        String(r.tsTotal),
        String(r.pyTotal),
        String(r.tsTotal - r.pyTotal),
        `${r.matchedFiles}/${r.totalFiles}`,
        statusOf(r),
      ]),
    ),
  );
  L.push("");

  /* Delta table */
  L.push("## Delta-lint rules (`lintDelta(path, null, code)` vs `lint.py lint_delta(path, None, code)`)");
  L.push("");
  L.push(
    "\`oldText = null\` marks every line as added on both sides, so the Myers-vs-difflib diff " +
      "difference (SPEC §13.2) cannot contribute — any divergence here is a rule-semantics difference.",
  );
  L.push("");
  L.push(
    mdTable(
      ["Rule", "TS Σ", "Python Σ", "Δ", "Files matched", "Status"],
      deltaRows.map((r) => [
        r.rule,
        String(r.tsTotal),
        String(r.pyTotal),
        String(r.tsTotal - r.pyTotal),
        `${r.matchedFiles}/${r.totalFiles}`,
        statusOf(r),
      ]),
    ),
  );
  L.push("");

  /* Per-file overview */
  L.push("## Per-file overview");
  L.push("");
  L.push(
    "Totals per file per engine. \"TS whole\" = all 29 \`lintFile\` rules " +
      "(21 smell + 6 ptr + 2 clone); \"PY smell\" = " +
      "\`extern_c_total\` + the 16 disjoint scan_file families (the four extern_c kind cells are " +
      "subcounts of the total); \"TS/PY ptr\" = the 6 categories; \"TS/PY delta\" = the 20 delta rules.",
  );
  L.push("");
  const pySmellDisjoint = (r: FileResult): number => {
    const fams = [
      "self_params", "self_access", "void_ptr", "void_ptr_cast", "ptr_arith",
      "deref_arith", "asm_code", "fake_stack", "rn_params", "goto_count",
      "decomp_macro", "pragma", "asm_insn_shim", "schedule_pragma",
      "init_side_effect", "if0",
    ];
    return (r.pySmell["extern_c_total"] ?? 0) +
      fams.reduce((a, f) => a + (r.pySmell[f] ?? 0), 0);
  };
  const sum = (m: Record<string, number>): number =>
    Object.values(m).reduce((a, n) => a + n, 0);
  L.push(
    mdTable(
      ["File", "Lines", "TS whole", "PY smell", "TS ptr", "PY ptr", "TS delta", "PY lint"],
      results.map((r) => [
        relOf(r.path),
        String(r.lines),
        String(sum(r.tsWhole)),
        String(pySmellDisjoint(r)),
        String(POINTER_FAMILIES.reduce((a, f) => a + (r.tsWhole[f.ts] ?? 0), 0)),
        String(POINTER_FAMILIES.reduce((a, f) => a + (r.pyPointer[f.py] ?? 0), 0)),
        String(sum(r.tsDelta)),
        String(sum(r.pyLint)),
      ]),
    ),
  );
  L.push("");

  /* Top divergences */
  const top = [...allRows]
    .filter((r) => r.tsTotal !== r.pyTotal)
    .sort((a, b) => b.absDev - a.absDev)
    .slice(0, 8);
  L.push("## Top divergences (root cause)");
  L.push("");
  L.push(
    "Ranked by total absolute per-file deviation \`Σ|TS − Python|\` over the corpus. The three " +
      "largest are the headline findings.",
  );
  L.push("");
  for (const [i, r] of top.entries()) {
    L.push(`### ${i + 1}. \`${r.rule}\` — TS ${r.tsTotal} vs Python ${r.pyTotal} (Σ|Δ| = ${r.absDev})`);
    L.push("");
    L.push(r.note);
    L.push("");
  }
  if (top.length === 0) {
    L.push("No count divergence on any comparable family.");
    L.push("");
  }

  /* CLI cross-check */
  L.push("## smell_scan.py CLI cross-check (real tool table rows)");
  L.push("");
  L.push(
    "The CLI prints a markdown row only when severity or extern_C-nonlbl counts are nonzero, and it " +
      "AGGREGATES families: \`self\` = self_params + self_access, \`void*\` = void_ptr + void_ptr_cast, " +
      "and \`fake_stack\` / text families are absent. Cells below compare the parsed CLI row against the " +
      "sum of the corresponding TS rules on the same file.",
  );
  L.push("");
  const cliHeaders = ["File", "extC-total", "extC-decl", "extC-def", "self", "void*", "ptr-arith", "deref-arith", "asm", "rN", "goto"];
  L.push(
    mdTable(
      ["File", ...cliHeaders.slice(1).map((h) => `${h} (TS|CLI)`), "row?"],
      results.map((r) => {
        const cli = r.pySmellCli;
        const cell = (tsKey: string, cliKey: string, tsKind?: string): string => {
          const t = tsKind !== undefined ? (r.tsExternKinds[tsKind] ?? 0) : (r.tsWhole[tsKey] ?? 0);
          const p = cli?.[cliKey] ?? "—";
          return `${t}|${p}`;
        };
        // CLI merges two TS sub-families into one column; show the TS sum vs CLI.
        const merged = (tsA: string, tsB: string, cliKey: string): string =>
          `${(r.tsWhole[tsA] ?? 0) + (r.tsWhole[tsB] ?? 0)}|${cli?.[cliKey] ?? "—"}`;
        return [
          relOf(r.path),
          cell("smell.extern_c", "extern_c_total"),
          cell("smell.extern_c#nonlbl-decl", "extern_c_nonlbl_decl", "nonlbl-decl"),
          cell("smell.extern_c#nonlbl-def", "extern_c_nonlbl_def", "nonlbl-def"),
          merged("smell.self_param", "smell.self_access", "self"),
          merged("smell.void_ptr", "smell.void_ptr_cast", "void_ptr"),
          cell("smell.ptr_arith", "ptr_arith"),
          cell("smell.deref_arith", "deref_arith"),
          cell("smell.asm_code", "asm_code"),
          cell("smell.rn_params", "rn_params"),
          cell("smell.goto_count", "goto_count"),
          cli === null ? "no row" : "row",
        ];
      }),
    ),
  );
  L.push("");
  L.push(
    "A missing CLI row means the file's severity and extern_C-nonlbl counts were both zero for the " +
      "aggregated families — it is NOT an all-zero file (e.g. extern_c_total may be nonzero with only " +
      "lbl/other lines). Use the scan_file shim counts for exact zeros.",
  );
  L.push("");

  /* Skipped / degraded */
  L.push("## Skipped / degraded comparisons (documented)");
  L.push("");
  L.push(
    "- **smell_scan CLI table is not used as the Python reference for the per-rule table.** It merges " +
      "self_params+self_access into \`self\`, void_ptr+void_ptr_cast into \`void*\`, omits fake_stack and " +
      "the text families (decomp_macro, pragma, asm_insn_shim, schedule_pragma, init_side_effect, if0, " +
      "extern_c_lbl, extern_c_other), and omits zero-severity files entirely. The scan_file shim runs the " +
      "exact same function the CLI calls per file, so it is the lossless reference; the CLI cross-check " +
      "section above demonstrates the real-tool rows.",
  );
  L.push(
    "- **extern_c kind split**: Python's \`extern_c_lbl/nonlbl_decl/nonlbl_def/other\` classify LINES; " +
      "the TS \`smell.extern_c\` rule classifies DECLARATIONS (kind tag in the message). Both are shown; " +
      "the per-line vs per-declaration semantic is the documented root cause of that family's divergence.",
  );
  L.push(
    "- **includes** (Python preprocessor-counter family) has no TS rule and is not compared.",
  );
  L.push(
    "- **CLI override mode**: positional file arguments replace the hardcoded corpus; files outside the " +
      "three scanned dirs get Python pointer counts of 0 (the scan ran over the pinned dirs).",
  );
  L.push("");

  /* Corpus manifest */
  L.push("## Corpus manifest");
  L.push("");
  L.push(
    mdTable(
      ["#", "File", "Why"],
      corpus.map((c, i) => [String(i + 1), relOf(c.path), c.why]),
    ),
  );
  L.push("");

  /* Reproduce */
  L.push("## Reproducing");
  L.push("");
  L.push("```bash");
  L.push("cd /Users/ahmedelbannan/Ahmed/decompi");
  L.push("npx tsx scripts/parity.ts          # writes docs/m1a-parity.md");
  L.push("npm run typecheck                   # typecheck gate");
  L.push("```");
  L.push("");

  /* Infrastructure note */
  L.push("## Infrastructure note: tree-sitter pin");
  L.push("");
  L.push(
    "This harness surfaced a hard blocker in the pinned tree-sitter 0.21.1: its Node binding throws " +
      "`Invalid argument` for any input longer than 32,767 characters (2^15−1), which makes `lintFile` " +
      "impossible on real TUs (the smallest corpus file is 119 lines; most are 500–4,800). ",
  );
  L.push("");
  L.push(
    "Fix: `package.json` now pins `\"tree-sitter\": \"0.22.1\"` (exact, not `^`). 0.22.1 lifts the size " +
      "limit while keeping `Parser.setLanguage(language?: any)` — tree-sitter 0.22.2+ tightened the " +
      "`Language.language` type to a self-referential `Language`, which breaks the typecheck against " +
      "tree-sitter-cpp 0.23.4's `language: unknown` export. A caret range would re-resolve to 0.22.4 and " +
      "fail `npm run typecheck`, so the exact pin is required (verified again on the 0.22.1 review fix: " +
      "`~0.22.1` → 0.22.4 fails in src/parse/cpp/tree.ts, and a clean `npm install` cannot even resolve " +
      "a range because tree-sitter-cpp@0.23.4 declares peerOptional `tree-sitter@^0.21.1` — install with " +
      "`--legacy-peer-deps`). The runtime grammar is unchanged " +
      "(tree-sitter-cpp 0.23.4), so rule behaviour is identical; `npm test` stays green.",
  );
  L.push("");

  mkdirSync(dirname(DOC_PATH), { recursive: true });
  writeFileSync(DOC_PATH, L.join("\n"));

  /* ---- Console summary ------------------------------------------- */
  console.log("");
  console.log(`Wrote ${DOC_PATH}`);
  console.log("");
  console.log(`Overall per-(rule,file) match: ${overallRate}`);
  console.log(`  smell:   ${rate(smellRows)}`);
  console.log(`  pointer: ${rate(pointerRows)}`);
  console.log(`  delta:   ${rate(deltaRows)}`);
  console.log("");
  console.log("Top divergences by Σ|Δ|:");
  for (const [i, r] of top.slice(0, 5).entries()) {
    console.log(
      `  ${i + 1}. ${r.rule}: TS ${r.tsTotal} vs PY ${r.pyTotal} (Σ|Δ|=${r.absDev}, files ${r.matchedFiles}/${r.totalFiles})`,
    );
  }
}

const DOC_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "m1a-parity.md");

main();
