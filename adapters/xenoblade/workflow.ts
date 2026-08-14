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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
 * Register the xenoblade workflow helpers into a `HelperRegistry` (the
 * facade's registry — `Decompi.helpers` — or the engine's). All three are
 * the real coop-tool wrappers; the injected-`run` parameters are optional
 * and left untouched by the registry.
 */
export function registerHelpers(registry: HelperRegistry): void {
  registry.register("getFunctionAsm", getFunctionAsm);
  registry.register("runBatchCycle", runBatchCycle);
  registry.register("structLayout", structLayout);
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
