#!/usr/bin/env node
/**
 * Decompi CLI (SPEC §15): `status` / `select` (M0 store subset) plus `lint` /
 * `report` (M1a rule registry). Dependency-free (no commander/yargs) so the
 * logic is fully testable in-process: `runStatus` / `runSelect` / `runLint` /
 * `runReport` are exported and `main(argv)` only wires argv → those functions.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SqlAdapter } from "../core/store/adapter.js";
import type { Selector } from "../types.js";
// SqliteAdapter is a type-only import here: `node:sqlite` is an experimental
// module whose load prints an ExperimentalWarning to stderr, so it is only
// loaded (via openAndImport / cmdServe dynamic imports) by commands that
// actually touch the store — `lint` / `report` stay warning-free for CI.
import type { SqliteAdapter } from "../core/store/sqlite.js";
import { FixtureAdapter } from "../adapter/fixture.js";
import { validateSelector } from "../target/selector.js";
import { WorkItemRepo } from "../target/work-item.js";
import { exportRegistry, importRegistry, type RegistrySnapshot } from "../target/registry.js";
import {
  checkSmellReport,
  collectSourceFiles,
  formatFindings,
  lintDelta,
  lintFile,
  renderSmellReport,
  scanUnits,
  sourceRules,
  type LintConfig,
} from "../parse/cpp/registry.js";
import { deltaRules } from "../parse/cpp/delta.js";
import { matchContextFromFixture, matchRules } from "../parse/cpp/rules/match.js";
import type { Finding } from "../parse/cpp/types.js";
import { loadModels } from "../models/directory.js";
import type { RunSpec, RunRecord } from "../server/scheduler.js";
import type { LiveStack } from "./live.js";
import { MockAgentRuntime } from "../agent/mock.js";
import {
  AnalyzeTools,
  DEFAULT_ANALYZE_MODEL,
  DEFAULT_ANALYZE_MODEL_SPEC,
  runAnalysis,
} from "../server/analyze.js";
import { WorkflowStatusStore } from "../workflow/status.js";
import { Decompi } from "../workflow/facade.js";
import { MIGRATIONS } from "../core/store/migrations.js";

/** Minimal sink for CLI output (process.stdout in the bin, buffers in tests). */
export interface Output {
  write(chunk: string): unknown;
}

/**
 * Statuses treated as "done" for the status summary's `remaining` column.
 * M0 hardcodes the SPEC §7 example vocab (accepted: FULL_MATCH /
 * EQUIVALENT_MATCH, rejected: NOT_BUILDABLE / NOT_FOUND); a per-adapter
 * `StatusVocab` replaces this in a later milestone.
 */
export const DEFAULT_TERMINAL_STATUSES: readonly string[] = [
  "FULL_MATCH",
  "EQUIVALENT_MATCH",
  "NOT_BUILDABLE",
  "NOT_FOUND",
];

export const USAGE = `decompi <command> [options]

commands:
  status [--db <path>] [--fixture <path>]
      Per-unit work-item summary: unit | total | remaining | per-status counts.
  select '<selector-json>' [--db <path>] [--fixture <path>]
      Run a JSON Selector (src/types.ts) and print matching rows
      (id, symbol, status, size — one per line).
  lint <paths…> [--delta] [--json|--markdown] [--rule <id>] [--no-fail]
       [--config <path>] [--fixture <path>]
      Whole-file scan with the source rules (smell.* + ptr.* + clone.*, plus
      the match.* rules when --fixture provides accepted work items).
      Directories are walked for source files. Text output groups findings by
      rule (rule → count → path:line:col snippet) and prints "clean" with exit
      0 when nothing is found. Exit 1 when any finding is emitted (CI gate;
      --no-fail forces exit 0). --delta lints only the added lines against
      <path>.orig (whole file when no .orig exists). --rule <id> emits only
      findings of that rule id. --config loads a JSON LintConfig (placeholder
      patterns given as regex strings). --json emits ONE JSON array of
      {rule,line,column,snippet,message,path}; --markdown emits a per-file
      report table.
  report [paths…] [--json] [--config <path>]
      Whole-file scan summary: per-rule counts, then per-file counts, then the
      total (paths default to the game-code roots: src/kyoshin,
      libs/monolib/src, libs/nw4r/src). --json emits a machine-readable
      {rules, files, total} object.
      CI gate (mirror of tools/coop/smell_report.py):
        report --check [--base <ref>] [--no-strict] [--variant RVL] [--json]
            Freshness (committed docs/smells.md == fresh regeneration) + per-TU
            regression vs the base branch's committed baseline (git show
            <ref>:docs/smells.md; default origin/main → HEAD~1). Exits 1 when
            stale or regressed; --json emits the {ok, problems} verdict.
            --variant RVL scans libs/RVL_SDK/src with asm bodies stripped
            (informational, freshness-only).
        report --write [--variant RVL]
            Regenerate the committed report (docs/smells.md).
        report --completeness [--db <path>] [--fixture <path>]
            Live TU status table from the work-item registry (unit | targets |
            accepted | status), the ALL_TUS.md replacement.
  export registry [--out <path>] [--db <path>] [--fixture <path>]
      Dump the whole registry — work items + deps + capabilities — as one
      JSON snapshot (SPEC §6.3) to stdout, or to --out. Deterministic order;
      stable for git round-trips.
  import <snapshot.json> [--db <path>] [--fixture <path>]
      Restore a registry snapshot exported by \`export registry\` (ids
      preserved verbatim). One transaction: a failing item rolls back.
  analyze '<prompt>' [--run <id>] [--db <path>] [--fixture <path>]
      M4 introspection agent (SPEC §17): answer a question about runs,
      events, spans, metrics, and transcripts from the live store, printing
      the final text. --run scopes the question to one run id (injected into
      the prompt). The session runs on the deterministic mock runtime (the
      real pi SDK agent lands in M5).
  workflow set <wf> <status> --target <id> | --unit <id> [--reason …] [--db <path>]
      Set the status for one target (or every target of one unit) for
      workflow <wf> (SPEC §A.2): an UPSERT on the UNIQUE
      (workflow, unit, target) key — re-setting a scope replaces its status,
      actor "manual".
  workflow status <wf> [--unit <id> | --target <id>] [--db <path>]
      List the workflow's status rows (unit | target | status | actor |
      reason | updated_at), or only those of --unit <id> / --target <id>.
  run <wf> [--model <name>] [--budget <micro-usd>] [--target <id>]... [--unit <id>]...
      [--wait] [--db <path>] [--models <path>]
      Create a run of workflow <wf> (SPEC §6/§7): builds a RunSpec with the
      repeatable --target / --unit scope (AND-ed) and delegates to the
      Decompi facade's scheduler. When the facade is not configured (no
      embedding harness / serve), the command self-wires a LIVE stack:
      SQLite store + xenoblade targets import, the basic-match workflow,
      the real pi SDK agent runtime (models.json in cwd, or --models), and a
      RunScheduler — so decompi run basic-match --unit <TU> --model <name>
      runs end-to-end. --wait polls the run until it settles and prints the
      outcome + workflow status rows (exit 1 when the run failed). --db sets
      the SQLite path (default ./decompi.db).
  serve [--port <port>] [--db <path>] [--detached]
      M4 control plane (SPEC §15/§16): embedded store daemon + match
      pipelines + run scheduler + bearer-auth REST/WS API + the web/
      dashboard (index.html + app.js) on http://127.0.0.1:<port> (default
      8787; --port 0 picks a free port). --db defaults to ./decompi.db. A
      default dev token is provisioned and printed so the UI works out of
      the box. --detached is a no-op hint for M4 — the server runs in the
      foreground today (CI's detached daemon lands later).
  -h, --help            Show this help.

options:
  --db <path>           SQLite database (default: ./decompi.db; ":memory:" allowed).
  --fixture <path>      JSON fixture to import before the command runs
                        ({ "workItems": [ { id, kind, status, ... } ] }).
  --out <path>          export registry only: write the snapshot JSON to a
                        file instead of stdout.
  --port <port>         serve only: bind port on 127.0.0.1 (default 8787;
                        0 = ephemeral; the banner prints the real port).
  --detached            serve only: no-op hint for M4 (foreground today).
`;

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  bools: Set<string>;
}

