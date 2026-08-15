/**
 * Xenoblade workflow-authoring augmentation (SPEC §2/§3, task 11) — M5
 * cut-over: the REAL coop-tool helpers.
 *
 * Augments the core `WorkItemKindMap` / `WorkflowHelpers` interfaces (via
 * the package `exports` self-reference in package.json — see `src/index.ts`)
 * with the xenoblade function vocabulary, and ships the concrete helpers the
 * engine/daemon integration calls through `registerHelpers()`.
 *
 * `FunctionWorkItem` carries `asmText` (the retail assembly text for the
 * function, as loaded/fetched for the match prompt) so the augmentation is
 * structurally identical to the local vocab used by
 * `tests/workflow-types.test.ts` and `examples/helpers.ts` — interface
 * merging requires same-named `WorkItemKindMap` members to have the same
 * type (TS2717), so the adapter, the examples, and the typing test MUST
 * agree on the shape.
 *
 * Every helper is a thin wrapper over the coop python tools, spawned via
 * `node:child_process` `execFile` with the venv python resolved exactly like
 * `diffEngine()` in `adapter.ts` (DECOMPI_XENOBLADE_ROOT → XENOBLADE_REPO →
 * the sibling-of-decompi checkout; `.venv/bin/python3`, overridable with
 * DECOMPI_XENOBLADE_PYTHON). Paths + existence checks resolve ONCE per env
 * fingerprint (module-level, memoized) — repeated calls never re-stat the
 * filesystem. Each helper also ACCEPTS an injected `run` (an
 * `execFile`-shaped `(cmd, args) => Promise<string>`, defaulting to the real
 * `execFile`), so tests can mock the subprocess without a live repo.
 *
 *   - `getFunctionAsm` — `hexdiff.py <unit> --symbol <symbol> --asm
 *     --no-build`: the retail asm text for one function (the fetch path for
 *     `FunctionWorkItem.asmText`).
 *   - `runBatchCycle` — `batch-cycle.py <id>... --summary <tmpfile>`: the
 *     coop mass-cycle runner; maps the written summary JSON to one
 *     `BatchCycleResult` per input target (`accepted` = FULL_MATCH /
 *     EQUIVALENT_MATCH).
 *   - `structLayout` — `struct_layout.py search <unit> --json`: the
 *     retail-derived struct/class layout for a translation unit (JSON on
 *     stdout; the caller renders it).
 */
import { execFile as realExecFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AdapterCtx } from "../../src/adapter/types.js";
import type { WorkItem } from "../../src/types.js";
import type { HelperRegistry } from "../../src/workflow/helpers.js";
import type { Tool } from "../../src/workflow/types.js";
import xenobladeAdapter, {
  resolveXenobladePython,
  resolveXenobladeRoot,
} from "./adapter.js";

/** A xenoblade function work item: a `function`-kind target with asm text. */
export type FunctionWorkItem = WorkItem & { kind: "function"; asmText: string };

/** Outcome of one function through the coop batch-cycle tool. */
export interface BatchCycleResult {
  /** The function the cycle was run against (same reference as the input). */
  target: FunctionWorkItem;
  /** `target.id` — the id the batch-cycle report keys on. */
  targetId: string;
  /** Accepted (e.g. FULL_MATCH / EQUIVALENT_MATCH) by the cycle's diff. */
  accepted: boolean;
  /** The cycle's status vocab value (FULL_MATCH / NOT_STARTED / …). */
  status: string;
}

