/**
 * M2.5 — Xenoblade reference adapter (SPEC §7).
 *
 * Implements the §7 `GameAdapter` surface that M2.5 wires:
 *
 *   - `diffEngine()` — a `WorkerSpec` for the persistent NDJSON worker
 *     `adapters/xenoblade/diff-engine.py` (the proven ~80x-faster,
 *     JSON-identical in-process wrapper of `tools/coop/hexdiff.py`). The
 *     venv python and the xenoblade repo root are resolved from the
 *     environment with a sibling-of-decompi default; `DECOMPI_XENOBLADE_ROOT`
 *     / `DECOMPI_XENOBLADE_PYTHON` override them (and `XENOBLADE_REPO` is
 *     honoured — it is the env var the worker itself reads). The root
 *     reaches the worker via the spawn env (`WorkerSpec.env`, spread over
 *     the inherited environment) AND the `--repo` argv — `process.env` is
 *     never mutated by the adapter.
 *   - `diff()` — one "diff" RPC on a SINGLE lazily-created persistent
 *     `WorkerPool` (created from `diffEngine()` on the first call and reused
 *     for the adapter's lifetime), always `--no-build` (the fast path; builds
 *     + the build flock are `buildUnit`'s / the daemon's job, SPEC §7.1).
 *   - `verify()` — the SPEC §9 diff verifier: accepted iff
 *     `mismatch_count === 0` (status FULL_MATCH), else rejected with
 *     feedback. Diff failures never throw: the underlying hexdiff rc is
 *     mapped to a rejected verdict (rc 4 → NOT_FOUND; rc 2/3 → NOT_BUILDABLE;
 *     anything else → NOT_BUILDABLE).
 *   - `dispose()` — closes the persistent worker pool (idempotent; the
 *     adapter stays usable and lazily re-creates the pool on the next
 *     `diff()`).
 *   - `statusVocab()` / `placeholderPatterns()` / `buildLockPath()` — the
 *     Xenoblade vocabularies, dtk placeholder patterns, and the hexdiff
 *     build lock.
 *
 * Build-lock story (SPEC §7.1 lock discipline): M2.5's `diff()` is
 * `--no-build` and single-process — it diffs against objects that already
 * exist and never invokes ninja, so it ASSUMES no concurrent build is
 * mutating those objects and does not hold the flock. The repo-wide build
 * flock (`buildLockPath()` → `build/<region>/.hexdiff.lock`) is wrapped
 * around build-performing RPCs (`buildUnit`, and `diff` once it can build)
 * by the M3/M4 daemon, per §7.1 — the adapter only exposes the lock path.
 *
 * `importWorkItems` (SPEC §6.4) is implemented as a LIVE READ, not a
 * migration: it parses `<root>/tools/coop/targets.json` — cached
 * module-level, keyed by file mtime/size, so repeated imports never re-parse
 * the 18 MB registry — and maps each target per the §6.4 field map
 * (workflow_status → lifecycle; hex size → number; every un-mapped field,
 * e.g. instruction_match / called_functions / depends_on / capabilities,
 * rides JSON-serialized in `meta`). Materialized columns stay at their
 * defaults (attempts=0, exhausted=false, ready=false) — the store computes
 * them on insert. The optional members
 * `scanSource`/`syncCalls`/`syncSymbols`/`buildUnit`/`unitReport`/
 * `witnessEngine`/`symbolTable`/`retailAsmIndex`/`relocMap` (coop tooling,
 * objdiff report, z3 witness, and the asm/symbol data sources land with
 * their milestones). `lintRules()`/`styleGuidePath()` return the neutral
 * values — the §13 rule registry is core-side (src/parse/cpp) and no style
 * guide ships with M2.5.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerPool, WorkerRpcError, type WorkerSpec } from "../../src/core/worker.js";
import type {
  AdapterCtx,
  DiffResult,
  GameAdapter,
  LintRule,
  PlaceholderPatterns,
  StatusVocab,
} from "../../src/adapter/types.js";
import type { WorkItem, Verdict } from "../../src/types.js";

/** Per-request fence for hexdiff diffs (SPEC §7.1): a wedged worker is killed. */
const DIFF_TIMEOUT_MS = 600_000;
/** One long-lived diff worker process (diff is single-symbol, build-free). */
const DIFF_POOL_SIZE = 1;

// ── targets.json import (SPEC §6.4 live read) ──────────────────────────────

/**
 * SPEC §6.4 field map: targets.json keys that become promoted WorkItem
 * columns; every other key is preserved in `meta`. `attempts`/`exhausted`/
 * `ready` are store-side materialized columns — the live read leaves them at
 * their defaults and never reads them back from the file.
 */