/**
 * Flags that never take a value. `parseArgs` refuses `--<bool>=<value>` and
 * never consumes the next token for them (so `lint --delta foo.cpp` keeps
 * `foo.cpp` as a positional instead of eating it as the flag's value).
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "delta",
  "json",
  "markdown",
  "check",
  "write",
  "no-strict",
  "completeness",
  "detached",
  "no-fail",
]);

/**
 * Dependency-free flag parsing: `--flag value` and `--flag=value`. A flag in
 * `booleanFlags` is never given a value: `--delta foo.cpp` leaves `foo.cpp`
 * positional, and `--delta=1` throws instead of silently switching meaning.
 */
export function parseArgs(
  args: readonly string[],
  booleanFlags: ReadonlySet<string> = BOOLEAN_FLAGS,
): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      parsed.positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      parsed.positionals.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      const name = arg.slice(2, eq);
      if (booleanFlags.has(name)) {
        throw new Error(`--${name} does not take a value`);
      }
      parsed.values.set(name, arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("-") && !booleanFlags.has(name)) {
      parsed.values.set(name, next);
      i++;
    } else {
      parsed.bools.add(name);
    }
  }
  return parsed;
}

/** Reject any flag the command does not declare. */
function checkFlags(parsed: ParsedArgs, allowed: ReadonlySet<string>): void {
  for (const name of parsed.values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option: --${name}`);
  }
  for (const name of parsed.bools) {
    if (!allowed.has(name)) throw new Error(`unknown option: --${name}`);
  }
}

function dbAndFixture(parsed: ParsedArgs): { dbPath: string; fixturePath: string | undefined } {
  if (parsed.bools.has("db")) throw new Error("--db requires a value");
  if (parsed.bools.has("fixture")) throw new Error("--fixture requires a value");
  return {
    dbPath: parsed.values.get("db") ?? "decompi.db",
    fixturePath: parsed.values.get("fixture"),
  };
}

// ─── status ──────────────────────────────────────────────────────────────────

interface UnitSummary {
  unit: string;
  total: number;
  remaining: number;
  statuses: Map<string, number>;
}

interface UnitSummaryRow {
  unit_id: string | null;
  status: string | null;
  n: number;
}

async function summarizeUnits(adapter: SqlAdapter): Promise<UnitSummary[]> {
  const rows = await adapter.query<UnitSummaryRow>(
    `SELECT unit_id, status, COUNT(*) AS n FROM work_items GROUP BY unit_id, status`,
  );
  const byUnit = new Map<string, UnitSummary>();
  for (const row of rows) {
    const unit = row.unit_id ?? "(none)";
    let summary = byUnit.get(unit);
    if (summary === undefined) {
      summary = { unit, total: 0, remaining: 0, statuses: new Map() };
      byUnit.set(unit, summary);
    }
    summary.total += row.n;
    const status = row.status ?? "(unknown)";
    summary.statuses.set(status, (summary.statuses.get(status) ?? 0) + row.n);
  }
  const units = [...byUnit.values()].sort((a, b) => a.unit.localeCompare(b.unit));
  for (const summary of units) {
    for (const [status, count] of summary.statuses) {
      if (!DEFAULT_TERMINAL_STATUSES.includes(status)) summary.remaining += count;
    }
  }
  return units;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function renderStatusTable(units: UnitSummary[], out: Output): void {
  if (units.length === 0) {
    out.write("(no work items)\n");
    return;
  }
  const statusNames = [...new Set(units.flatMap((u) => [...u.statuses.keys()]))].sort();
  const headers = ["unit", "total", "remaining", ...statusNames];
  const rows = units.map((u) => [
    u.unit,
    String(u.total),
    String(u.remaining),
    ...statusNames.map((s) => String(u.statuses.get(s) ?? 0)),
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]!.length)),
  );
  const format = (cells: string[]): string =>
    cells.map((cell, i) => pad(cell, widths[i]!)).join("  ").trimEnd();
  out.write(format(headers) + "\n");
  for (const row of rows) out.write(format(row) + "\n");
}

/** Summarize `work_items` per unit and print the table. The caller migrates. */
export async function runStatus(adapter: SqlAdapter, out: Output = process.stdout): Promise<void> {
  renderStatusTable(await summarizeUnits(adapter), out);
}

// ─── select ─────────────────────────────────────────────────────────────────

/** Parse and shape-check a JSON `Selector` string. */
export function parseSelector(json: string): Selector {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`invalid selector JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid selector: expected a JSON object");
  }
  return validateSelector(parsed);
}

/** Run `selector` and print matching rows one per line. The caller migrates. */
export async function runSelect(
  adapter: SqlAdapter,
  selector: Selector,
  out: Output = process.stdout,
): Promise<void> {
  const repo = new WorkItemRepo(adapter);
  for (const item of await repo.list(selector)) {
    out.write(`${item.id}\t${item.symbol ?? ""}\t${item.status}\t${item.size ?? ""}\n`);
  }
}

// ─── lint / report (M1a rule registry) ───────────────────────────────────────

const PLACEHOLDER_KEYS = ["function", "class", "unknown", "label", "data"] as const;

/**
 * Compile a parsed `--config` JSON file into a `LintConfig`. JSON cannot
 * express RegExp literals, so placeholder patterns are strings compiled here;
 * unknown top-level keys are reported through `onWarning` (not silently
 * dropped), malformed values are rejected with the file path. Known keys:
 * `placeholderPatterns`, `angleIncludeWhitelist`, `match` (regex strings for
 * the fixture-backed `match.*` rule patterns).
 */