declare module "decompi" {
  interface WorkItemKindMap {
    function: FunctionWorkItem;
  }
  interface WorkflowHelpers {
    /** Fetch the retail asm text for a function target (for match prompts). */
    getFunctionAsm(t: FunctionWorkItem): Promise<string>;
    /** Run the coop batch-cycle tool over the given functions. */
    runBatchCycle(t: FunctionWorkItem[]): Promise<BatchCycleResult[]>;
    /** Fetch the struct layout for a translation unit (prepass scaffolding). */
    structLayout(unit: string): Promise<string>;
    /** Read the current source text of a function target's TU. */
    readSource(t: FunctionWorkItem): Promise<string>;
    /**
     * Replace the target function's existing definition in its source file
     * with `code` (a full function definition, fences/prose stripped).
     * Returns the new source text. Throws when no existing definition can be
     * located for the target's symbol.
     */
    applyCandidate(t: FunctionWorkItem, code: string): Promise<string>;
    /** Build+diff one function via hexdiff.py (fresh bytes, holds the repo lock). */
    hexdiff(unit: string, symbol: string): Promise<string>;
    /**
     * The SPEC §9 diff verifier against a FRESH build: hexdiff.py --json
     * (builds the unit first), accepted iff mismatch_count === 0. Resolves
     * `{ accepted, mismatch_count, total_instructions, status }` — never
     * throws on diff failures (a build/read failure resolves rejected).
     */
    diffVerify(t: FunctionWorkItem): Promise<{
      accepted: boolean;
      mismatch_count: number | null;
      total_instructions: number | null;
      status: string | null;
    }>;
  }
}

/**
 * An `execFile`-shaped runner: resolves with the child's stdout. Every
 * helper takes one as an optional trailing parameter so tests can inject a
 * mock without a live xenoblade repo; the default is the real `execFile`.
 */
export type RunFn = (cmd: string, args: string[]) => Promise<string>;

/** Default runner: the promisified real `execFile`, returning stdout. */
const execFileP = promisify(realExecFile);
async function defaultRun(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP(cmd, args);
  return stdout;
}

// ── Tool-path resolution (once per env, memoized module-level) ────────────

/** Resolved tool paths for one env fingerprint. */
interface ToolPaths {
  /** The xenoblade repo checkout root. */
  root: string;
  /** The venv python that runs every tool. */
  python: string;
  /** `<root>/tools/coop/hexdiff.py` (getFunctionAsm). */
  hexdiff: string;
  /** `<root>/tools/coop/batch-cycle.py` (runBatchCycle). */
  batchCycle: string;
  /** `<root>/tools/struct_layout.py` (structLayout — lives under tools/, not tools/coop/). */
  structLayout: string;
}

interface PathsCache {
  /** The env fingerprint the paths were resolved under. */
  key: string;
  paths: ToolPaths;
}
let pathsCache: PathsCache | null = null;

/**
 * The env fingerprint the resolution honours — a change to any of the three
 * vars re-resolves (the sibling-of-decompi default can only be used once the
 * env is stable, so the memo is keyed rather than frozen at first import).
 */
function envKey(): string {
  return [
    process.env.DECOMPI_XENOBLADE_ROOT ?? "",
    process.env.XENOBLADE_REPO ?? "",
    process.env.DECOMPI_XENOBLADE_PYTHON ?? "",
  ].join("\u0000");
}

/**
 * Resolve (once per env fingerprint) the venv python and the three coop tool
 * scripts, exactly like `diffEngine()` resolves its root/python. Throws a
 * clear error when the xenoblade root, the venv python, or a tool script is
 * missing — a missing script would otherwise surface as an opaque ENOENT at
 * spawn time.
 */
