#!/usr/bin/env node
/**
 * Decompi CLI (SPEC §15): `status` / `select` (M0 store subset) plus `lint` /
 * `report` (M1a rule registry). Dependency-free (no commander/yargs) so the
 * logic is fully testable in-process: `runStatus` / `runSelect` / `runLint` /
 * `runReport` are exported and `main(argv)` only wires argv → those functions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SqlAdapter } from "../core/store/adapter.js";
import type { Selector } from "../types.js";
import { SqliteAdapter } from "../core/store/sqlite.js";
import { FixtureAdapter } from "../adapter/fixture.js";
import { validateSelector } from "../target/selector.js";
import { WorkItemRepo } from "../target/work-item.js";
import { exportRegistry, importRegistry, type RegistrySnapshot } from "../target/registry.js";
import {
  checkSmellReport,
  formatFindings,
  lintDelta,
  lintFile,
  renderSmellReport,
  scanUnits,
  type LintConfig,
} from "../parse/cpp/registry.js";
import { matchContextFromFixture } from "../parse/cpp/rules/match.js";
import type { Finding } from "../parse/cpp/types.js";
import { loadModels } from "../models/directory.js";
import { startServer } from "../server/serve.js";
import type { RunSpec } from "../server/scheduler.js";
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
  lint <paths…> [--delta] [--json|--markdown] [--config <path>] [--fixture <path>]
      Whole-file scan with the source rules (smell.* + ptr.* + clone.*, plus
      the match.* rules when --fixture provides accepted work items). With
      --delta, lint only the added lines against <path>.orig (whole file when
      no .orig exists). --config loads a JSON LintConfig (placeholder patterns
      given as regex strings). --json emits one JSON array document.
  report [paths…] [--json] [--config <path>]
      Whole-file scan summary: per-rule counts, then per-file counts.
      CI gate (mirror of tools/coop/smell_report.py):
        report --check [--base <ref>] [--no-strict] [--variant RVL]
            Freshness (committed docs/smells.md == fresh regeneration) + per-TU
            regression vs the base branch's committed baseline (git show
            <ref>:docs/smells.md; default origin/main → HEAD~1). --variant RVL
            scans libs/RVL_SDK/src with asm bodies stripped (informational,
            freshness-only).
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
      Create a run of workflow <wf> (SPEC §6/§7): builds a RunSpec with the
      repeatable --target / --unit scope (AND-ed) and delegates to the
      Decompi facade's scheduler. Fails with a clear error when the facade is
      not configured (e.g. inside an embedding harness that calls
      Decompi.configure first).
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
  config?: LintConfig;
}

/**
 * Whole-file scan per path (`lintFile`), or the added-lines delta gate
 * (`lintDelta`) with `--delta`. Text output is grep-style
 * `path:line:col rule message`; `--json` emits ONE valid JSON document — an
 * array `[{ "path", "findings" }, …]` (SPEC §13.4 stable schema) — so a
 * multi-file scan pipes cleanly; `--markdown` emits a per-file rule-grouped
 * report.
 */
export async function runLint(
  paths: readonly string[],
  opts: LintRunOptions = {},
  out: Output = process.stdout,
): Promise<void> {
  const results: Array<{ path: string; findings: Finding[] }> = [];
  for (const path of paths) {
    const source = readSource(path);
    const findings: Finding[] =
      opts.delta === true
        ? lintDelta(path, readOrig(path), source, opts.config)
        : lintFile(path, source, opts.config);
    if (opts.format === "json") {
      results.push({ path, findings });
    } else if (opts.format === "markdown") {
      out.write(`## ${path}\n\n`);
      out.write(formatFindings(findings, "markdown") + "\n\n");
    } else {
      for (const line of formatFindings(findings, "text").split("\n")) {
        if (line.length > 0) out.write(`${path}:${line}\n`);
      }
    }
  }
  if (opts.format === "json") {
    out.write(JSON.stringify(results, null, 2) + "\n");
  }
}

export interface ReportRunOptions {
  json?: boolean;
  config?: LintConfig;
}

/**
 * Whole-file scan summary: per-rule counts, then per-file counts, then the
 * total (SPEC §13.4 report). `--json` emits
 * `{ "rules": {id: n}, "files": {path: n}, "total": n }`.
 */