const PROMOTED_FIELDS = new Set([
  "id",
  "kind",
  "unit",
  "status",
  "workflow_status",
  "region",
  "symbol",
  "address",
  "milestone",
  "required_level",
  "size",
  "source",
  "attempts",
  "exhausted",
  "ready",
]);

/**
 * SPEC §6.4 lifecycle translation: coop `workflow_status` → core lifecycle.
 * Missing and un-mapped values both fall back to "pending" (missing is
 * explicitly spec'd; unknown values default the same way rather than leak
 * un-mapped vocabulary into the core-owned lifecycle column).
 */
const LIFECYCLE_MAP: Record<string, string> = {
  DISCOVERY: "pending",
  QUEUED: "pending",
  CLAIMED: "pending",
  ACTIVE: "pending",
  BACKLOG: "blocked",
  BLOCKED: "blocked",
  ACCEPTED: "accepted",
  REVALIDATION_REQUIRED: "revalidation_required",
  NOT_REQUIRED: "not_required",
};

/** Parse-cache entry: the file fingerprint plus the parsed document. */
interface TargetsCache {
  key: string;
  doc: { targets: unknown[] };
}
let targetsCache: TargetsCache | null = null;

/**
 * Read + parse `<root>/tools/coop/targets.json`, validating the coop shape
 * (`{ targets: [...] }`). The module-level cache is keyed by
 * `path:mtimeMs:size` — repeated imports of the unchanged 18 MB registry
 * reuse the cached parse instead of re-reading and re-JSON-parsing it;
 * any mtime or size change re-parses.
 */