function toolPaths(): ToolPaths {
  const key = envKey();
  if (pathsCache !== null && pathsCache.key === key) return pathsCache.paths;

  const root = resolveXenobladeRoot();
  const python = resolveXenobladePython(root);
  const hexdiff = join(root, "tools", "coop", "hexdiff.py");
  const batchCycle = join(root, "tools", "coop", "batch-cycle.py");
  const structLayout = join(root, "tools", "struct_layout.py");

  if (!existsSync(root)) {
    throw new Error(
      `xenoblade workflow helpers: xenoblade repo root not found at ${root} — ` +
        "set DECOMPI_XENOBLADE_ROOT (or XENOBLADE_REPO) to the xenoblade checkout",
    );
  }
  if (!existsSync(python)) {
    throw new Error(
      `xenoblade workflow helpers: venv python not found at ${python} — ` +
        "set DECOMPI_XENOBLADE_PYTHON or create the repo .venv",
    );
  }
  for (const [label, path] of [
    ["hexdiff.py", hexdiff],
    ["batch-cycle.py", batchCycle],
    ["struct_layout.py", structLayout],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(
        `xenoblade workflow helpers: ${label} not found at ${path} — ` +
          "is DECOMPI_XENOBLADE_ROOT pointing at the xenoblade repo?",
      );
    }
  }

  const paths: ToolPaths = { root, python, hexdiff, batchCycle, structLayout };
  pathsCache = { key, paths };
  return paths;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch the retail asm text for a function target: `hexdiff.py <unit>
 * --symbol <symbol> --asm --no-build` on the venv python, stdout returned
 * verbatim. `--no-build` — this is a read of the retail/object asm, never a
 * ninja invocation (builds + the build flock are the daemon's job, SPEC
 * §7.1). The injected `run` (default: the real `execFile`) lets tests mock
 * the subprocess; the resolved python + script are still passed through, so
 * a mocked run can assert the exact argv.
 */
export async function getFunctionAsm(
  t: FunctionWorkItem,
  run: RunFn = defaultRun,
): Promise<string> {
  if (!t.unitId || !t.symbol) {
    throw new Error(
      `xenoblade workflow helper getFunctionAsm: requires a function work item ` +
        `with unitId + symbol, got ${JSON.stringify({ id: t.id, unitId: t.unitId, symbol: t.symbol })}`,
    );
  }
  const { python, hexdiff } = toolPaths();
  return run(python, [hexdiff, t.unitId, "--symbol", t.symbol, "--asm", "--no-build"]);
}

/** The status vocab values that count as a cycle acceptance. */
const ACCEPTED_STATUSES = new Set(["FULL_MATCH", "EQUIVALENT_MATCH"]);

/**
 * Map one `batch-cycle.py --summary` document to `BatchCycleResult[]`, one
 * entry per input target (same order, same `target` reference). The summary
 * is a JSON object with a `results` array of per-target objects; each is
 * matched to its target by `target_id` (entries without a `target_id` fall
 * back to positional order, mirroring the tool's sequential processing).
 * Missing fields and missing entries are tolerated — `status` defaults to ""
 * (and `accepted` to false) rather than throwing.
 */
function mapBatchSummary(doc: unknown, targets: FunctionWorkItem[]): BatchCycleResult[] {
  const raw = (doc as { results?: unknown } | null)?.results;
  const entries: unknown[] = Array.isArray(raw) ? raw : [];
  const byId = new Map<string, unknown>();
  const positional: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const id = (entry as Record<string, unknown>).target_id;
    if (typeof id === "string" && id.length > 0) byId.set(id, entry);
    else positional.push(entry);
  }
  return targets.map((target, index) => {
    const entry = byId.get(target.id) ?? positional[index] ?? null;
    const status =
      entry !== null && typeof (entry as Record<string, unknown>).status === "string"
        ? ((entry as Record<string, unknown>).status as string)
        : "";
    return {
      target,
      targetId: target.id,
      status,
      accepted: ACCEPTED_STATUSES.has(status),
    };
  });
}

/**
 * Run the coop mass-cycle tool over the given functions:
 * `batch-cycle.py <id1> <id2> ... --summary <tmpfile>` (ids = `target.id`),
 * then read the summary JSON and map it to one `BatchCycleResult` per input
 * target (`accepted` = status FULL_MATCH / EQUIVALENT_MATCH). The summary is
 * written to a fresh temp dir that is always cleaned up.
 *
 * batch-cycle exits 1 when ANY target failed — the summary file is still
 * written on that path, so a non-zero exit is NOT treated as a helper
 * failure: the rejection is only propagated when the summary is absent
 * (spawn/config error, not a cycle verdict).
 */