export function compileConfig(
  data: unknown,
  path: string,
  onWarning: (message: string) => void = () => {},
): LintConfig {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`invalid lint config ${path}: expected a JSON object`);
  }
  const cfg: LintConfig = {};
  const raw = data as Record<string, unknown>;
  const KNOWN_KEYS = new Set(["placeholderPatterns", "angleIncludeWhitelist", "match"]);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      onWarning(`unknown lint config key "${key}" in ${path} (ignored)`);
    }
  }
  const ppRaw = raw.placeholderPatterns;
  if (ppRaw !== undefined) {
    if (ppRaw === null || typeof ppRaw !== "object" || Array.isArray(ppRaw)) {
      throw new Error(`invalid lint config ${path}: placeholderPatterns must be an object`);
    }
    const patterns: NonNullable<LintConfig["placeholderPatterns"]> = {};
    for (const key of PLACEHOLDER_KEYS) {
      const value = (ppRaw as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new Error(
          `invalid lint config ${path}: placeholderPatterns.${key} must be a string regex`,
        );
      }
      patterns[key] = new RegExp(value);
    }
    cfg.placeholderPatterns = patterns;
  }
  const whitelist = raw.angleIncludeWhitelist;
  if (whitelist !== undefined) {
    if (!Array.isArray(whitelist) || whitelist.some((x) => typeof x !== "string")) {
      throw new Error(
        `invalid lint config ${path}: angleIncludeWhitelist must be an array of strings`,
      );
    }
    cfg.angleIncludeWhitelist = whitelist;
  }
  const matchRaw = raw.match;
  if (matchRaw !== undefined) {
    if (matchRaw === null || typeof matchRaw !== "object" || Array.isArray(matchRaw)) {
      throw new Error(`invalid lint config ${path}: match must be an object`);
    }
    const patterns: { funcPattern?: RegExp; fnPattern?: RegExp; classPattern?: RegExp } = {};
    for (const key of ["funcPattern", "fnPattern", "classPattern"] as const) {
      const value = (matchRaw as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new Error(`invalid lint config ${path}: match.${key} must be a string regex`);
      }
      patterns[key] = new RegExp(value);
    }
    cfg.match = { ...patterns };
  }
  return cfg;
}

/** Read and compile a `--config` JSON file into a `LintConfig`. */
function loadConfigFile(path: string): LintConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read lint config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid lint config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return compileConfig(data, path, (msg) => process.stderr.write(`warning: ${msg}\n`));
}

/** Read a source file, wrapping I/O errors with the path. */
function readSource(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `<path>.orig` for `--delta`, or null when it does not exist. */
function readOrig(path: string): string | null {
  try {
    return readFileSync(`${path}.orig`, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface LintRunOptions {
  /** Lint added lines only (`--delta`); whole-file scan otherwise. */
  delta?: boolean;
  /** Output format (`--json` → "json", `--markdown` → "markdown"; default "text"). */
  format?: "text" | "json" | "markdown";
  /** `--rule <id>`: emit only findings of this rule id. */
  rule?: string;
  config?: LintConfig;
}

/**
 * Source extensions picked up when a `lint` positional is a directory.
 * Explicit file paths are linted regardless of extension.
 */
const LINT_SOURCE_RE = /\.(?:cpp|cc|cxx|c|hpp|hh|hxx|h)$/i;

/**
 * Expand `lint` positionals: explicit files pass through, directories are
 * walked recursively for source files (dotfiles skipped, deterministic sort).
 * Missing paths are left for `readSource` to error on with a clear message.
 */
function expandLintPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const walkDir = (p: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const child = join(p, entry);
      let childSt;
      try {
        childSt = statSync(child);
      } catch {
        continue;
      }
      if (childSt.isDirectory()) walkDir(child);
      else if (childSt.isFile() && LINT_SOURCE_RE.test(entry)) out.push(child);
    }
  };
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      out.push(p); // missing explicit path → readSource reports it with a clear error
      continue;
    }
    if (st.isFile()) out.push(p);
    else if (st.isDirectory()) walkDir(p);
  }
  return [...new Set(out)].sort();
}

/**
 * Whole-file scan per path (`lintFile`), or the added-lines delta gate
 * (`lintDelta`) with `--delta`. Directories are walked; `--rule <id>` filters
 * to one rule. Returns the number of findings emitted (the CLI maps a
 * non-zero count to exit code 1 unless `--no-fail`).
 *
 * Text output is grouped by rule — `rule: count` headers with
 * `path:line:col  snippet` rows — and prints a `clean:` line when nothing was
 * found. `--json` emits ONE valid JSON document: a flat array of
 * `{rule, line, column, snippet, message, path}` (column/snippet are null when
 * absent), so a multi-file scan pipes cleanly. `--markdown` emits a per-file
 * report table (`## path` + rule/line/column/snippet/message columns).
 */
export async function runLint(
  paths: readonly string[],
  opts: LintRunOptions = {},
  out: Output = process.stdout,
): Promise<number> {
  const expanded = expandLintPaths(paths);
  const rule = opts.rule;
  const results: Array<{ path: string; findings: Finding[] }> = [];
  let total = 0;
  for (const path of expanded) {
    const source = readSource(path);
    const findings: Finding[] = (opts.delta === true
      ? lintDelta(path, readOrig(path), source, opts.config)
      : lintFile(path, source, opts.config)
    ).filter((f) => rule === undefined || f.rule === rule);
    total += findings.length;
    results.push({ path, findings });
  }
  const fmt = opts.format ?? "text";
  if (fmt === "json") {
    out.write(
      JSON.stringify(
        results.flatMap(({ path, findings }) =>
          findings.map((f) => ({
            rule: f.rule,
            line: f.line,
            column: f.column ?? null,
            snippet: f.snippet ?? null,
            message: f.message,
            path,
          })),
        ),
        null,
        2,
      ) + "\n",
    );
    return total;
  }
  if (fmt === "markdown") {
    if (total === 0) {
      out.write("No findings.\n");
      return total;
    }
    for (const { path, findings } of results) {
      if (findings.length === 0) continue;
      out.write(`## ${path}\n\n`);
      out.write(formatFindings(findings, "markdown") + "\n\n");
    }
    return total;
  }
  if (total === 0) {
    out.write(`clean: no findings in ${results.length} file(s)\n`);
    return total;
  }
  // Text: grouped by rule across all files (rule → count → path:line:col snippet).
  const groups = new Map<string, Array<{ path: string; f: Finding }>>();
  for (const { path, findings } of results) {
    for (const f of findings) {
      const group = groups.get(f.rule);
      if (group === undefined) groups.set(f.rule, [{ path, f }]);
      else group.push({ path, f });
    }
  }
  for (const ruleId of [...groups.keys()].sort()) {
    const group = groups.get(ruleId)!;
    out.write(`${ruleId}: ${group.length}\n`);
    for (const { path, f } of group) {
      const loc = f.column !== undefined ? `${f.line}:${f.column}` : `${f.line}`;
      const detail = f.snippet !== undefined && f.snippet.length > 0 ? f.snippet : f.message;
      out.write(`  ${path}:${loc}  ${detail}\n`);
    }
  }
  return total;
}

export interface ReportRunOptions {
  json?: boolean;
  config?: LintConfig;
}

