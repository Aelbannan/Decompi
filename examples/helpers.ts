/**
 * Reference-example game helpers (SPEC §C / §B): the example workflows'
 * adapter vocabulary — the xenoblade function work item, the coop
 * batch-cycle result, and the four adapter-augmented `WorkflowHelpers`
 * members the examples call from their hooks.
 *
 * These are STUBS. The real implementations live behind the adapter
 * (`adapters/xenoblade/workflow.ts` ships `registerHelpers()` for exactly
 * this surface — `getFunctionAsm` / `runBatchCycle` are wired there once the
 * retail-asm and coop batch-cycle tooling milestones land); the example
 * module exists so the workflows compile, typecheck, and run against fake
 * data today. Swap the import/wiring later, not the hook call sites.
 *
 * The `declare module "decompi"` augmentation is type-only: it attaches to
 * the core `WorkItemKindMap` / `WorkflowHelpers` interfaces via the package
 * `exports` self-reference. NOTE — `WorkItemKindMap.function` is declared
 * here with the SAME shape as the adapter's `FunctionWorkItem` (including
 * `asmText`): TS2717 requires every same-named `WorkItemKindMap` member in
 * one compilation to agree on its type, so the examples and the adapter MUST
 * stay in lockstep.
 */
import type { WorkItem } from "../src/types.js";

/** A xenoblade function work item (shape identical to the adapter's — see TS2717 note above). */
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
    /** Estimate a function's match difficulty (for batching/routing). */
    estimateDifficulty(t: FunctionWorkItem): Promise<number>;
  }
}

/**
 * STUB — returns a fake asm string for the target. The real helper fetches
 * the retail asm text (`asmText`) from the retail-asm index once wired.
 */
export async function getFunctionAsm(t: FunctionWorkItem): Promise<string> {
  return `; stub asm for ${t.id}${t.symbol ? ` (${t.symbol})` : ""}\n  blr`;
}

/**
 * STUB — every function comes back accepted. The real helper delegates to
 * the coop `tools/coop/batch-cycle.py` runner (per-target diff + status).
 */
export async function runBatchCycle(targets: FunctionWorkItem[]): Promise<BatchCycleResult[]> {
  return targets.map((t) => ({
    target: t,
    targetId: t.id,
    accepted: true,
    status: "FULL_MATCH",
  }));
}

/** STUB — a canned layout. The real helper wraps `struct_layout.py`-style tooling. */
export async function structLayout(unit: string): Promise<string> {
  return `; stub struct layout for ${unit === "" ? "(unknown unit)" : unit}\n  (wired to struct_layout.py-style tooling)`;
}

/** STUB — difficulty = function size. The real helper reads the call graph / asm shape. */
export async function estimateDifficulty(t: FunctionWorkItem): Promise<number> {
  return t.size ?? 0;
}
