/**
 * M1a rule registry (SPEC §13, §13.1, §13.4) — the single entry point for
 * whole-file source-rule scanning, the delta-lint gate, and the committed
 * `report --check` CI gate (mirror of the Xenoblade
 * `tools/coop/smell_report.py --check/--completeness`).
 *
 * - `sourceRules` aggregates the rule families (21 smell-scan rules +
 *   6 pointer-arithmetic rules + 2 clone/duplicate rules, SPEC §13.1) in
 *   registry order; `lintFile` runs them over a parsed CST, appending the
 *   fixture-backed `match.*` rules when `cfg.match` is present and gating
 *   `smell.class_in_cpp`/`smell.struct_in_cpp` to .cpp/.cc/.cxx TUs.
 * - `lintDelta` wraps the line-oriented delta gate (delta.ts), threading the
 *   configurable placeholder patterns and the angle-include whitelist through
 *   the gate's `DeltaLintOptions`.
 * - The report gate (`scanUnits` / `renderSmellReport` / `checkSmellReport` /
 *   `extractBaseline`) is the `decompi report --check` CI gate: freshness
 *   (the committed doc must equal a fresh regeneration) + per-TU regression
 *   vs a base-branch baseline, with an RVL variant that strips asm bodies
 *   (`skip_asm_bodies`, informational).
 * - `formatFindings` renders findings as text, JSON (stable schema), or
 *   markdown (SPEC §13.4).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseCpp } from "./tree.js";
import { smellRules } from "./rules/smell.js";
import { makeDefineRenameAliasRule } from "./rules/smell.js";
import { pointerRules } from "./rules/pointer.js";
import { cloneRules } from "./rules/clone.js";
import { matchRules, type MatchRuleContext } from "./rules/match.js";
import { lintDelta as deltaLintDelta, type DeltaLintOptions } from "./delta.js";
import type { Finding, SourceRule } from "./types.js";

/**
 * All whole-file source rules (SPEC §13.1): the smell-scan family, then the
 * pointer-arithmetic family, then the clone/duplicate family, in registry
 * order. The `match.*` family is config-dependent (needs accepted work-item
 * status) and is appended by `lintFile` when `cfg.match` is present.
 */
export const sourceRules: SourceRule[] = [
  ...smellRules,
  ...pointerRules,
  ...cloneRules,
];

/** `.cpp`/`.cc`/`.cxx` translation unit (class/struct definitions are a TU smell). */
const CPP_TU_RE = /\.(?:cpp|cc|cxx)$/i;
function isCppTU(path: string): boolean {
  return CPP_TU_RE.test(path);
}

/**
 * Per-file lint configuration.
 *
 * `placeholderPatterns` mirrors the SPEC §13.1/§13.2 configurable placeholder
 * families. Three consumers: `unknown` feeds `no_unk_name` (unkN
 * identifiers) and `class` feeds `no_unk_generated` (`UnkClass_*`,
 * `UnkVirtualFunc*`, `UnkStruct*` …) in the delta gate, and
 * `function`/`label`/`data` feed the `smell.define_rename_alias` whole-file
 * rule (SPEC §B). In a `--config` file patterns are JSON strings; in
 * process, RegExp literals are accepted directly.
 */
export interface LintConfig {
  placeholderPatterns?: {
    function?: RegExp;
    class?: RegExp;
    unknown?: RegExp;
    label?: RegExp;
    data?: RegExp;
  };
  /** Angle-include whitelist for the delta gate's `no_angle_include`. */
  angleIncludeWhitelist?: string[];
  /**
   * Fixture-backed matched-function smell context (SPEC §13.1 `match.*`
   * rules; M1a reads work items from a fixture JSON, the real store lands in
   * M2). When present, `lintFile` appends the `match.*` rules; without it the
   * rules do not run at all.
   */
  match?: MatchRuleContext;
}

/**
 * Stable sort by line only: findings from the same line keep registry (rule
 * evaluation) order, and equal (line, rule) pairs keep emission order —
 * deterministic ordering per SPEC §13.4.
 */
function sortByLine<T extends { line: number }>(findings: T[]): T[] {
  return [...findings].sort((a, b) => a.line - b.line);
}

/**
 * Compile a placeholder pattern to RegExp for the `smell.define_rename_alias`
 * rule (SPEC §B): the adapter declares patterns as strings, so string configs
 * are compiled here; RegExp literals pass through. Empty-source patterns
 * (an adapter declaring `label: ""` / `data: ""`) are dropped so they cannot
 * match every name (`new RegExp("")` has source `(?:)`).
 */