/**
 * Expand `report` positionals: explicit files pass through, directories are
 * walked with TU semantics (`.cpp`, mirroring the gate), and no paths defaults
 * to `DEFAULT_ROOTS`. Explicit missing paths error clearly; default roots that
 * do not exist on another repo are skipped silently (like `scanUnits`).
 */
function expandReportPaths(paths: readonly string[]): string[] {
  const explicit = paths.length > 0;
  const roots = explicit ? [...paths] : [...DEFAULT_ROOTS];
  const out = new Set<string>();
  for (const p of roots) {
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      if (explicit) {
        throw new Error(`cannot read ${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue; // default root absent on this repo — skip
    }
    if (st.isFile()) out.add(p);
    else if (st.isDirectory()) {
      for (const f of collectSourceFiles([p], false)) out.add(f);
    }
  }
  return [...out].sort();
}

/**
 * Whole-file scan summary: per-rule counts, then per-file counts, then the
 * total (SPEC §13.4 report). `--json` emits
 * `{ "rules": {id: n}, "files": {path: n}, "total": n }`. Directories are
 * walked; unreadable files are skipped (deterministic, mirrors `scanUnits`).
 */
export async function runReport(
  paths: readonly string[],
  opts: ReportRunOptions = {},
  out: Output = process.stdout,
): Promise<void> {
  const ruleCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  let total = 0;
  for (const path of expandReportPaths(paths)) {
    let findings: Finding[];
    try {
      findings = lintFile(path, readSource(path), opts.config);
    } catch {
      continue; // unreadable files are skipped (deterministic)
    }
    fileCounts.set(path, findings.length);
    for (const f of findings) {
      ruleCounts.set(f.rule, (ruleCounts.get(f.rule) ?? 0) + 1);
      total++;
    }
  }
  const byName = (a: string, b: string): number => a.localeCompare(b);
  if (opts.json === true) {
    out.write(
      JSON.stringify(
        {
          rules: Object.fromEntries([...ruleCounts.entries()].sort(([a], [b]) => byName(a, b))),
          files: Object.fromEntries([...fileCounts.entries()].sort(([a], [b]) => byName(a, b))),
          total,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  out.write("by rule:\n");
  if (ruleCounts.size === 0) out.write("  (none)\n");
  for (const [rule, n] of [...ruleCounts.entries()].sort(([a], [b]) => byName(a, b))) {
    out.write(`  ${rule.padEnd(40)}${n}\n`);
  }
  out.write("\nby file:\n");
  if (fileCounts.size === 0) out.write("  (none)\n");
  for (const [path, n] of [...fileCounts.entries()].sort(([a], [b]) => byName(a, b))) {
    out.write(`  ${path.padEnd(40)}${n}\n`);
  }
  out.write(`\ntotal findings: ${total}\n`);
}

/** Read a fixture JSON of work items (M1a `match.*` fixture-backed source). */
function loadFixtureWorkItems(path: string): Array<{
  id: string;
  status: string;
  symbol?: string;
  unitId?: string;
  source?: string;
  meta?: Record<string, unknown>;
}> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read fixture ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid fixture ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : (parsed as { workItems?: unknown } | null)?.workItems;
  if (!Array.isArray(entries)) {
    throw new Error(`fixture ${path}: expected { "workItems": [...] } or a bare array`);
  }
  return entries as Array<{
    id: string;
    status: string;
    symbol?: string;
    unitId?: string;
    source?: string;
    meta?: Record<string, unknown>;
  }>;
}

/** Require a value flag to have actually received a value. */
function requireValueFlag(parsed: ParsedArgs, name: string): void {
  if (parsed.bools.has(name)) throw new Error(`--${name} requires a value`);
}

/** `decompi lint --help` text. */
const LINT_HELP = `decompi lint <paths…> [options]

Whole-file scan with the source rules (smell.*, ptr.*, clone.*, plus the
match.* rules when --fixture provides accepted work items). Directories are
walked for source files (.cpp/.cc/.cxx/.c/.hpp/.hh/.hxx/.h); explicit files
are linted regardless of extension.

Default text output groups findings by rule:

    smell.void_ptr: 2
      src/a.cpp:4:3  void* p
      src/a.cpp:8:5  void* q

"clean: no findings in N file(s)" is printed (exit 0) when nothing is found.

exit codes:
  0  clean (no findings emitted) or --no-fail
  1  at least one finding emitted (CI gate)

options:
  --delta          lint only the added lines against <path>.orig; without a
                   <path>.orig the whole file is treated as added
  --rule <id>      emit only findings of that rule id (e.g. smell.void_ptr,
                   no_angle_include); unknown ids warn on stderr
  --json           emit ONE JSON array of
                   {rule,line,column,snippet,message,path} (one entry per
                   finding, all files in a single document)
  --markdown       emit a per-file report table (## path + a
                   rule | line | column | snippet | message table)
  --no-fail        force exit 0 even when findings are emitted
  --config <path>  JSON LintConfig (placeholder patterns as regex strings)
  --fixture <path> JSON fixture of accepted work items (match.* rules)
  --help           show this help
`;

/** Rule ids the linter can ever emit (whole-file + delta + match.* families). */
function knownRuleIds(cfg: LintConfig): Set<string> {
  const ids = new Set(sourceRules.map((r) => r.id));
  for (const r of deltaRules) ids.add(r.id);
  if (cfg.match !== undefined) {
    for (const r of matchRules(cfg.match)) ids.add(r.id);
  }
  return ids;
}

async function cmdLint(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(LINT_HELP);
    return 0;
  }
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["delta", "json", "markdown", "rule", "no-fail", "config", "fixture"]));
  requireValueFlag(parsed, "config");
  requireValueFlag(parsed, "fixture");
  requireValueFlag(parsed, "rule");
  if (parsed.positionals.length === 0) {
    throw new Error("lint requires at least one path");
  }
  const configPath = parsed.values.get("config");
  const cfg = configPath !== undefined ? loadConfigFile(configPath) : {};
  const fixturePath = parsed.values.get("fixture");
  if (fixturePath !== undefined) {
    const context = matchContextFromFixture(loadFixtureWorkItems(fixturePath));
    // Merge config-supplied match patterns (regexes) with the fixture context.
    cfg.match = { ...cfg.match, ...context };
  }
  const rule = parsed.values.get("rule");
  if (rule !== undefined && !knownRuleIds(cfg).has(rule)) {
    process.stderr.write(
      `decompi: warning: --rule ${rule} matches no known rule — no findings will be emitted\n`,
    );
  }
  const fmt: "text" | "json" | "markdown" = parsed.bools.has("markdown")
    ? "markdown"
    : parsed.bools.has("json")
      ? "json"
      : "text";
  const findings = await runLint(parsed.positionals, {
    delta: parsed.bools.has("delta"),
    format: fmt,
    rule,
    config: cfg,
  });
  // CI gate: any emitted finding fails the run unless --no-fail.
  if (findings > 0 && !parsed.bools.has("no-fail")) return 1;
  return 0;
}

/** Game-code scan roots (cwd-relative), mirroring smell_report.py ROOTS. */
const DEFAULT_ROOTS = ["src/kyoshin", "libs/monolib/src", "libs/nw4r/src"];
const RVL_ROOT = "libs/RVL_SDK/src";
const REPORT_DOC = "docs/smells.md";
const RVL_REPORT_DOC = "docs/smells-rvl.md";

/** Statuses counted as accepted for the completeness table (mirrors smell_report.py). */
const ACCEPTED_STATUSES = new Set(["FULL_MATCH", "EQUIVALENT_MATCH"]);

/** Print the `report --completeness` TU status table (live, from the store). */
async function runCompleteness(adapter: SqlAdapter, out: Output): Promise<void> {
  const rows = await adapter.query<{ unit_id: string | null; status: string | null; n: number }>(
    `SELECT unit_id, status, COUNT(*) AS n FROM work_items GROUP BY unit_id, status`,
  );
  const byUnit = new Map<string, { total: number; accepted: number; statuses: string[] }>();
  for (const row of rows) {
    const unit = row.unit_id ?? "(none)";
    let cur = byUnit.get(unit);
    if (cur === undefined) {
      cur = { total: 0, accepted: 0, statuses: [] };
      byUnit.set(unit, cur);
    }
    cur.total += row.n;
    const status = row.status ?? "(unknown)";
    if (ACCEPTED_STATUSES.has(status)) cur.accepted += row.n;
    cur.statuses.push(status);
  }
  const units = [...byUnit.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  out.write(`# TU status (live, from the work-item registry) — ${units.length} units\n\n`);
  out.write("| TU | targets | accepted | status |\n");
  out.write("|---|---|---|---|\n");
  let complete = 0;
  for (const [unit, cur] of units) {
    const { total, accepted } = cur;
    let state: string;
    if (accepted === total) {
      state = "COMPLETE";
      complete++;
    } else if (accepted > 0) {
      state = `PARTIAL (${accepted}/${total})`;
    } else if (!existsSync(join(process.cwd(), "src", `${unit}.cpp`))) {
      state = "NO SOURCE";
    } else {
      state = "NOT_STARTED";
    }
    out.write(`| ${unit} | ${total} | ${accepted} | ${state} |\n`);
  }
  out.write(`\nComplete TUs: ${complete}\n`);
}

/** `decompi report --help` text. */
const REPORT_HELP = `decompi report [paths…] [options]

Whole-file scan summary: per-rule counts, then per-file counts, then the
total. With no paths, the game-code roots (src/kyoshin, libs/monolib/src,
libs/nw4r/src) are scanned; explicit paths may be files or directories.

options:
  --json          emit a machine-readable {rules, files, total} object
  --config <path> JSON LintConfig
  --help          show this help

CI gate (mirror of tools/coop/smell_report.py):
  report --check [--base <ref>] [--no-strict] [--variant RVL] [--json]
      Freshness: the committed docs/smells.md must equal a fresh
      regeneration. Regression (strict, default): per-TU metrics must not
      increase vs the baseline committed on the base branch (git show
      <ref>:docs/smells.md; default origin/main → origin/master → HEAD~1).
      New TUs are exempt; cleanup is always allowed. Exit 0 when the gate
      passes, 1 when stale or regressed; --json emits the {ok, problems}
      verdict.
  report --write [--variant RVL]
      Regenerate docs/smells.md from the current tree.
  report --completeness [--db <path>] [--fixture <path>]
      Live TU status table from the work-item registry (unit | targets |
      accepted | status).

exit codes:
  0  gate passed / summary written
  1  --check failed (stale doc or per-TU regression vs base)
`;

async function cmdReport(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(REPORT_HELP);
    return 0;
  }
  const parsed = parseArgs(args);
  checkFlags(
    parsed,
    new Set(["json", "check", "write", "no-strict", "base", "variant", "completeness", "config", "db", "fixture"]),
  );
  requireValueFlag(parsed, "base");
  requireValueFlag(parsed, "variant");
  requireValueFlag(parsed, "config");
  requireValueFlag(parsed, "db");
  requireValueFlag(parsed, "fixture");

  if (parsed.bools.has("completeness")) {
    const { dbPath, fixturePath } = dbAndFixture(parsed);
    const adapter = await openAndImport(dbPath, fixturePath);
    try {
      await runCompleteness(adapter, process.stdout);
    } finally {
      adapter.close();
    }
    return 0;
  }

  const write = parsed.bools.has("write");
  const check = parsed.bools.has("check");
  if (write && check) {
    throw new Error("--write and --check are mutually exclusive");
  }
  const variant = parsed.values.get("variant");
  if (variant !== undefined && variant !== "RVL") {
    throw new Error(`unknown variant: ${variant} (expected RVL)`);
  }
  const isRvl = variant === "RVL";
  const json = parsed.bools.has("json");

  if (check || write) {
    const paths =
      parsed.positionals.length > 0
        ? parsed.positionals
        : isRvl
          ? [RVL_ROOT]
          : DEFAULT_ROOTS;
    const configPath = parsed.values.get("config");
    const config =
      configPath !== undefined
        ? loadConfigFile(configPath)
        : undefined;
    const result = runReportGate(
      paths,
      {
        check,
        write,
        base: parsed.values.get("base"),
        strict: !parsed.bools.has("no-strict"),
        variant: isRvl ? "rvl" : "game",
        config,
        json,
      },
      process.stdout,
    );
    return result.ok ? 0 : 1;
  }

  const configPath = parsed.values.get("config");
  const config =
    configPath !== undefined
      ? loadConfigFile(configPath)
      : undefined;
  await runReport(parsed.positionals, { json, config });
  return 0;
}

/** Outcome of the report gate: verdict + problems + which doc was touched. */
interface ReportGateResult {
  ok: boolean;
  problems: string[];
  reportPath: string;
}

/**
 * The report gate (--write / --check): scan the roots, render, and compare.
 * `--write` regenerates the committed doc; `--check` runs the freshness +
 * regression gate (mirror of smell_report.py) and exits non-zero when the
 * doc is stale or a per-TU metric regressed vs the base baseline. `--json`
 * emits the machine-readable verdict instead of prose.
 */
export function runReportGate(
  paths: readonly string[],
  opts: {
    check: boolean;
    write: boolean;
    base?: string;
    strict: boolean;
    variant: "game" | "rvl";
    config?: LintConfig;
    json?: boolean;
  },
  out: Output = process.stdout,
): ReportGateResult {
  const reportPath = opts.variant === "rvl" ? RVL_REPORT_DOC : REPORT_DOC;
  const rows = scanUnits(paths, {
    skipAsmBodies: opts.variant === "rvl",
    includeC: opts.variant === "rvl",
  });
  const md = renderSmellReport(rows, { rvl: opts.variant === "rvl" });
  if (opts.write) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, md);
    if (opts.json === true) {
      out.write(JSON.stringify({ ok: true, wrote: reportPath }, null, 2) + "\n");
    } else {
      out.write(`wrote ${reportPath}\n`);
    }
    return { ok: true, problems: [], reportPath };
  }
  const result = checkSmellReport(rows, {
    reportPath,
    base: opts.base,
    strict: opts.strict,
    rvl: opts.variant === "rvl",
  });
  if (opts.json === true) {
    out.write(JSON.stringify({ ok: result.ok, problems: result.problems }, null, 2) + "\n");
  } else {
    for (const problem of result.problems) {
      out.write(`ERROR: ${problem}\n`);
    }
    if (result.ok) {
      out.write(`ok: ${reportPath} is fresh and no per-TU smell regression vs base.\n`);
    } else {
      out.write("\n--check failed.\n");
    }
  }
  return { ok: result.ok, problems: result.problems, reportPath };
}

