/**
 * Workflow → Pipeline compiler (SPEC §4): turns a typed `Workflow` into a
 * `Pipeline` whose plan selects the workflow's kind through `def.select`
 * (run scope ∩ completion subtracted) and whose body is ONE `foreach` of an
 * `agentLoop`, with `onReject` routes compiled to steps-only fragments
 * (rebatch = default batch, singleton = batch 1).
 *
 * Compiled shape (SPEC §4 "Compilation map"):
 *
 *   accepts/select        → plan(): `{ kind: [K], ...select }` ∩ scope − isComplete(wf, ·)
 *   canBatch/defaultBatch → foreach.batch
 *   startPrompt/reprompt  → agentLoop (the engine holds ONE session across turns)
 *   routes                → onReject → named fragments:
 *                            `when.sizeBelow` → rebatch fragment (batch = defaultBatchSize)
 *                            otherwise        → singleton fragment (batch 1)
 *
 * The compiler only EMITS the graph; the engine (`src/pipeline/engine.ts`)
 * executes it. The workflow `def` is private on the class, so the compiler
 * reads it through the `Workflow.definition` getter.
 *
 * Scope/completion handles: the engine's `StepCtx` does not carry the run
 * scope or the completion store yet, so the plan reads `ctx.scope` through an
 * optional intersection type (absent = unscoped) and captures the completion
 * store at compile time (`CompileOptions.completions`; absent = nothing is
 * pre-completed, mirroring the "stub until the daemon wires it" pattern in
 * `helpers.ts`).
 */
import type { AgentTurn } from "../pipeline/engine.js";
import type { Pipeline, Route, Step, StepCtx } from "../pipeline/types.js";
import type { Selector, WorkItem } from "../types.js";
import type { WorkflowCompletionStore } from "./completions.js";
import { makeBuiltinHelpers, makeStartJsonAgent } from "./helpers.js";
import type { HelperRegistry, ReadonlyStore, WorkflowHelpers } from "./helpers.js";
import type {
  RunScope,
  Workflow,
  WorkflowConfig,
  WorkflowCtx,
  WorkflowDef,
  WorkItemKind,
  WorkItemOf,
} from "./types.js";

/** Default `foreach.batch` when `defaultBatchSize` is absent (SPEC §2: default 5). */
export const DEFAULT_BATCH_SIZE = 5;

/** Options for {@link compileWorkflow}. */
export interface CompileOptions {
  /**
   * Workflow completion store (SPEC §5): the compiled plan subtracts
   * completed targets (`isComplete(wf, ·)`). Absent = nothing is
   * pre-completed; the daemon path wires the store later (a workflow stays
   * fully selectable until then).
   */
  completions?: WorkflowCompletionStore;
  /**
   * Adapter-wide helper registry (SPEC §3): compiled ONTO the pipeline as
   * its run default — the engine materializes it into `ctx.helpers` (via
   * `RunState` → `StepCtx`) when the run context supplies none. Absent =
   * the run context must carry the registry (or hooks see only built-ins +
   * workflow-local helpers).
   */
  helpers?: HelperRegistry;
}

/** A compiled workflow: the runnable pipeline plus its `onReject` fragments. */
export interface CompiledWorkflow {
  pipeline: Pipeline;
  /** `fragmentId(workflowId, i)` → steps-only fragment for route `i`. */
  fragments: Map<string, Step[]>;
}

/**
 * Deterministic fragment id for route `index` of workflow `workflowId`.
 * Route `i` of a workflow maps `onReject: { to: fragmentId(wf.id, i) }`.
 */
export function fragmentId(workflowId: string, index: number): string {
  return `${workflowId}#fragment${index}`;
}

/**
 * Post-hoc run-scope filter (SPEC §6): `targetIds` and `unitIds` are AND-ed
 * into the selected items — an item must be in `targetIds` when given AND in
 * `unitIds` when given. No scope = items unchanged.
 */
