/**
 * Game adapter contract (SPEC §7) — the adapter-facing surface of Decompi.
 *
 * M2.5 extends the M0 slice (adapter identity + registry import) to the full
 * §7 `GameAdapter`: build/diff/verify, worker engines (`diffEngine` /
 * `witnessEngine`), lint + placeholder + status vocabulary, data-source hooks
 * for the asm/symbol rules, and the build lock path. Members marked `?` are
 * optional — a milestone may ship a partial adapter; the required members
 * (`id`, `importWorkItems`, `verify`, `lintRules`, `placeholderPatterns`,
 * `styleGuidePath`, `statusVocab`, `buildLockPath`) must be implemented by
 * every adapter.
 *
 * `WorkerSpec` is defined ONCE, in `src/core/worker.ts` (the pool that spawns
 * and drives the worker processes), and re-exported here so the spec surface
 * and the implementation cannot drift.
 */
import type { SqlAdapter } from "../core/store/adapter.js";
import type { WorkItem, Verdict } from "../types.js";
import type { SymbolTable } from "../parse/symbols/table.js";
import type { RelocMap } from "../parse/symbols/reloc-map.js";
import type { WorkerSpec } from "../core/worker.js";

export type { WorkerSpec };

/**
 * Context handed to adapter methods (SPEC §7). M2.5 carries the store only;
 * the worker-pool handoff (`AdapterCtx.workers.call(spec, method, params)`,
 * SPEC §7.1) arrives with the M4 daemon — until then adapters build their own
 * pool from `diffEngine()` / `witnessEngine()`.
 */
export interface AdapterCtx {
  store: SqlAdapter;
}

// ── build / diff / report result shapes ────────────────────────────────────

/** Result of `buildUnit` (SPEC §7) — a build of one decomp object. */
export interface BuildResult {
  ok: boolean;
  unit: string;
  /** Exit code of the build command, when known. */
  exitCode?: number;
  /** Build stdout/stderr tail, for diagnostics. */
  output?: string;
  /** Path of the produced decomp object, when the build succeeded. */
  objectPath?: string;
}

/** One 4-byte row of the hexdiff instruction diff (SPEC §9 `DiffResult`). */
export interface DiffInstruction {
  /** Byte offset into the function, 4-aligned. */
  offset: number;
  /** Retail word as "0x........", or null past the end of one side. */
  retail_hex: string | null;
  decomp_hex: string | null;
  /** Disassembled text (mnemonic + operands), or null when the word is absent. */
  retail_asm: string | null;
  decomp_asm: string | null;
  /** Byte equality (a reloc placeholder side counts as non-matching). */
  match: boolean;
  has_decomp_reloc: boolean;
  reg_swap: boolean;
  pure_reg_swap: boolean;
  structural: boolean;
}

/** A register-swap summary entry (`hexdiff --json` `reg_mapping`). */
export interface RegSwapEntry {
  retail_reg: number;
  decomp_regs: number[];
}

/** The split-budget size check embedded in the hexdiff JSON. */
export interface SizeCheck {
  budget: number;
  retail_text: number;
  decomp_text: number;
  ok: boolean;
  over_by: number;
  split_path: string;
  notes: string;
}

/** A relocation entry of one side of the diff (`hexdiff --json`). */
export interface Relocation {
  offset: number;
  type: number;
  symbol: string | null;
  addend: number;
}

/**
 * The hexdiff JSON document, typed (Xenoblade `hexdiff._output_json`; the
 * exact document the diff-engine worker returns for method "diff"). Field
 * names mirror the wire format (snake_case).
 */
export interface DiffResult {
  symbol: string;
  retail_path: string;
  decomp_path: string;
  retail_size: number;
  decomp_size: number;
  total_instructions: number;
  mismatch_count: number;
  reg_swap_count: number;
  pure_reg_swap_count: number;
  structural_count: number;
  reg_mapping: Record<string, RegSwapEntry[]>;
  instructions: DiffInstruction[];
  size_check: SizeCheck | null;
  retail_relocations: Relocation[];
  decomp_relocations: Relocation[];
  /** Reloc name-drift findings (best-effort; empty when no drift info). */
  reloc_drift: unknown[];
  /** Mined reloc-fix suggestions (best-effort; empty when none). */
  reloc_suggestions: Record<string, unknown>;
}