/**
 * The report gate (--write / --check): scan the roots, render, and compare.
 * `--write` regenerates the committed doc; `--check` runs the freshness +
 * regression gate (mirror of smell_report.py). Returns whether the gate
 * passed (`--check`), always true for `--write` (the doc was regenerated).
 */
export function runReportCheck(
  paths: readonly string[],
  opts: {
    check: boolean;
    write: boolean;
    base?: string;
    strict: boolean;
    variant: "game" | "rvl";
    config?: LintConfig;
  },
  out: Output = process.stdout,
): boolean {
  return runReportGate(
    paths,
    { ...opts, json: false },
    out,
  ).ok;
}

// ─── workflow status ladder (SPEC §A.2/A.5) + run (SPEC §6/§7) ────────────

/**
 * Collect every value of a repeatable value flag (`--name v1 --name v2` and
 * `--name=v` both work). `parseArgs` keeps only the LAST value per flag name,
 * so repeatable flags (SPEC §6: `--target` / `--unit`) are collected here
 * from the raw argv instead. Stops at the `--` positional separator.
 */
export function collectRepeatedValues(args: readonly string[], name: string): string[] {
  const flag = `--${name}`;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith(`${flag}=`)) {
      out.push(arg.slice(flag.length + 1));
    } else if (arg === flag) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`--${name} requires a value`);
      }
      out.push(next);
      i++;
    }
  }
  return out;
}