export function applyScopeSelector(items: WorkItem[], scope: RunScope | undefined): WorkItem[] {
  if (scope === undefined) return items;
  return items.filter((item) => {
    if (scope.targetIds !== undefined && !scope.targetIds.includes(item.id)) return false;
    if (
      scope.unitIds !== undefined &&
      (item.unitId === undefined || !scope.unitIds.includes(item.unitId))
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Plan context: the engine's `StepCtx` plus the run-scope handle (SPEC §6).
 * The engine does not thread `scope` yet — the member is optional so the
 * compiled plan degrades to unscoped when it is absent.
 */
export type PlanCtx = StepCtx & { scope?: RunScope };

/**
 * Read-only store view for hooks when the run supplies none — an empty-query
 * stub that mirrors the codebase's "stub until the daemon wires it" pattern
 * (`emit` resolves 0, `finalize` no-ops). Hooks always see a DEFINED
 * `ctx.store` / `helpers.store`; a real store is threaded by the run
 * integration (a later engine task, alongside `foreach.setup` consumption).
 */
const NULL_STORE: ReadonlyStore = { query: async () => [] };

/**
 * Forward an engine `StepCtx` to a workflow hook as the typed `WorkflowCtx`
 * (SPEC §3): `ctx.helpers` is MATERIALIZED here — built-in helpers
 * (`makeBuiltinHelpers(store, select)`) merged with the adapter-wide
 * `HelperRegistry` (when the run supplies one on the StepCtx) and then the
 * workflow's local `def.helpers` (local wins, last spread). `ctx.store` is
 * the run's read-only view (absent = `NULL_STORE`). `ctx.StartJsonAgent` is
 * bound to the run's runtime, so judge calls go through the same
 * pacing/budget-wrapped runtime as `agent` turns (SPEC §A.2). The remaining
 * fields (`runtime`, `select`, `log`, `finalize`) are forwarded as-is; the
 * current `AgentTurn` is merged in for reprompt. `scope` stays run-supplied
 * (the engine threads it in a later task; absent = unscoped) — the final
 * cast documents ONLY that residual hole, not the helpers surface.
 */
function forwardCtx<K extends WorkItemKind, H extends Record<string, unknown>>(
  ctx: StepCtx,
  def: WorkflowDef<K, H>,
  lastTurn?: AgentTurn,
): WorkflowCtx<K, H> {
  const store: ReadonlyStore = ctx.store ?? NULL_STORE;
  const helpers = {
    ...makeBuiltinHelpers(store, ctx.select),
    ...(ctx.helpers === undefined ? {} : ctx.helpers.toObject()),
    ...(def.helpers ?? {}),
  } as WorkflowHelpers & H;
  const forwarded: Omit<WorkflowCtx<K, H>, "scope" | "lastTurn" | "finalize"> & {
    lastTurn?: AgentTurn;
    finalize?: WorkflowCtx<K, H>["finalize"];
  } = {
    runtime: ctx.runtime,
    select: ctx.select,
    log: ctx.log,
    helpers,
    store,
    StartJsonAgent: makeStartJsonAgent(ctx.runtime),
    ...(ctx.finalize !== undefined ? { finalize: ctx.finalize as WorkflowCtx<K, H>["finalize"] } : {}),
    ...(lastTurn !== undefined ? { lastTurn } : {}),
  };
  return forwarded as WorkflowCtx<K, H>;
}

/** Adapt `def.startPrompt` to the engine's `agentLoop.start` surface. */
function adaptStart<K extends WorkItemKind, H extends Record<string, unknown>>(
  def: WorkflowDef<K, H>,
): (targets: WorkItem[], ctx: StepCtx) => Promise<string> {
  return async (targets, ctx) =>
    def.startPrompt(targets as WorkItemOf<K>[], forwardCtx<K, H>(ctx, def));
}

/**
 * Adapt `def.reprompt` to the engine's `agentLoop.reprompt` surface.
 * `WorkItemOf<K>` is a WorkItem subtype for declared kinds, but the generic
 * compiler cannot prove it, so the verdict is widened explicitly.
 */
function adaptReprompt<K extends WorkItemKind, H extends Record<string, unknown>>(
  def: WorkflowDef<K, H>,
): (
  targets: WorkItem[],
  ctx: StepCtx,
  lastTurn: AgentTurn,
) => Promise<{ accepted: WorkItem[]; rejected: WorkItem[]; feedback?: string; final?: boolean }> {
  return async (targets, ctx, lastTurn) => {
    const verdict = await def.reprompt(
      targets as WorkItemOf<K>[],
      forwardCtx<K, H>(ctx, def, lastTurn),
      lastTurn,
    );
    return verdict as unknown as {
      accepted: WorkItem[];
      rejected: WorkItem[];
      feedback?: string;
      final?: boolean;
    };
  };
}

/**
 * Adapt `def.setup` to the compiled `foreach`'s setup surface (SPEC §A.1):
 * `(targets, ctx) => Promise<WorkflowConfig>`. Absent when the workflow
 * declares no `setup` (the engine skips the hook then).
 */
function adaptSetup<K extends WorkItemKind, H extends Record<string, unknown>>(
  def: WorkflowDef<K, H>,
): ((targets: WorkItem[], ctx: StepCtx) => Promise<WorkflowConfig>) | undefined {
  if (def.setup === undefined) return undefined;
  return async (targets, ctx) =>
    def.setup!(targets as WorkItemOf<K>[], forwardCtx<K, H>(ctx, def));
}

/** Build the `agentLoop` step shared by the main foreach and the fragments. */
function agentLoopStep<K extends WorkItemKind, H extends Record<string, unknown>>(
  def: WorkflowDef<K, H>,
): Step {
  return {
    kind: "agentLoop",
    start: adaptStart(def),
    reprompt: adaptReprompt(def),
    ...(def.rejectionRetries !== undefined ? { rejectionRetries: def.rejectionRetries } : {}),
  };
}

/**
 * Compile a `Workflow` into a runnable `Pipeline` plus its `onReject`
 * fragments (SPEC §4). `Workflow.compile()` is the thin entry point;
 * `addWorkflow` uses this to register both halves on the engine.
 */
export function compileWorkflow<K extends WorkItemKind, H extends Record<string, unknown>>(
  w: Workflow<K, H>,
  opts?: CompileOptions,
): CompiledWorkflow {
  const def = w.definition;
  // canBatch: false = one target per session (batch 1); default batch = 5.
  const batch = def.canBatch === false ? 1 : (def.defaultBatchSize ?? DEFAULT_BATCH_SIZE);
  // One shared descriptor: the engine reads steps immutably, so the main
  // foreach and every route fragment can reuse the same agentLoop.
  const loop = agentLoopStep(def);

  // Plan selector: kind is ALWAYS = accepts; def.select narrows it further
  // (status/sort/limit; ids are excluded from def.select — scope owns them).
  const selector: Selector = {
    filter: { kind: [w.accepts], ...(def.select?.filter ?? {}) },
  };
  if (def.select?.sort !== undefined) selector.sort = def.select.sort;
  if (def.select?.limit !== undefined) selector.limit = def.select.limit;

  // Each route becomes an ordered onReject entry targeting its own fragment.
  const routes: Route[] = (def.routes ?? []).map((r, i) => ({
    when: r.when,
    to: fragmentId(w.id, i),
    model: r.model,
    maxAttempts: r.maxAttempts,
  }));

  // Per-batch config hook, compiled onto the foreach steps (SPEC §A.1). The
  // ENGINE consumes it in a later task; emitting it now carries `setup`
  // through the compiled shape so the engine can pick it up unchanged.
  const setup = adaptSetup(def);

  // Fragment per route (SPEC §4 simplification): `when.sizeBelow` → rebatch
  // at the default batch size; routes without it → singleton (batch 1).
  // Fragments REUSE the compiled loop — and the per-batch `setup` re-runs
  // inside them (SPEC §A.1 "fragments reuse the compiled loop").
  const fragments = new Map<string, Step[]>();
  for (const [i, route] of (def.routes ?? []).entries()) {
    const rebatch = route.when?.sizeBelow !== undefined;
    fragments.set(fragmentId(w.id, i), [
      {
        kind: "foreach",
        batch: rebatch ? batch : 1,
        steps: [loop],
        ...(setup !== undefined ? { setup } : {}),
      },
    ]);
  }

  const pipeline: Pipeline = {
    id: w.id,
    adapter: "workflow",
    ...(opts?.helpers !== undefined ? { helpers: opts.helpers } : {}),
    plan: async (ctx: PlanCtx) => {
      const items = await ctx.select(selector);
      const scoped = applyScopeSelector(items, ctx.scope);
      if (opts?.completions === undefined) return scoped;
      const open: WorkItem[] = [];
      for (const item of scoped) {
        if (!(await opts.completions.isComplete(w.id, item))) open.push(item);
      }
      return open;
    },
    steps: [
      {
        kind: "foreach",
        batch,
        steps: [loop],
        ...(setup !== undefined ? { setup } : {}),
        ...(routes.length > 0 ? { onReject: routes } : {}),
      },
    ],
  };

  return { pipeline, fragments };
}