export async function runReport(
  paths: readonly string[],
  opts: ReportRunOptions = {},
  out: Output = process.stdout,
): Promise<void> {
  const ruleCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  let total = 0;
  for (const path of paths) {
    const findings = lintFile(path, readSource(path), opts.config);
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

async function cmdLint(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["delta", "json", "markdown", "config", "fixture"]));
  requireValueFlag(parsed, "config");
  requireValueFlag(parsed, "fixture");
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
  const fmt: "text" | "json" | "markdown" = parsed.bools.has("markdown")
    ? "markdown"
    : parsed.bools.has("json")
      ? "json"
      : "text";
  await runLint(parsed.positionals, {
    delta: parsed.bools.has("delta"),
    format: fmt,
    config: cfg,
  });
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

async function cmdReport(args: readonly string[]): Promise<void> {
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
    return;
  }

  const configPath = parsed.values.get("config");
  const config =
    configPath !== undefined
      ? loadConfigFile(configPath)
      : undefined;

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

  if (check || write) {
    const paths =
      parsed.positionals.length > 0
        ? parsed.positionals
        : isRvl
          ? [RVL_ROOT]
          : DEFAULT_ROOTS;
    const ok = runReportCheck(paths, {
      check,
      write,
      base: parsed.values.get("base"),
      strict: !parsed.bools.has("no-strict"),
      variant: isRvl ? "rvl" : "game",
      config,
    });
    if (!ok) {
      throw new Error("report --check failed — see the problems above");
    }
    return;
  }

  if (parsed.positionals.length === 0) {
    throw new Error("report requires at least one path (or --check / --write / --completeness)");
  }
  await runReport(parsed.positionals, { json: parsed.bools.has("json"), config });
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
  const reportPath = opts.variant === "rvl" ? RVL_REPORT_DOC : REPORT_DOC;
  const rows = scanUnits(paths, {
    skipAsmBodies: opts.variant === "rvl",
    includeC: opts.variant === "rvl",
  });
  const md = renderSmellReport(rows, { rvl: opts.variant === "rvl" });
  if (opts.write) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, md);
    out.write(`wrote ${reportPath}\n`);
    return true;
  }
  const result = checkSmellReport(rows, {
    reportPath,
    base: opts.base,
    strict: opts.strict,
    rvl: opts.variant === "rvl",
  });
  for (const problem of result.problems) {
    out.write(`ERROR: ${problem}\n`);
  }
  if (result.ok) {
    out.write(`ok: ${reportPath} is fresh and no per-TU smell regression vs base.\n`);
  } else {
    out.write("\n--check failed.\n");
  }
  return result.ok;
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
 * `run <wf> [--model name] [--budget $] [--target id]... [--unit id]...`
 * (SPEC §6/§7): build the `RunSpec` (scope AND-ed from the repeatable
 * target/unit flags) and delegate to the configured `Decompi` facade. The
 * CLI never configures the facade itself — an embedding harness does — so
 * an unconfigured facade surfaces a clear "no scheduler configured" error.
 */
async function cmdRun(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  checkFlags(parsed, new Set(["model", "budget", "target", "unit"]));
  requireValueFlag(parsed, "model");
  requireValueFlag(parsed, "budget");
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
  try {
    const runId = await Decompi.run(spec);
    process.stdout.write(`run ${runId} created (pipeline ${workflowId}, model ${model})\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/before run\(\)/.test(message)) {
      throw new Error(
        "no scheduler configured: Decompi.configure({ engine, scheduler }) must be " +
          "called before `decompi run` (e.g. by an embedding harness or serve)",
      );
    }
    throw err;
  }
}

// ─── wiring ──────────────────────────────────────────────────────────────────

async function openAndImport(
  dbPath: string,
  fixturePath: string | undefined,
): Promise<SqliteAdapter> {
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

export async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === undefined) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  switch (command) {
    case "status":
      return cmdStatus(argv.slice(1));
    case "select":
      return cmdSelect(argv.slice(1));
    case "lint":
      return cmdLint(argv.slice(1));
    case "report":
      return cmdReport(argv.slice(1));
    case "export":
      return cmdExport(argv.slice(1));
    case "import":
      return cmdImport(argv.slice(1));
    case "analyze":
      return cmdAnalyze(argv.slice(1));
    case "workflow":
      return cmdWorkflow(argv.slice(1));
    case "run":
      return cmdRun(argv.slice(1));
    case "models":
      return cmdModels(argv.slice(1));
    case "serve":
      return cmdServe(argv.slice(1));
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`decompi: ${message}`);
    console.error("Run 'decompi --help' for usage.");
    process.exitCode = 1;
  });
}