function compilePlaceholderPattern(p: RegExp | string | undefined): RegExp | undefined {
  if (p === undefined) return undefined;
  const re = typeof p === "string" ? new RegExp(p) : p;
  return re.source === "(?:)" ? undefined : re;
}

/**
 * Run every source rule over `source` — a whole-file scan — returning
 * findings sorted by (line, rule-registry order).
 *
 * `path` drives the `smell.class_in_cpp` / `smell.struct_in_cpp` gate: those
 * two rules fire only for `.cpp`/`.cc`/`.cxx` translation units (definitions
 * in headers are the desired location, never a smell). `cfg.match` (the
 * fixture-backed work-item context) appends the `match.*` rules;
 * `cfg.placeholderPatterns.function`/`.label`/`.data` append the
 * `smell.define_rename_alias` rule (SPEC §B) — without placeholder patterns
 * the rule does not run at all.
 */
export function lintFile(path: string, source: string, cfg?: LintConfig): Finding[] {
  const { root } = parseCpp(source);
  const base = cfg?.match !== undefined ? [...sourceRules, ...matchRules(cfg.match)] : sourceRules;
  let rules = isCppTU(path)
    ? base
    : base.filter((r) => r.id !== "smell.class_in_cpp" && r.id !== "smell.struct_in_cpp");
  const pp = cfg?.placeholderPatterns;
  if (pp !== undefined && (pp.function !== undefined || pp.label !== undefined || pp.data !== undefined)) {
    rules = [
      ...rules,
      makeDefineRenameAliasRule({
        function: compilePlaceholderPattern(pp.function),
        label: compilePlaceholderPattern(pp.label),
        data: compilePlaceholderPattern(pp.data),
      }),
    ];
  }
  return sortByLine(rules.flatMap((rule) => rule.run(root, source)));
}

/**
 * Delta-lint gate wrapper (SPEC §13.2): added-lines scan of
 * `oldText → newText`. `oldText === null` treats the whole file as added.
 *
 * `cfg.placeholderPatterns.unknown` / `.class` are mapped to the delta gate's
 * `unkNamePattern` / `unkGeneratedPattern` options; `cfg.angleIncludeWhitelist`
 * overrides the gate's built-in whitelist.
 */
export function lintDelta(
  path: string,
  oldText: string | null,
  newText: string,
  cfg?: LintConfig,
): Finding[] {
  const options: DeltaLintOptions = {};
  const patterns = cfg?.placeholderPatterns;
  if (patterns !== undefined) {
    if (patterns.unknown !== undefined) options.unkNamePattern = patterns.unknown;
    if (patterns.class !== undefined) options.unkGeneratedPattern = patterns.class;
  }
  if (cfg?.angleIncludeWhitelist !== undefined) {
    options.angleIncludeWhitelist = cfg.angleIncludeWhitelist;
  }
  return deltaLintDelta(path, oldText, newText, options);
}

/** Grep-style one-line-per-finding rendering. */
function formatText(findings: Finding[]): string {
  return findings
    .map((f) => {
      const loc = f.column !== undefined ? `${f.line}:${f.column}` : `${f.line}`;
      const snip = f.snippet !== undefined && f.snippet.length > 0 ? `  (${f.snippet})` : "";
      return `${loc}  ${f.rule}  ${f.message}${snip}`;
    })
    .join("\n");
}