/** Open the store (like cmdStatus) and wrap a status store over it. */
async function openStatuses(
  parsed: ParsedArgs,
): Promise<{ adapter: SqliteAdapter; store: WorkflowStatusStore }> {
  const { dbPath, fixturePath } = dbAndFixture(parsed);
  const adapter = await openAndImport(dbPath, fixturePath);
  return { adapter, store: new WorkflowStatusStore(adapter) };
}

/** Require exactly one of `--target <id>` / `--unit <id>`; return the scope. */
function targetOrUnit(
  parsed: ParsedArgs,
  verb: string,
): { targetId?: string; unitId?: string } {
  const targetId = parsed.values.get("target");
  const unitId = parsed.values.get("unit");
  if ((targetId === undefined) === (unitId === undefined)) {
    throw new Error(
      `workflow ${verb} requires exactly one of --target <id> or --unit <id>`,
    );
  }
  return targetId !== undefined ? { targetId } : { unitId: unitId! };
}

/** `workflow set <wf> <status> --target <id> | --unit <id> [--reason …]`. */
export async function runWorkflowSet(
  store: WorkflowStatusStore,
  workflowId: string,
  status: string,
  opts: { targetId?: string; unitId?: string; reason?: string } = {},
  out: Output = process.stdout,
): Promise<void> {
  await store.setStatus({
    workflowId,
    status,
    ...(opts.targetId !== undefined ? { targetId: opts.targetId } : {}),
    ...(opts.unitId !== undefined ? { unitId: opts.unitId } : {}),
    actor: "manual",
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  });
  const what = opts.targetId ?? opts.unitId;
  out.write(`set ${what} to ${status} for workflow ${workflowId}\n`);
}

/** `workflow status <wf> [--unit <id> | --target <id>]` — one line per status row. */
export async function runWorkflowStatus(
  store: WorkflowStatusStore,
  workflowId: string,
  opts: { unit?: string; target?: string } = {},
  out: Output = process.stdout,
): Promise<void> {
  const rows = await store.list(workflowId);
  const filtered = rows.filter(
    (r) =>
      (opts.unit === undefined || r.unitId === opts.unit) &&
      (opts.target === undefined || r.targetId === opts.target),
  );
  if (filtered.length === 0) {
    const scope =
      opts.unit !== undefined || opts.target !== undefined
        ? ` (${[opts.unit !== undefined ? `unit ${opts.unit}` : "", opts.target !== undefined ? `target ${opts.target}` : ""].filter(Boolean).join(", ")})`
        : "";
    out.write(`no status rows for workflow ${workflowId}${scope}\n`);
    return;
  }
  out.write(`workflow ${workflowId} — ${filtered.length} status row(s)\n`);
  for (const row of filtered) {
    out.write(
      `${row.updatedAt}\t${row.unitId || "-"}\t${row.targetId || "-"}\t${row.status}\t${row.actor}\t${row.reason ?? ""}\n`,
    );
  }
}

async function cmdWorkflowSet(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["target", "unit", "reason", "db", "fixture"]));
  requireValueFlag(parsed, "target");
  requireValueFlag(parsed, "unit");
  requireValueFlag(parsed, "reason");
  requireValueFlag(parsed, "db");
  requireValueFlag(parsed, "fixture");
  if (parsed.positionals.length !== 2) {
    throw new Error("workflow set requires exactly two arguments: <workflow-id> <status>");
  }
  const { targetId, unitId } = targetOrUnit(parsed, "set");
  const { adapter, store } = await openStatuses(parsed);
  try {
    await runWorkflowSet(store, parsed.positionals[0]!, parsed.positionals[1]!, {
      ...(targetId !== undefined ? { targetId } : {}),
      ...(unitId !== undefined ? { unitId } : {}),
      ...(parsed.values.get("reason") !== undefined
        ? { reason: parsed.values.get("reason") }
        : {}),
    });
  } finally {
    adapter.close();
  }
}

async function cmdWorkflowStatus(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["unit", "target", "db", "fixture"]));
  requireValueFlag(parsed, "unit");
  requireValueFlag(parsed, "target");
  requireValueFlag(parsed, "db");
  requireValueFlag(parsed, "fixture");
  if (parsed.positionals.length !== 1) {
    throw new Error("workflow status requires exactly one argument: <workflow-id>");
  }
  const { adapter, store } = await openStatuses(parsed);
  try {
    await runWorkflowStatus(store, parsed.positionals[0]!, {
      ...(parsed.values.get("unit") !== undefined
        ? { unit: parsed.values.get("unit") }
        : {}),
      ...(parsed.values.get("target") !== undefined
        ? { target: parsed.values.get("target") }
        : {}),
    });
  } finally {
    adapter.close();
  }
}

async function cmdWorkflow(args: readonly string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "set":
      return cmdWorkflowSet(args.slice(1));
    case "status":
      return cmdWorkflowStatus(args.slice(1));
    default:
      throw new Error(
        `unknown workflow subcommand: ${sub ?? "(none)"} (expected set | status)`,
      );
  }
}