function loadTargetsJson(path: string): { targets: unknown[] } {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(
      `xenoblade adapter: targets.json not found at ${path} ` +
        `(set DECOMPI_XENOBLADE_ROOT to the xenoblade repo checkout)`,
    );
  }
  const key = `${path}:${stat.mtimeMs}:${stat.size}`;
  if (targetsCache !== null && targetsCache.key === key) return targetsCache.doc;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `xenoblade adapter: cannot parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const targets = (parsed as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(targets)) {
    throw new Error(
      `xenoblade adapter: ${path} has no "targets" array (expected the coop targets.json shape)`,
    );
  }
  const doc = { targets };
  targetsCache = { key, doc };
  return doc;
}

/** A targets.json entry value as a non-empty string, else undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse a coop hex size ("0x29C") to bytes; unparseable → undefined. */
function parseSize(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const hex = value.trim().replace(/^0[xX]/, "");
  if (hex.length === 0) return undefined;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : undefined;
}

/** Map one targets.json entry to a WorkItem (SPEC §6.4 field map). */
function mapTarget(raw: unknown, index: number, defaultRegion: string): WorkItem {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `xenoblade adapter: targets[${index}] is not an object (expected a targets.json entry)`,
    );
  }
  const entry = raw as Record<string, unknown>;
  const id = str(entry.id);
  if (id === undefined) {
    // Mandatory id preservation (SPEC §6.4): ids are the join key for deps,
    // ledger attempts, and asm data — never re-generated, never dropped.
    throw new Error(
      `xenoblade adapter: targets[${index}] has no "id" (target ids must be preserved)`,
    );
  }
  // Older live-registry entries predate a `kind` column; every one of them is
  // a function target, so "function" is the lenient default. The status
  // default mirrors the adapter's "not started yet" baseline.
  const kind = str(entry.kind) ?? "function";
  const status = str(entry.status) ?? "NOT_STARTED";
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!PROMOTED_FIELDS.has(key)) meta[key] = value;
  }
  return {
    id,
    kind,
    lifecycle: LIFECYCLE_MAP[str(entry.workflow_status) ?? ""] ?? "pending",
    status,
    unitId: str(entry.unit),
    region: str(entry.region) ?? defaultRegion,
    symbol: str(entry.symbol),
    address: str(entry.address),
    milestone: str(entry.milestone),
    requiredLevel: str(entry.required_level),
    size: parseSize(entry.size),
    source: str(entry.source),
    attempts: 0,
    exhausted: false,
    ready: false,
    meta,
  };
}

/**
 * Resolve the xenoblade repo root: `DECOMPI_XENOBLADE_ROOT` →
 * `XENOBLADE_REPO` → the sibling-of-decompi checkout (the same default the
 * diff-engine.py worker resolves for itself).
 */
export function resolveXenobladeRoot(): string {
  const envRoot = process.env.DECOMPI_XENOBLADE_ROOT ?? process.env.XENOBLADE_REPO;
  if (envRoot) return envRoot;
  // <parent>/decompi/adapters/xenoblade/adapter.ts → <parent>/xenoblade
  return fileURLToPath(new URL("../../../xenoblade", import.meta.url));
}

/**
 * Resolve the venv python that runs the worker: `DECOMPI_XENOBLADE_PYTHON`
 * → `<root>/.venv/bin/python3`.
 */
export function resolveXenobladePython(root: string): string {
  return process.env.DECOMPI_XENOBLADE_PYTHON ?? join(root, ".venv", "bin", "python3");
}

/**
 * Turn a diff failure into a rejected verdict (SPEC §9) — `verify()` never
 * throws on diff errors. A `WorkerRpcError` carries the hexdiff exit code
 * the diff-engine worker serialised into its error envelope: rc 4 = symbol
 * not found (NOT_FOUND); rc 2/3 = build/usage or object-read failure
 * (NOT_BUILDABLE). Every other failure (crash, timeout, spawn, unknown rc)
 * falls back to the generic NOT_BUILDABLE reject.
 */
function diffFailureVerdict(item: WorkItem, err: unknown): Verdict {
  const message = err instanceof Error ? err.message : String(err);
  let status = "NOT_BUILDABLE";
  let exitCode: number | undefined;
  if (err instanceof WorkerRpcError) {
    exitCode = err.exitCode;
    if (exitCode === 4) status = "NOT_FOUND";
    else if (exitCode === 2 || exitCode === 3) status = "NOT_BUILDABLE";
  }
  return {
    accepted: false,
    status,
    evidence: {
      symbol: item.symbol,
      unit: item.unitId,
      diff: { error: message, exit_code: exitCode },
    },
    feedback: `diff failed for ${item.symbol ?? item.id}: ${message}`,
  };
}

export class XenobladeAdapter implements GameAdapter {
  readonly id = "xenoblade";

  /**
   * The single persistent worker pool (SPEC §7.1 warmup): created lazily on
   * the first `diff()` and reused for the adapter's lifetime, so the
   * ~270 ms interpreter/import startup is paid ONCE, not per request.
   * `dispose()` closes it; a later `diff()` lazily constructs a fresh pool.
   */
  private pool: WorkerPool | null = null;

  private poolFor(): WorkerPool {
    if (this.pool === null) this.pool = new WorkerPool(this.diffEngine());
    return this.pool;
  }

  /** SPEC §7.1 worker spec for the persistent NDJSON diff engine. */
  diffEngine(): WorkerSpec {
    const root = resolveXenobladeRoot();
    const python = resolveXenobladePython(root);
    // diff-engine.py ships with DECOMPI (adapters/xenoblade/), next to this
    // adapter; `--repo` carries the xenoblade checkout root.
    const engine = fileURLToPath(new URL("diff-engine.py", import.meta.url));
    if (!existsSync(engine)) {
      throw new Error(
        `xenoblade adapter: diff engine not found at ${engine} (is this a decompi checkout?)`,
      );
    }
    if (!existsSync(join(root, "tools", "coop", "hexdiff.py"))) {
      throw new Error(
        `xenoblade adapter: hexdiff.py not found under ${root} — is DECOMPI_XENOBLADE_ROOT pointing at the xenoblade repo?`,
      );
    }
    if (!existsSync(python)) {
      throw new Error(
        `xenoblade adapter: venv python not found at ${python} (set DECOMPI_XENOBLADE_PYTHON or create the repo .venv)`,
      );
    }
    // The worker resolves its repo root from argv `--repo` first, then the
    // XENOBLADE_REPO env var. WorkerPool passes `WorkerSpec.env` through to
    // spawn, so the adapter converges the worker's view on its resolved root
    // WITHOUT mutating process.env — that is what makes the
    // DECOMPI_XENOBLADE_ROOT override actually reach the worker.
    return {
      command: [python, engine, "--repo", root],
      protocol: "ndjson",
      timeoutMs: DIFF_TIMEOUT_MS,
      poolSize: DIFF_POOL_SIZE,
      env: { ...process.env, XENOBLADE_REPO: root },
    };
  }

  /**
   * One "diff" RPC on the adapter's persistent `WorkerPool` (lazily created
   * by the first call). Always `--no-build` — M2.5 diffs against objects
   * that already exist and never invokes ninja, so it assumes no concurrent
   * build is mutating them; the build flock (`buildLockPath()`) is wrapped
   * around build-performing RPCs by the M3/M4 daemon (SPEC §7.1), not by
   * this adapter.
   */
  async diff(ctx: AdapterCtx, item: WorkItem): Promise<DiffResult> {
    const unit = item.unitId;
    const symbol = item.symbol;
    if (!unit || !symbol) {
      throw new Error(
        `xenoblade adapter: diff requires a work item with unitId + symbol, got ${JSON.stringify({ id: item.id, unit, symbol })}`,
      );
    }
    const pool = this.poolFor();
    return (await pool.request("diff", { unit, symbol, build: false })) as DiffResult;
  }

  /** SPEC §9 diff verifier: accepted iff the instruction diff is clean
   * (`mismatch_count === 0`); status FULL_MATCH on acceptance, rejected with
   * feedback otherwise. Diff failures are converted to rejected verdicts
   * (`diffFailureVerdict`), never thrown. */
  async verify(ctx: AdapterCtx, item: WorkItem): Promise<Verdict> {
    let result: DiffResult;
    try {
      result = await this.diff(ctx, item);
    } catch (err) {
      return diffFailureVerdict(item, err);
    }
    const accepted = result.mismatch_count === 0;
    const evidence: Record<string, unknown> = {
      symbol: result.symbol,
      unit: item.unitId,
      diff: {
        total_instructions: result.total_instructions,
        mismatch_count: result.mismatch_count,
        reg_swap_count: result.reg_swap_count,
        structural_count: result.structural_count,
        retail_size: result.retail_size,
        decomp_size: result.decomp_size,
      },
    };
    if (!accepted) {
      return {
        accepted: false,
        evidence,
        feedback:
          `diff mismatch: ${result.mismatch_count}/${result.total_instructions} ` +
          `instructions differ (${result.structural_count} structural, ` +
          `${result.reg_swap_count} reg-swap)`,
      };
    }
    return { accepted: true, status: "FULL_MATCH", evidence };
  }

  /** Close the persistent worker pool (idempotent). The adapter stays
   * usable: the next `diff()` lazily constructs a fresh pool. Core calls
   * this at shutdown. */
  async dispose(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool !== null) await pool.close();
  }

  /** Xenoblade status vocabulary (SPEC §7): accepted on byte-identity
   * (FULL_MATCH) or the witness (EQUIVALENT_MATCH); rejected on build or
   * symbol lookup failure. */
  statusVocab(): StatusVocab {
    return {
      accepted: ["FULL_MATCH", "EQUIVALENT_MATCH"],
      rejected: ["NOT_BUILDABLE", "NOT_FOUND"],
      pending: [],
    };
  }

  /** Xenoblade placeholder patterns (SPEC §7): dtk `func_` / `Class_`
   * names plus lint.py's unanchored Unk* family; labels/data are not
   * tracked. */
  placeholderPatterns(): PlaceholderPatterns {
    return {
      function: "^func_[0-9A-Fa-f]{7,8}$",
      class: "^Class_[0-9A-Fa-f]+",
      unknown: "UnkClass_|UnkStruct_|UnkVirtualFunc|unk[0-9A-Fa-f]+",
      label: "",
      data: "",
    };
  }

  /**
   * The repo-wide build lock held around hexdiff builds —
   * `build/<region>/.hexdiff.lock`. Region defaults to "us" (the coop
   * config default); override with `DECOMPI_XENOBLADE_REGION`.
   */
  buildLockPath(_ctx: AdapterCtx): string {
    const region = process.env.DECOMPI_XENOBLADE_REGION ?? "us";
    return join(resolveXenobladeRoot(), "build", region, ".hexdiff.lock");
  }

  /** The §13 lint rule registry is core-side (src/parse/cpp); the adapter
   * wires none in M2.5. */
  lintRules(): LintRule[] {
    return [];
  }

  /** No style guide ships with M2.5. */
  styleGuidePath(): string {
    return "";
  }

  /**
   * SPEC §6.4 live read (M5 cut-over): parse `<root>/tools/coop/targets.json`
   * (root resolved exactly like `diffEngine()` — DECOMPI_XENOBLADE_ROOT →
   * XENOBLADE_REPO → the sibling checkout) and map every target to a
   * WorkItem. This is a READ, not a migration: promoted columns follow the
   * §6.4 field map, materialized columns (`attempts`/`exhausted`/`ready`)
   * stay at their defaults, and every un-mapped field (instruction_match,
   * called_functions, depends_on, capabilities, …) is preserved in `meta`.
   * The parsed file is cached module-level (keyed by mtime/size), so
   * repeated imports of the 18 MB registry don't re-parse it. The store
   * insert is the daemon's job (`StoreDaemon.importWorkItems`); this adapter
   * only reads.
   */
  async importWorkItems(_ctx: AdapterCtx): Promise<WorkItem[]> {
    const defaultRegion = process.env.DECOMPI_XENOBLADE_REGION ?? "us";
    const doc = loadTargetsJson(
      join(resolveXenobladeRoot(), "tools", "coop", "targets.json"),
    );
    return doc.targets.map((target, index) => mapTarget(target, index, defaultRegion));
  }
}

/** Adapter discovery shape (SPEC §7): a default export implementing GameAdapter. */
export default new XenobladeAdapter();