/** Markdown report grouped by rule id. */
function formatMarkdown(findings: Finding[]): string {
  if (findings.length === 0) return "No findings.";
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const group = byRule.get(f.rule);
    if (group === undefined) byRule.set(f.rule, [f]);
    else group.push(f);
  }
  const parts: string[] = [];
  for (const [rule, group] of byRule) {
    parts.push(`### ${rule}`, "");
    for (const f of group) {
      const loc = f.column !== undefined ? `line ${f.line}:${f.column}` : `line ${f.line}`;
      const snip = f.snippet !== undefined && f.snippet.length > 0 ? ` — \`${f.snippet}\`` : "";
      parts.push(`- ${loc}: ${f.message}${snip}`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

/**
 * Render findings (SPEC §13.4): `text` (grep-style lines, empty when none),
 * `json` (stable schema — a JSON array of `Finding` objects), or `markdown`
 * (per-rule report).
 */
export function formatFindings(findings: Finding[], fmt: "text" | "json" | "markdown"): string {
  switch (fmt) {
    case "json":
      return JSON.stringify(findings, null, 2);
    case "markdown":
      return formatMarkdown(findings);
    default:
      return formatText(findings);
  }
}

/* ------------------------------------------------------------------ *
 * report --check CI gate (mirror of tools/coop/smell_report.py)
 * ------------------------------------------------------------------ */

/**
 * Per-TU smell metrics tracked by the report gate — the smell_report.py
 * METRICS list, keyed to TS rule ids. `kind` selects one `smell.extern_c`
 * message split; `rule` alone otherwise.
 */
export const SMELL_METRICS: ReadonlyArray<{
  key: string;
  rule: string;
  kind?: string;
  display: string;
}> = [
  { key: "extern_c_nonlbl_decl", rule: "smell.extern_c", kind: "nonlbl-decl", display: "extC-decl" },
  { key: "extern_c_nonlbl_def", rule: "smell.extern_c", kind: "nonlbl-def", display: "extC-def" },
  { key: "self_params", rule: "smell.self_param", display: "self" },
  { key: "void_ptr", rule: "smell.void_ptr", display: "void*" },
  { key: "ptr_arith", rule: "smell.ptr_arith", display: "ptr-arith" },
  { key: "deref_arith", rule: "smell.deref_arith", display: "deref-arith" },
  { key: "asm_code", rule: "smell.asm_code", display: "asm" },
  { key: "rn_params", rule: "smell.rn_params", display: "rN" },
  { key: "goto_count", rule: "smell.goto_count", display: "goto" },
  { key: "asm_insn_shim", rule: "smell.asm_insn_shim", display: "asm-shim" },
  { key: "schedule_pragma", rule: "smell.schedule_pragma", display: "schedule-pragma" },
  { key: "init_side_effect", rule: "smell.init_side_effect", display: "init-side-effect" },
];

/** Cleanable-severity weights (smell_report.py SEVERITY_WEIGHTS subset). */
const SMELL_SEVERITY: Readonly<Record<string, number>> = {
  extern_c_nonlbl_decl: 1,
  extern_c_nonlbl_def: 2,
  self_params: 2,
  void_ptr: 1,
  ptr_arith: 1,
  deref_arith: 1,
  asm_code: 3,
  rn_params: 2,
  asm_insn_shim: 3,
  schedule_pragma: 3,
  init_side_effect: 4,
};

/** Metrics seeded at 0 so a fresh metric is established from its first commit. */
const NEW_METRIC_SEED: ReadonlyArray<string> = [
  "asm_insn_shim",
  "schedule_pragma",
  "init_side_effect",
];

const BASELINE_BEGIN = "<!-- BEGIN BASELINE -->";
const BASELINE_END = "<!-- END BASELINE -->";

/**
 * Lines inside `asm` function/block bodies, per Python's skip_asm_bodies
 * state machine (smell_scan.py RE_ASM_ENTRY/RE_ASM_PAREN + brace/paren
 * depth). `entry` lines keep only their `asm_code` finding; `body` lines are
 * dropped from every metric (Python `continue`s before any check).
 */
function asmBodyLines(
  source: string,
): { entry: Set<number>; body: Set<number> } {
  const RE_ASM_ENTRY =
    /^\s*(?!\/?\*).*\basm\s+(?:void|const\s+void|[A-Za-z_]\w*(?:\s*\*)?)\s+[A-Za-z_]\w*\s*\(|^\s*asm\s*\{|\b(?:ASM_VOLATILE|ASM)\s*\(\s*$/;
  const RE_ASM_PAREN = /\b(?:ASM_VOLATILE|ASM)\s*\(/;
  const entry = new Set<number>();
  const body = new Set<number>();
  let inAsm = false;
  let amode: "brace" | "paren" = "brace";
  let depth = 0;
  source.split(/\r\n|\n|\r/).forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.split("//", 1)[0]!;
    if (!inAsm && RE_ASM_ENTRY.test(line)) {
      inAsm = true;
      entry.add(lineNo);
      amode = RE_ASM_PAREN.test(line) ? "paren" : "brace";
      depth = amode === "paren"
        ? line.split("(").length - 1 - (line.split(")").length - 1)
        : line.split("{").length - 1 - (line.split("}").length - 1);
      return;
    }
    if (inAsm) {
      if (amode === "brace") {
        depth += line.split("{").length - 1 - (line.split("}").length - 1);
        if (line.trim() === "}" || depth < 0) inAsm = false;
      } else {
        depth += line.split("(").length - 1 - (line.split(")").length - 1);
        if (depth <= 0) inAsm = false;
      }
      body.add(lineNo);
      return;
    }
  });
  return { entry, body };
}

/** Recursively collect source files under a root (dir walk or single file). */
function collectSourceFiles(paths: string[], includeC: boolean): string[] {
  const out: string[] = [];
  const isTarget = (name: string): boolean =>
    /\.cpp$/.test(name) || (includeC && /\.c$/.test(name) && !/\.ctx\.c$/.test(name));
  const visit = (p: string): void => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isFile()) {
      if (isTarget(p)) out.push(p);
    } else if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        if (entry.startsWith(".")) continue;
        visit(join(p, entry));
      }
    }
  };
  for (const p of paths) visit(p);
  return [...new Set(out)].sort();
}

/**
 * Scan source files (dirs are walked) into per-TU smell metrics: rule counts
 * from `lintFile`, extern_c kinds from the message split, with the RVL
 * variant (`skipAsmBodies`) stripping asm-body lines from every metric.
 */
export function scanUnits(
  paths: readonly string[],
  opts: { skipAsmBodies?: boolean; includeC?: boolean } = {},
): Record<string, Record<string, number>> {
  const rows: Record<string, Record<string, number>> = {};
  for (const file of collectSourceFiles([...paths], opts.includeC ?? false)) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable files are skipped (deterministic)
    }
    let findings = lintFile(file, source);
    if (opts.skipAsmBodies === true) {
      const { entry, body } = asmBodyLines(source);
      findings = findings.filter(
        (f) => !body.has(f.line) && (f.rule === "smell.asm_code" || !entry.has(f.line)),
      );
    }
    const metrics: Record<string, number> = {};
    for (const { key, rule, kind } of SMELL_METRICS) {
      metrics[key] = findings.filter(
        (f) =>
          f.rule === rule &&
          (kind === undefined || f.message.includes(`kind=${kind}`)),
      ).length;
    }
    rows[file] = metrics;
  }
  return rows;
}