/**
 * `run <wf> [--model name] [--budget $] [--target id]... [--unit id]...
 * [--wait] [--db <path>] [--models <path>]` (SPEC §6/§7): build the `RunSpec`
 * (scope AND-ed from the repeatable target/unit flags) and delegate to the
 * configured `Decompi` facade. An unconfigured facade (no embedding harness
 * / serve) self-wires a LIVE stack via `configureLiveDecompi` — SQLite store
 * + xenoblade targets import, the `basic-match` workflow, the real pi SDK
 * agent runtime (models.json), and a RunScheduler — so `decompi run
 * basic-match --unit <TU> --model <name>` works end-to-end out of the box.
 * `--wait` polls the run until it settles and prints the outcome + workflow
 * status rows (exit 1 when the run failed).
 */
async function cmdRun(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["model", "budget", "target", "unit", "wait", "db", "models"]));
  requireValueFlag(parsed, "model");
  requireValueFlag(parsed, "budget");
  requireValueFlag(parsed, "db");
  requireValueFlag(parsed, "models");
  if (parsed.positionals.length !== 1) {
    throw new Error("run requires exactly one argument: <workflow-id>");
  }
  const workflowId = parsed.positionals[0]!;
  const model = parsed.values.get("model");
  if (model === undefined) throw new Error("run requires --model <name>");
  const budgetRaw = parsed.values.get("budget");
  let budgetMicroUsd: number | undefined;
  if (budgetRaw !== undefined) {
    if (!/^\d+$/.test(budgetRaw)) {
      throw new Error(`invalid --budget: ${budgetRaw} (expected a non-negative integer)`);
    }
    budgetMicroUsd = Number(budgetRaw);
  }
  const wait = parsed.bools.has("wait");
  // SPEC §6: repeatable --target / --unit, AND-ed into the run scope.
  const scope = {
    targetIds: collectRepeatedValues(args, "target"),
    unitIds: collectRepeatedValues(args, "unit"),
  };
  const spec: RunSpec = {
    pipeline: workflowId,
    model,
    ...(budgetMicroUsd !== undefined ? { budgetMicroUsd } : {}),
    scope,
  };
  // The facade may already be configured (embedding harness / serve): in
  // that case run on the host's stack. Otherwise self-wire the live stack.
  let stack: LiveStack | null = null;
  let runId: string;
  try {
    runId = await Decompi.run(spec);
  } catch (err) {
    if (!/before run\(\)/.test(err instanceof Error ? err.message : String(err))) {
      throw err;
    }
    // Lazy import: `node:sqlite` prints an ExperimentalWarning on load, so
    // the lint/report hot paths must never pull it in statically.
    const { configureLiveDecompi } = await import("./live.js");
    stack = await configureLiveDecompi({
      ...(parsed.values.get("db") !== undefined
        ? { dbPath: parsed.values.get("db") }
        : {}),
      ...(parsed.values.get("models") !== undefined
        ? { modelsPath: parsed.values.get("models") }
        : {}),
    });
    runId = await Decompi.run(spec);
  }
  process.stdout.write(`run ${runId} created (pipeline ${workflowId}, model ${model})\n`);
  if (!wait) return;
  // `stack` is non-null here: the only path that reaches --wait without a
  // configured facade is the self-wired branch that assigned it.
  const live = stack!;
  const { waitForRun } = await import("./live.js");
  const record = await waitForRun(live.scheduler, runId, {
    onTick: (r: RunRecord) => {
      if (r.status !== "queued" && r.status !== "running") return;
      process.stdout.write(`run ${runId}: ${r.status} (since ${r.startedAt ?? r.createdAt})\n`);
    },
  });
  process.stdout.write(
    `run ${runId}: ${record.status} (finished ${record.finishedAt ?? "-"})\n`,
  );
  if (record.status !== "done") {
    throw new Error(
      `run ${runId} did not complete (status ${record.status}) — check events/transcripts for the failure`,
    );
  }
  const { WorkflowStatusStore } = await import("../workflow/status.js");
  const statuses = new WorkflowStatusStore(live.adapter);
  const rows = await statuses.list(workflowId);
  const scoped = rows.filter(
    (r) =>
      (scope.unitIds.length === 0 || (r.unitId !== undefined && scope.unitIds.includes(r.unitId))) &&
      (scope.targetIds.length === 0 || (r.targetId !== undefined && scope.targetIds.includes(r.targetId))),
  );
  if (scoped.length === 0) {
    process.stdout.write(`no workflow status rows for ${workflowId} in the run scope\n`);
  } else {
    process.stdout.write(`workflow ${workflowId} — ${scoped.length} status row(s)\n`);
    for (const row of scoped) {
      process.stdout.write(
        `${row.updatedAt}\t${row.unitId || "-"}\t${row.targetId || "-"}\t${row.status}\t${row.actor}\t${row.reason ?? ""}\n`,
      );
    }
  }
}

// ─── wiring ──────────────────────────────────────────────────────────────────

async function openAndImport(
  dbPath: string,
  fixturePath: string | undefined,
): Promise<SqliteAdapter> {
  // Lazy: `node:sqlite` is experimental and prints an ExperimentalWarning on
  // load, so only commands that actually touch the store pay for it (lint /
  // report stay warning-free). The static import is type-only.
  const { SqliteAdapter } = await import("../core/store/sqlite.js");
  const adapter = new SqliteAdapter(dbPath);
  try {
    await adapter.migrate([...MIGRATIONS]);
    if (fixturePath !== undefined) {
      await new FixtureAdapter(fixturePath).importWorkItems({ store: adapter });
    }
  } catch (err) {
    adapter.close();
    throw err;
  }
  return adapter;
}

async function cmdStatus(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["db", "fixture"]));
  if (parsed.positionals.length > 0) {
    throw new Error(`status takes no arguments (got: ${parsed.positionals.join(" ")})`);
  }
  const { dbPath, fixturePath } = dbAndFixture(parsed);
  const adapter = await openAndImport(dbPath, fixturePath);
  try {
    await runStatus(adapter);
  } finally {
    adapter.close();
  }
}

async function cmdSelect(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["db", "fixture"]));
  if (parsed.positionals.length !== 1) {
    throw new Error("select requires exactly one argument: '<selector-json>'");
  }
  const selector = parseSelector(parsed.positionals[0]!);
  const { dbPath, fixturePath } = dbAndFixture(parsed);
  const adapter = await openAndImport(dbPath, fixturePath);
  try {
    await runSelect(adapter, selector);
  } finally {
    adapter.close();
  }
}

// ─── export / import (M2 registry snapshot, SPEC §6.3 / §15) ───────────────