export async function runBatchCycle(
  targets: FunctionWorkItem[],
  run: RunFn = defaultRun,
): Promise<BatchCycleResult[]> {
  if (targets.length === 0) return [];
  const { python, batchCycle } = toolPaths();
  const dir = mkdtempSync(join(tmpdir(), "decompi-batch-cycle-"));
  const summaryPath = join(dir, "summary.json");
  try {
    const args = [batchCycle, ...targets.map((t) => t.id), "--summary", summaryPath];
    try {
      await run(python, args);
    } catch (err) {
      if (!existsSync(summaryPath)) {
        throw new Error(
          `xenoblade workflow helper runBatchCycle: batch-cycle.py failed before ` +
            `writing ${summaryPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Summary exists → the exit code was a per-target verdict (rc 1 = some
      // target failed); the summary still carries every result. Continue.
    }
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(summaryPath, "utf8"));
    } catch (err) {
      throw new Error(
        `xenoblade workflow helper runBatchCycle: cannot parse summary ` +
          `${summaryPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return mapBatchSummary(doc, targets);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fetch the struct layout for a translation unit:
 * `struct_layout.py search <unit> --json` — stdout is a JSON string the
 * caller renders. The script lives at `<root>/tools/struct_layout.py` (not
 * tools/coop/), hence its own path slot.
 */
export async function structLayout(unit: string, run: RunFn = defaultRun): Promise<string> {
  if (unit.length === 0) {
    throw new Error("xenoblade workflow helper structLayout: requires a non-empty unit");
  }
  const { python, structLayout: script } = toolPaths();
  return run(python, [script, "search", unit, "--json"]);
}

/**
 * Resolve a target's source file path (absolute): `target.source` is
 * repo-relative (e.g. "src/kyoshin/CSaveLoad.cpp"); absent → the unit's
 * conventional `src/<unit>.cpp` path. Verifies the file exists.
 */
export function sourcePathFor(t: Pick<FunctionWorkItem, "source" | "unitId" | "symbol" | "id">): string {
  const { root } = toolPaths();
  const rel =
    t.source ??
    (t.unitId !== undefined && t.symbol !== undefined ? sourceRelFor(t.unitId, t.symbol) : undefined) ??
    (t.unitId ? `src/${t.unitId}.cpp` : undefined);
  if (!rel) {
    throw new Error(`xenoblade workflow helper: no source path for ${t.id} (no source/unitId)`);
  }
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    throw new Error(`xenoblade workflow helper: source file not found at ${abs}`);
  }
  return abs;
}

// ── targets.json source lookup (for tools that only know unit+symbol) ─────

interface SourceIndex {
  key: string;
  byUnitSymbol: Map<string, string>;
}
let sourceIndex: SourceIndex | null = null;

/**
 * Resolve the repo-relative source path of a target from the live
 * tools/coop/targets.json registry (cached module-level, keyed by
 * path:mtimeMs:size — the same cache discipline as the adapter's import).
 * Returns undefined when the registry is unreadable or the target is absent.
 */
export function sourceRelFor(unit: string, symbol: string): string | undefined {
  const root = resolveXenobladeRoot();
  const path = join(root, "tools", "coop", "targets.json");
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  const key = `${path}:${stat.mtimeMs}:${stat.size}`;
  if (sourceIndex === null || sourceIndex.key !== key) {
    let doc: { targets?: Array<{ unit?: unknown; symbol?: unknown; source?: unknown }> };
    try {
      doc = JSON.parse(readFileSync(path, "utf8")) as typeof doc;
    } catch {
      return undefined;
    }
    const byUnitSymbol = new Map<string, string>();
    for (const t of doc.targets ?? []) {
      if (
        typeof t.unit === "string" &&
        typeof t.symbol === "string" &&
        typeof t.source === "string"
      ) {
        byUnitSymbol.set(`${t.unit}\u0000${t.symbol}`, t.source);
      }
    }
    sourceIndex = { key, byUnitSymbol };
  }
  return sourceIndex.byUnitSymbol.get(`${unit}\u0000${symbol}`);
}

/**
 * Read the current source text of a function target's TU (the whole file).
 */
export async function readSource(t: FunctionWorkItem): Promise<string> {
  return readFileSync(sourcePathFor(t), "utf8");
}

/** Escape a string for use in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Candidate name tokens for locating a function's definition in source:
 * the exact symbol first, then the demangled stem (everything before the
 * first `__` — e.g. `detail_CanPlaySound__Q44nw4r…` → `detail_CanPlaySound`,
 * which is what the source actually spells as `Class::detail_CanPlaySound`).
 */
function symbolStems(symbol: string): string[] {
  const stems: string[] = [symbol];
  const idx = symbol.indexOf("__");
  if (idx > 0) stems.push(symbol.slice(0, idx));
  return [...new Set(stems)];
}

/**
 * Locate the source span of the definition of `symbol` in `source`:
 * from the start of the declaration line (walking back over prefix lines
 * such as `extern "C"` / return-type continuations) through the end of the
 * brace-matched body. Returns `{start, end}` or null when no definition is
 * found (the symbol may only appear as a call site / declaration). The LAST
 * matching definition wins (stubs typically sit at the end of the file).
 */
export function extractFunctionSpan(
  source: string,
  symbol: string,
): { start: number; end: number } | null {
  for (const stem of symbolStems(symbol)) {
    const re = new RegExp(`(?:^|[^\\w])(${escapeRegExp(stem)})\\s*\\(`, "g");
    const candidates: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const namePos = m.index + m[0].indexOf(stem);
      // Scan for the body open brace at paren depth 0; a `;` at depth 0
      // before any `{` means a call/declaration, not a definition.
      let depth = 0;
      let open = -1;
      for (let i = namePos + stem.length; i < source.length; i++) {
        const c = source[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "{" && depth === 0) {
          open = i;
          break;
        } else if (c === ";" && depth === 0) break;
      }
      if (open < 0) continue;
      let d = 0;
      let close = -1;
      for (let j = open; j < source.length; j++) {
        if (source[j] === "{") d++;
        else if (source[j] === "}") {
          d--;
          if (d === 0) {
            close = j;
            break;
          }
        }
      }
      if (close < 0) continue;
      // Definition start: the line containing the name, then walk back over
      // prefix lines (return type / `extern "C"` / multiline signature)
      // that don't terminate a previous statement.
      let start = source.lastIndexOf("\n", namePos) + 1;
      let prev = source.lastIndexOf("\n", start - 2);
      while (prev >= 0) {
        const prevLine = source.slice(prev + 1, start).trim();
        if (
          prevLine.length === 0 ||
          /[;}{]$/.test(prevLine) ||
          prevLine.startsWith("//") ||
          prevLine.startsWith("/*")
        ) {
          break;
        }
        start = prev + 1;
        prev = source.lastIndexOf("\n", start - 2);
      }
      candidates.push({ start, end: close + 1 });
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.start - a.start);
      return candidates[0]!;
    }
  }
  return null;
}

/** Strip markdown fences (and any leading prose up to the first fence). */
export function stripCodeFences(code: string): string {
  let out = code.trim();
  // If the reply wraps the code in fences, keep only the fenced block(s).
  const fenced = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g.exec(out);
  if (fenced) out = fenced[1]!.trim();
  return out;
}

/**
 * Validate a candidate before splicing it into the source. Models
 * occasionally paste verification output (a "PASS — matches retail exactly"
 * status line) as if it were code, which corrupts the TU and wastes the
 * turn. Rejects candidates that (a) contain verification-speak or HTML
 * entities, (b) never name the target symbol, or (c) have no brace-balanced
 * body. Returns the normalized candidate on success.
 */
export function validateCandidate(code: string, symbol: string): string {
  const candidate = stripCodeFences(code);
  if (candidate.length === 0) {
    throw new Error(`candidate for ${symbol} is empty`);
  }
  const stem = symbolStems(symbol)[0]!;
  if (
    /matches retail exactly|&#\d+;|^\s*PASS\b|^\s*FAIL\b/m.test(candidate)
  ) {
    throw new Error(
      `candidate for ${symbol} looks like verification output, not code ` +
        `(contains a PASS/FAIL/status line). Resubmit ONLY the function definition.`,
    );
  }
  const firstBrace = candidate.indexOf("{");
  if (firstBrace < 0) {
    throw new Error(`candidate for ${symbol} has no function body "{"`);
  }
  if (!candidate.slice(0, firstBrace).includes(stem)) {
    throw new Error(`candidate for ${symbol} does not name ${stem}`);
  }
  let depth = 0;
  for (const ch of candidate) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth < 0) {
      throw new Error(`candidate for ${symbol} has unbalanced braces`);
    }
  }
  if (depth !== 0) {
    throw new Error(`candidate for ${symbol} has unbalanced braces`);
  }
  return candidate;
}

/**
 * Apply a candidate implementation to a function target's source file:
 * `code` is the model's proposed full definition (fences/prose stripped,
 * markdown fences removed); the target's EXISTING definition span is located
 * via {@link extractFunctionSpan} and replaced in place. An `extern "C"`
 * prefix on the original definition is preserved when the candidate omits it
 * (dropping it would mangle the symbol and break the build). The file is
 * written back to the worktree and the new source text is returned. Throws
 * when no existing definition can be located.
 */
export async function applyCandidate(
  t: FunctionWorkItem,
  code: string,
): Promise<string> {
  const path = sourcePathFor(t);
  const source = readFileSync(path, "utf8");
  const symbol = t.symbol;
  if (!symbol) {
    throw new Error(`xenoblade workflow helper applyCandidate: no symbol for ${t.id}`);
  }
  const span = extractFunctionSpan(source, symbol);
  if (span === null) {
    throw new Error(
      `xenoblade workflow helper applyCandidate: no existing definition found for ` +
        `${symbol} in ${path} — the model's output must replace an existing stub ` +
        `(calls/declarations alone are not spliced)`,
    );
  }
  const original = source.slice(span.start, span.end);
  let replacement = validateCandidate(code, symbol);
  // Preserve an extern "C" linkage prefix the original had (the candidate
  // may not know the TU is C++).
  const prefix = /^\s*(extern\s+"C"\s+)/.exec(original);
  if (prefix && !/^\s*extern\s+"C"/.test(replacement)) {
    replacement = `${prefix[1]}${replacement.trimStart()}`;
  }
  const updated = source.slice(0, span.start) + replacement + source.slice(span.end);
  writeFileSync(path, updated);
  return updated;
}

/**
 * Build+diff one function via the coop hexdiff tool (NO `--no-build`: the
 * tool runs ninja for the unit under the repo-wide build lock, so the diff
 * reflects the freshly-edited source). On a build/compile failure the
 * underlying ninja/mwcceppc stderr is RETURNED (not thrown) — a compile
 * error is the model's most valuable feedback, and throwing would surface
 * only the command echo.
 */
export async function hexdiff(
  unit: string,
  symbol: string,
  run: RunFn = defaultRun,
): Promise<string> {
  const { python, hexdiff: script } = toolPaths();
  try {
    return await run(python, [script, unit, "--symbol", symbol]);
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const stderr = (e.stderr ?? "").trim();
    const stdout = (e.stdout ?? "").trim();
    // hexdiff exits non-zero (rc 5) on MISMATCH while printing the full diff
    // to stdout — that diff is the model's primary feedback, never discard it.
    if (stdout.length > 0) return stdout;
    return `hexdiff FAILED (exit non-zero):\n${stderr || (e.message ?? String(err))}`;
  }
}

/**
 * The SPEC §9 diff verifier against a FRESH build: hexdiff.py --json with a
 * build (the coop tool runs ninja for the unit under the repo-wide build
 * lock, so the diff reflects the freshly-edited source). Accepted iff
 * `mismatch_count === 0`. Diff/build failures never throw — the verdict is
 * rejected with the mismatch fields nulled.
 */
export async function diffVerify(
  t: FunctionWorkItem,
  run: RunFn = defaultRun,
): Promise<{ accepted: boolean; mismatch_count: number | null; total_instructions: number | null; status: string | null }> {
  if (!t.unitId || !t.symbol) {
    return { accepted: false, mismatch_count: null, total_instructions: null, status: "NO_SYMBOL" };
  }
  const { python, hexdiff: script } = toolPaths();
  let stdout = "";
  try {
    stdout = await run(python, [script, t.unitId, "--symbol", t.symbol, "--json"]);
  } catch {
    return { accepted: false, mismatch_count: null, total_instructions: null, status: "BUILD_OR_DIFF_FAILED" };
  }
  try {
    const doc = JSON.parse(stdout) as {
      mismatch_count?: unknown;
      total_instructions?: unknown;
    };
    const mismatch = typeof doc.mismatch_count === "number" ? doc.mismatch_count : null;
    const total = typeof doc.total_instructions === "number" ? doc.total_instructions : null;
    return {
      accepted: mismatch === 0,
      mismatch_count: mismatch,
      total_instructions: total,
      status: mismatch === 0 ? "FULL_MATCH" : null,
    };
  } catch {
    return { accepted: false, mismatch_count: null, total_instructions: null, status: "UNPARSEABLE" };
  }
}

/**
 * Register the xenoblade workflow helpers into a `HelperRegistry` (the
 * facade's registry — `Decompi.helpers` — or the engine's). All seven are the
 * real coop-tool wrappers; the injected-`run` parameters are optional and
 * left untouched by the registry.
 */
export function registerHelpers(registry: HelperRegistry): void {
  registry.register("getFunctionAsm", getFunctionAsm);
  registry.register("runBatchCycle", runBatchCycle);
  registry.register("structLayout", structLayout);
  registry.register("readSource", readSource);
  registry.register("applyCandidate", applyCandidate);
  registry.register("hexdiff", hexdiff);
  registry.register("diffVerify", diffVerify);
}

// ── Agent tools (SPEC §B.1 adapter tools) ─────────────────────────────────

/**
 * A minimal WorkItem for the tool paths that need one (hexdiff/asm only
 * read `unitId` + `symbol`; the rest is the adapter-import baseline).
 */
function toolItem(unit: string, symbol: string): WorkItem {
  return {
    id: `${unit}:${symbol}`,
    kind: "function",
    unitId: unit,
    symbol,
    lifecycle: "pending",
    status: "NOT_STARTED",
    attempts: 0,
    exhausted: false,
    ready: true,
    meta: {},
  };
}

/**
 * The xenoblade adapter tools (SPEC §B.1): thin Tool wrappers over the real
 * helpers — `hexdiff` (adapter.diff), `asm` (getFunctionAsm), plus the
 * `size`/`symbols` stubs (not implemented yet). Workflow/daemon integration
 * passes the array to the engine, which assembles it into the session
 * toolset next to the core built-ins. AdapterCtx is not threaded yet — the
 * diff path only reads the item, so a placeholder ctx is passed through.
 */
export function registerTools(): Tool[] {
  return [
    {
      name: "hexdiff",
      description:
        "Diff one function's decompiled output against the retail object " +
        "(`hexdiff.py <unit> --symbol <symbol>`): returns the instruction " +
        "diff (mismatch count, structural/reg-swap breakdown, sizes).",
      inputSchema: z.object({ unit: z.string(), symbol: z.string() }),
      run: async (_ctx, args: { unit: string; symbol: string }) =>
        xenobladeAdapter.diff({} as AdapterCtx, toolItem(args.unit, args.symbol)),
    },
    {
      name: "asm",
      description:
        "Fetch the retail assembly text for one function " +
        "(`hexdiff.py <unit> --symbol <symbol> --asm --no-build`).",
      inputSchema: z.object({ unit: z.string(), symbol: z.string() }),
      run: async (_ctx, args: { unit: string; symbol: string }) =>
        getFunctionAsm({
          ...toolItem(args.unit, args.symbol),
          kind: "function",
          asmText: "",
        } as FunctionWorkItem),
    },
    {
      name: "size",
      description:
        "Function size lookup — not implemented yet (stub); throws until the " +
        "helper lands.",
      inputSchema: z.object({ unit: z.string(), symbol: z.string() }),
      run: async () => {
        throw new Error("size tool: not implemented yet (stub)");
      },
    },
    {
      name: "symbols",
      description:
        "Symbol-table lookup — not implemented yet (stub); returns an empty " +
        "list until the helper lands.",
      inputSchema: z.object({ unit: z.string() }),
      run: async () => [],
    },
  ];
}