/** Baseline JSON blob: `{ path: { metric: n, … } }` (nonzero metrics only). */
function baselineJson(rows: Record<string, Record<string, number>>): string {
  const bl: Record<string, Record<string, number>> = {};
  for (const [path, metrics] of Object.entries(rows).sort()) {
    const m: Record<string, number> = {};
    for (const { key } of SMELL_METRICS) {
      const n = metrics[key] ?? 0;
      if (n > 0) m[key] = n;
    }
    for (const key of NEW_METRIC_SEED) m[key] ??= 0;
    if (Object.keys(m).length > 0) bl[path] = m;
  }
  return JSON.stringify(bl, null, 1);
}

/** Render the committed smell report for `rows` (deterministic). */
export function renderSmellReport(
  rows: Record<string, Record<string, number>>,
  opts: { rvl?: boolean } = {},
): string {
  const paths = Object.keys(rows).sort();
  const severity = (m: Record<string, number>): number =>
    Object.entries(SMELL_SEVERITY).reduce((a, [k, w]) => a + (m[k] ?? 0) * w, 0);
  const totals: Record<string, number> = {};
  for (const m of Object.values(rows)) {
    for (const { key } of SMELL_METRICS) totals[key] = (totals[key] ?? 0) + (m[key] ?? 0);
  }
  const L: string[] = [];
  L.push("# Code Smell Report");
  L.push("");
  L.push("<!-- GENERATED by `decompi report --write`. Do not edit by hand. -->");
  L.push("");
  if (opts.rvl === true) {
    L.push(
      "RVL_SDK variant — **informational, not CI-gated**: asm-function bodies are stripped " +
        "from the C-level metrics (their mnemonic lines would flood rN/self/arith counts).",
    );
    L.push("");
  }
  L.push(
    "Tracks the legacy TU smell families (extern \"C\" outside `lbl_*`, `self` free-function " +
      "params, `void*`, raw pointer arithmetic, register-named params, inline asm, goto chains, " +
      "fakematch-candidate families). **Goal: every number in this table trends to 0.**",
  );
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(`- Files scanned: ${paths.length} TUs`);
  L.push("");
  L.push("| metric | count |");
  L.push("|---|---|");
  const labels: Record<string, string> = {
    extern_c_nonlbl_decl: "extern \"C\" declarations (non-lbl_*, imports)",
    extern_c_nonlbl_def: "extern \"C\" definitions (forced names)",
    self_params: "`self` params",
    void_ptr: "`void*` (params + locals)",
    ptr_arith: "raw pointer offset arithmetic",
    deref_arith: "deref-through-cast arithmetic",
    asm_code: "inline asm / `register`",
    rn_params: "rN-named params",
    goto_count: "goto",
    asm_insn_shim: "DECOMP_ASM_INSN asm shims (fakematch candidate)",
    schedule_pragma: "#pragma schedule once/twice (fakematch candidate)",
    init_side_effect: "assignment inside cast / init-list (fakematch candidate)",
  };
  for (const { key } of SMELL_METRICS) {
    L.push(`| ${labels[key]} | ${totals[key] ?? 0} |`);
  }
  L.push("");
  const top = paths
    .map((p) => [p, severity(rows[p]!)] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10);
  L.push("## Top offenders (by cleanable severity)");
  L.push("");
  L.push("| TU | severity |");
  L.push("|---|---|");
  for (const [p, s] of top) L.push(`| ${p} | ${s} |`);
  L.push("");
  L.push("## Per-TU metrics");
  L.push("");
  L.push("| TU | " + SMELL_METRICS.map((m) => m.display).join(" | ") + " |");
  L.push("|" + "---|".repeat(SMELL_METRICS.length + 1));
  for (const p of paths) {
    const m = rows[p]!;
    const vals = SMELL_METRICS.map(({ key }) => String(m[key] ?? 0));
    if (vals.every((v) => v === "0")) continue;
    L.push(`| ${p} | ${vals.join(" | ")} |`);
  }
  L.push("");
  L.push(BASELINE_BEGIN);
  L.push(baselineJson(rows));
  L.push(BASELINE_END);
  L.push("");
  return L.join("\n");
}