/** `export registry [--out path]`: dump the whole registry as one JSON snapshot. */
async function cmdExport(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["out", "db", "fixture"]));
  requireValueFlag(parsed, "out");
  requireValueFlag(parsed, "db");
  requireValueFlag(parsed, "fixture");
  const kind = parsed.positionals[0];
  if (kind !== "registry") {
    throw new Error(`unknown export kind: ${kind ?? "(none)"} (only "registry" is implemented)`);
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`export registry takes no extra arguments (got: ${parsed.positionals.slice(1).join(" ")})`);
  }
  const { dbPath, fixturePath } = dbAndFixture(parsed);
  const adapter = await openAndImport(dbPath, fixturePath);
  try {
    const snapshot = await exportRegistry(adapter);
    const json = JSON.stringify(snapshot, null, 2) + "\n";
    const outPath = parsed.values.get("out");
    if (outPath !== undefined) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, json);
      process.stdout.write(`wrote ${outPath}\n`);
    } else {
      process.stdout.write(json);
    }
  } finally {
    adapter.close();
  }
}

/** Read + parse a snapshot JSON file (wrapping I/O errors with the path). */
function readSnapshotFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read snapshot ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid snapshot ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `import <snapshot.json>`: restore the registry, ids preserved. */
async function cmdImport(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["db", "fixture"]));
  if (parsed.positionals.length !== 1) {
    throw new Error("import requires exactly one argument: <snapshot.json>");
  }
  const { dbPath, fixturePath } = dbAndFixture(parsed);
  const adapter = await openAndImport(dbPath, fixturePath);
  try {
    const result = await importRegistry(adapter, readSnapshotFile(parsed.positionals[0]!) as RegistrySnapshot);
    process.stdout.write(`imported ${result.inserted} work items\n`);
  } finally {
    adapter.close();
  }
}

// ─── analyze (M4 introspection agent, SPEC §17) ────────────────────────────

/**
 * Run the introspection agent over the store and print the final text.
 * `--run` scopes the question to one run id (injected into the prompt — the
 * agent itself reads the run's rows via its tools). The caller migrates.
 */
export async function runAnalyze(
  adapter: SqlAdapter,
  prompt: string,
  opts: { runId?: string } = {},
  out: Output = process.stdout,
): Promise<void> {
  const tools = new AnalyzeTools(adapter);
  const rt = new MockAgentRuntime({ [DEFAULT_ANALYZE_MODEL]: DEFAULT_ANALYZE_MODEL_SPEC });
  const effective =
    opts.runId !== undefined ? `[run ${opts.runId}] ${prompt}` : prompt;
  out.write((await runAnalysis(rt, tools, effective)) + "\n");
}

async function cmdAnalyze(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["db", "fixture", "run"]));
  requireValueFlag(parsed, "db");
  requireValueFlag(parsed, "fixture");
  requireValueFlag(parsed, "run");
  if (parsed.positionals.length !== 1) {
    throw new Error("analyze requires exactly one argument: '<prompt>'");
  }
  const { dbPath, fixturePath } = dbAndFixture(parsed);
  const adapter = await openAndImport(dbPath, fixturePath);
  try {
    await runAnalyze(adapter, parsed.positionals[0]!, {
      runId: parsed.values.get("run"),
    });
  } finally {
    adapter.close();
  }
}

// ─── serve (M4 control plane, SPEC §15/§16) ────────────────────────────────

/** Default dev token id provisioned by `serve` so the dashboard works out of the box. */
const SERVE_DEV_TOKEN_ID = "dev";
/** Default dev token secret provisioned by `serve` (printed in the banner). */
const SERVE_DEV_TOKEN_SECRET = "decompi-dev-token";

async function cmdServe(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["port", "db", "detached"]));
  requireValueFlag(parsed, "port");
  requireValueFlag(parsed, "db");
  if (parsed.positionals.length > 0) {
    throw new Error(`serve takes no arguments (got: ${parsed.positionals.join(" ")})`);
  }
  const portRaw = parsed.values.get("port");
  let port: number | undefined;
  if (portRaw !== undefined) {
    if (!/^\d+$/.test(portRaw) || Number(portRaw) > 65535) {
      throw new Error(`invalid --port: ${portRaw} (expected 0-65535)`);
    }
    port = Number(portRaw);
  }
  // --detached is a no-op hint for M4: the daemon runs in the foreground
  // today. CI's detached `decompi serve` (SPEC §5: "CI starts a detached one")
  // lands with the worker-protocol milestone; nothing changes behaviour yet.
  // startServer is loaded lazily: it pulls in `node:sqlite`, whose load prints
  // an ExperimentalWarning to stderr — kept off the lint/report hot paths.
  const { startServer } = await import("../server/serve.js");
  const { close } = await startServer({
    ...(port !== undefined ? { port } : {}),
    dbPath: parsed.values.get("db") ?? "decompi.db",
    authTokens: [{ id: SERVE_DEV_TOKEN_ID, secret: SERVE_DEV_TOKEN_SECRET }],
  });
  process.stdout.write(
    `decompi: dev token: ${SERVE_DEV_TOKEN_SECRET} (id: ${SERVE_DEV_TOKEN_ID})\n`,
  );
  // Graceful shutdown: SIGINT/SIGTERM close the API server, scheduler,
  // daemon, and store, then exit. While up, the listener keeps the event
  // loop alive (the server never returns from main() by itself).
  const shutdown = (): void => {
    void close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(
          `decompi: shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdModels(args: readonly string[]): Promise<void> {
  const sub = args[0];
  const path = args[1] ?? "models.json";
  if (!existsSync(path)) {
    throw new Error(`models file not found: ${path}`);
  }
  const entries = loadModels(JSON.parse(readFileSync(path, "utf-8")));
  if (sub === "list") {
    for (const e of entries) {
      process.stdout.write(`${e.name}\t${e.spec.provider}/${e.spec.model}\t${e.spec.thinkingLevel}\n`);
    }
  } else if (sub === "validate") {
    process.stdout.write(`ok: ${entries.length} model(s) valid\n`);
  } else {
    throw new Error("usage: decompi models <list|validate> [path]");
  }
}

/**
 * Run the CLI. Returns the process exit code (the bin entry maps it onto
 * `process.exitCode`): 0 normally, 1 when `lint` emitted findings (unless
 * `--no-fail`) or when the `report --check` gate failed. Errors throw and
 * are caught by the bin entry, which also exits 1.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (command) {
    case "status":
      await cmdStatus(argv.slice(1));
      return 0;
    case "select":
      await cmdSelect(argv.slice(1));
      return 0;
    case "lint":
      return cmdLint(argv.slice(1));
    case "report":
      return cmdReport(argv.slice(1));
    case "export":
      await cmdExport(argv.slice(1));
      return 0;
    case "import":
      await cmdImport(argv.slice(1));
      return 0;
    case "analyze":
      await cmdAnalyze(argv.slice(1));
      return 0;
    case "workflow":
      await cmdWorkflow(argv.slice(1));
      return 0;
    case "run":
      await cmdRun(argv.slice(1));
      return 0;
    case "models":
      await cmdModels(argv.slice(1));
      return 0;
    case "serve":
      await cmdServe(argv.slice(1));
      return 0;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`decompi: ${message}`);
      console.error("Run 'decompi --help' for usage.");
      process.exitCode = 1;
    });
}