/** objdiff unit report (SPEC §7) — match % plus the torn-.o backoff signal
 * (a partial-object read used when the full .o is unavailable). */
export interface UnitReport {
  unit: string;
  codeMatchPct: number;
  dataMatchPct: number;
  fuzzyMatchPct: number;
  /** True when the report was recovered via the torn-.o backoff path. */
  tornObject: boolean;
}

// ── lint / placeholder / status vocabulary ─────────────────────────────────

/** A lint rule descriptor the adapter applies (SPEC §7 / §13 registry). */
export interface LintRule {
  /** Rule id in the registry taxonomy, e.g. "member.N1", "fake_members". */
  id: string;
  /** One-line human description. */
  description: string;
  severity: "error" | "warning" | "info";
}

/**
 * All patterns are adapter-REQUIRED; core provides no misleading defaults
 * (SPEC §7).
 */
export interface PlaceholderPatterns {
  /** e.g. "^func_[0-9A-Fa-f]{7,8}$" (Xenoblade) / "^fn_" (Last Story). */
  function: string;
  class: string;
  /** Un-anchored, matching lint.py's substring semantics
   * (e.g. "UnkClass_|UnkStruct_|UnkVirtualFunc|unk[0-9A-Fa-f]+"). */
  unknown: string;
  label: string;
  data: string;
}

/** Adapter status vocabulary (SPEC §7) — what verify may write. */
export interface StatusVocab {
  /** e.g. ["FULL_MATCH","EQUIVALENT_MATCH"]. */
  accepted: string[];
  /** e.g. ["NOT_BUILDABLE","NOT_FOUND"]. */
  rejected: string[];
  pending: string[];
}

// ── the adapter interface ──────────────────────────────────────────────────

/**
 * A parsed retail .s index (SPEC §7 `retailAsmIndex`; mirrors
 * `member_check.AsmIndex` — per-file instruction lists + function ranges).
 */
export interface AsmIndex {
  /** parsed file path -> flat instruction list, in parse order. */
  fileInsns: Map<string, { address: number; text: string }[]>;
  /** function name -> [start, end) index into its file's instruction list. */
  fnRanges: Map<string, [number, number]>;
}

/** SPEC §7 `GameAdapter` — the full adapter surface. */
export interface GameAdapter {
  id: string;

  // registry + maintenance
  importWorkItems(ctx: AdapterCtx): Promise<WorkItem[]>;
  /** Discover new placeholder functions (targets scan-source). */
  scanSource?(ctx: AdapterCtx): Promise<WorkItem[]>;
  /** Callgraph maintenance (sync-calls). */
  syncCalls?(ctx: AdapterCtx): Promise<void>;
  /** symbols.txt re-sync. */
  syncSymbols?(ctx: AdapterCtx): Promise<void>;

  // build + diff (persistent worker behind a stdio/JSON protocol, §7.1)
  buildUnit?(ctx: AdapterCtx, unit: string): Promise<BuildResult>;
  diff?(ctx: AdapterCtx, item: WorkItem): Promise<DiffResult>;
  /** objdiff report + torn-.o backoff. */
  unitReport?(ctx: AdapterCtx, unit: string): Promise<UnitReport>;

  // acceptance (SPEC §9): sets status + evidence
  verify(ctx: AdapterCtx, item: WorkItem): Promise<Verdict>;

  // lifecycle
  /** Close adapter-owned resources (persistent worker pools etc.). Core
   * calls this at shutdown; an adapter stays usable after dispose (state is
   * lazily re-created on the next call). */
  dispose?(): Promise<void>;

  // worker engines (core owns spawn/lifecycle/pool — §7.1)
  /** hexdiff worker (build+diff). */
  diffEngine?(): WorkerSpec;
  /** equivalence witness worker (Python+z3). */
  witnessEngine?(): WorkerSpec;

  // data sources for asm/symbol rules
  /** symbols.txt (mangled names). */
  symbolTable?(ctx: AdapterCtx): Promise<SymbolTable>;
  /** dtk .s index. */
  retailAsmIndex?(ctx: AdapterCtx): Promise<AsmIndex>;
  relocMap?(ctx: AdapterCtx): Promise<RelocMap>;

  // lint / style
  lintRules(): LintRule[];
  placeholderPatterns(): PlaceholderPatterns;
  styleGuidePath(): string;
  statusVocab(): StatusVocab;

  // build lock
  buildLockPath(ctx: AdapterCtx): string;
}