/** Parse the baseline JSON out of a committed report (empty when absent). */
export function extractBaseline(text: string): Record<string, Record<string, number>> {
  const begin = text.indexOf(BASELINE_BEGIN);
  const end = text.indexOf(BASELINE_END);
  if (begin < 0 || end < 0 || end <= begin) return {};
  const blob = text.slice(begin + BASELINE_BEGIN.length, end).trim();
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, number>> = {};
    for (const [path, m] of Object.entries(parsed as Record<string, unknown>)) {
      if (m === null || typeof m !== "object") continue;
      const mm: Record<string, number> = {};
      for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n)) mm[k] = n;
      }
      out[path] = mm;
    }
    return out;
  } catch {
    return {};
  }
}

/** `git show <ref>:<reportPath>` — the base-branch copy, or null. */
function baseReportText(base: string | undefined, reportPath: string): string | null {
  const candidates = base !== undefined ? [base] : ["origin/main", "origin/master", "HEAD~1"];
  for (const ref of candidates) {
    if (ref.length === 0) continue;
    try {
      const res = spawnSync("git", ["show", `${ref}:${reportPath}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.status === 0 && res.stdout !== null && res.stdout.length > 0) {
        return res.stdout;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The `report --check` gate (mirror of smell_report.py cmd_check):
 *
 *  1. freshness — the committed `reportPath` must equal what a fresh
 *     regeneration of the current tree produces;
 *  2. regression (strict) — per-TU metrics must not increase vs the baseline
 *     committed on the base branch (`--base <ref>`, else origin/main →
 *     origin/master → HEAD~1). New TUs are exempt; cleanup is always allowed.
 */
export function checkSmellReport(
  rows: Record<string, Record<string, number>>,
  opts: { reportPath: string; base?: string; strict: boolean; rvl?: boolean },
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const current = renderSmellReport(rows, { rvl: opts.rvl === true });
  if (existsSync(opts.reportPath)) {
    if (readFileSync(opts.reportPath, "utf8") !== current) {
      problems.push(
        `${opts.reportPath} is stale — run \`decompi report --write\` and commit the update`,
      );
    }
  } else {
    problems.push(
      `${opts.reportPath} is missing — run \`decompi report --write\` and commit it`,
    );
  }
  if (opts.strict) {
    const baseText = baseReportText(opts.base, opts.reportPath);
    if (baseText !== null) {
      const base = extractBaseline(baseText);
      const baseKeys = Object.keys(base);
      if (baseKeys.length > 0) {
        const established = new Set<string>(
          baseKeys.flatMap((p) => Object.keys(base[p]!)),
        );
        const regressions: string[] = [];
        for (const [path, metrics] of Object.entries(base).sort()) {
          const cur = rows[path];
          if (cur === undefined) continue; // TU removed — fine
          for (const { key, display } of SMELL_METRICS) {
            if (!established.has(key)) continue;
            const before = metrics[key] ?? 0;
            const after = cur[key] ?? 0;
            if (after > before) {
              regressions.push(`${path}: ${display} ${before} → ${after}`);
            }
          }
        }
        if (regressions.length > 0) {
          problems.push(
            "smell regression vs base branch baseline " +
              "(cleanup or consciously re-baseline; new TUs are exempt):\n  " +
              regressions.slice(0, 20).join("\n  ") +
              (regressions.length > 20 ? `\n  … and ${regressions.length - 20} more` : ""),
          );
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
