/**
 * Xenoblade workflow-authoring augmentation (SPEC §2/§3, task 11).
 *
 * Augments the core `WorkItemKindMap` / `WorkflowHelpers` interfaces (via
 * the package `exports` self-reference in package.json — see `src/index.ts`)
 * with the xenoblade function vocabulary, and ships the concrete aliases +
 * `registerHelpers()` stub the engine/daemon integration will call.
 *
 * `FunctionWorkItem` carries `asmText` (the retail assembly text for the
 * function, as loaded/fetched for the match prompt) so the augmentation is
 * structurally identical to the local vocab used by
 * `tests/workflow-types.test.ts` — interface merging requires same-named
 * `WorkItemKindMap` members to have the same type (TS2717), so the adapter
 * and the typing test MUST agree on the shape. The `getFunctionAsm` helper
 * is the fetch path for exactly that field; both helpers are stubs until the
 * coop tooling milestone wires them.
 */
import type { WorkItem } from "../../src/types.js";
import type { HelperRegistry } from "../../src/workflow/helpers.js";

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
  }
}

/**
 * NOT WIRED — placeholder. `getFunctionAsm` needs the retail-asm data source
 * (the `retailAsmIndex`/objdump milestone in `adapter.ts`); until then the
 * stub rejects loudly so a workflow that calls it fails fast with a clear
 * message instead of silently prompting on empty asm.
 */
export async function getFunctionAsm(_t: FunctionWorkItem): Promise<string> {
  throw new Error(
    "xenoblade workflow helper getFunctionAsm: not wired (the retail-asm source " +
      "lands with the asm/symbol data-source milestone)",
  );
}

/**
 * NOT WIRED — placeholder. `runBatchCycle` will delegate to the coop
 * `tools/coop/batch-cycle.py` runner (per-target diff + status update);
 * until then the stub rejects loudly.
 */
export async function runBatchCycle(_targets: FunctionWorkItem[]): Promise<BatchCycleResult[]> {
  throw new Error(
    "xenoblade workflow helper runBatchCycle: not wired (the coop batch-cycle " +
      "runner lands with the coop tooling milestone)",
  );
}

/**
 * Register the xenoblade workflow helpers into a `HelperRegistry` (the
 * facade's registry — `Decompi.helpers` — or the engine's). Placeholder
 * implementations today; the wiring point is the only contract that matters
 * now.
 */
export function registerHelpers(registry: HelperRegistry): void {
  registry.register("getFunctionAsm", getFunctionAsm);
  registry.register("runBatchCycle", runBatchCycle);
}
