/**
 * Workflow → Pipeline compiler (SPEC §4): turns a typed `Workflow` into a
 * `Pipeline` whose plan selects the workflow's kind through `def.select`
 * (run scope ∩ completion subtracted) and whose body is ONE `foreach` of an
 * `agentLoop`, with `onReject` routes compiled to steps-only fragments
 * (rebatch = default batch, singleton = batch 1).
 *
 * Compiled shape (SPEC §4 "Compilation map"):
 *
 *   accepts/select        → plan(): `{ kind: [K], ...select }` ∩ scope − isDone(wf, ·)
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
 * Scope/status handles: the engine's `StepCtx` does not carry the run
 * scope or the status store yet, so the plan reads `ctx.scope` through an
 * optional intersection type (absent = unscoped) and captures the status
 * store at compile time (`CompileOptions.statusesStore`; absent = nothing is
 * pre-completed, mirroring the "stub until the daemon wires it" pattern in
 * `helpers.ts`).
 */
import type { AgentTurn } from "../pipeline/engine.js";
import type { Pipeline, Route, Step, StepCtx } from "../pipeline/types.js";
import type { Selector, WorkItem } from "../types.js";
import type { WorkflowStatusStore } from "./status.js";
import { makeBuiltinHelpers, makeStartJsonAgent } from "./helpers.js";
import type { HelperRegistry, ReadonlyStore, WorkflowHelpers } from "./helpers.js";
import { isReservedToolName } from "./types.js";
import type {
  CompletionAction,
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

/** The status ladder defaults (SPEC §A.1). */
export const DEFAULT_STATUSES = ["DONE"] as const;

/**
 * Resolve a workflow's status ladder with its defaults (SPEC §A.1):
 * `statuses` defaults to `["DONE"]`; `doneStatuses` defaults to the LAST
 * status; `completionStatus` defaults to the LAST status. The resolved
 * triple is compiled onto the pipeline so the engine can read it.
 */
export function resolveLadder(def: {
  statuses?: string[];
  doneStatuses?: string[];
  completionStatus?: string;
}): { statuses: string[]; doneStatuses: string[]; completionStatus: string } {
  const statuses = def.statuses ?? [...DEFAULT_STATUSES];
  const last = statuses[statuses.length - 1] ?? "DONE";
  return {
    statuses,
    doneStatuses: def.doneStatuses ?? [last],
    completionStatus: def.completionStatus ?? last,
  };
}

/** Options for {@link compileWorkflow}. */
export interface CompileOptions {
  /**
   * Workflow status store (SPEC §A.3): the compiled plan subtracts done
   * targets (`isDone(wf, ·, doneStatuses)`). Absent = nothing is
   * pre-completed; the daemon path wires the store later (a workflow stays
   * fully selectable until then).
   */
  statusesStore?: WorkflowStatusStore;
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

/**
 * Adapt `def.complete` to the engine's `agentLoop.complete` surface
 * (SPEC §2/§5.2): the decider returns what "complete" means for ONE target;
 * the engine executes it via `ctx.finalize` with the returned
 * `CompletionAction`. Absent when the workflow declares no `complete` — the
 * engine then defaults to `{ promote: true, status: completionStatus }`.
 */
function adaptComplete<K extends WorkItemKind, H extends Record<string, unknown>>(
  def: WorkflowDef<K, H>,
): (target: WorkItem, ctx: StepCtx) => Promise<CompletionAction> {
  return async (target, ctx) =>
    def.complete!(
      target as WorkItemOf<K>,
      forwardCtx<K, H>(ctx, def, ctx.lastAgentResult),
    );
}

/** Build the `agentLoop` step shared by the main foreach and the fragments. */
function agentLoopStep<K extends WorkItemKind, H extends Record<string, unknown>>(
  def: WorkflowDef<K, H>,
  completionStatus: string,
): Step {
  return {
    kind: "agentLoop",
    start: adaptStart(def),
    reprompt: adaptReprompt(def),
    ...(def.rejectionRetries !== undefined ? { rejectionRetries: def.rejectionRetries } : {}),
    ...(def.complete !== undefined ? { complete: adaptComplete(def) } : {}),
    ...(def.customTools !== undefined && def.customTools.length > 0
      ? { customTools: def.customTools }
      : {}),
    ...(completionStatus !== undefined ? { completionStatus } : {}),
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
  // Status ladder (SPEC §A.1): resolved once here, compiled onto the
  // pipeline (engine-readable) and used by the plan's done-subtraction.
  const ladder = resolveLadder(def);
  // Reserved core tool names (SPEC §B.1): a workflow custom tool shadowing a
  // core built-in (`finish`/`select`/`status`/`lint`) is a compile-time error
  // — the core toolset cannot be shadowed.
  for (const tool of def.customTools ?? []) {
    if (isReservedToolName(tool.name)) {
      throw new Error(
        `workflow "${w.id}": custom tool "${tool.name}" is core-reserved ` +
          `(finish/select/status/lint) — rename the tool`,
      );
    }
  }
  // canBatch: false = one target per session (batch 1); default batch = 5.
  const batch = def.canBatch === false ? 1 : (def.defaultBatchSize ?? DEFAULT_BATCH_SIZE);
  // One shared descriptor: the engine reads steps immutably, so the main
  // foreach and every route fragment can reuse the same agentLoop.
  const loop = agentLoopStep(def, ladder.completionStatus);

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
    // The status ladder, compiled so the engine can read it (the engine's
    // default finalize writes `completionStatus`; plans/verifiers can use
    // `doneStatuses`/`statuses`).
    statuses: ladder.statuses,
    doneStatuses: ladder.doneStatuses,
    completionStatus: ladder.completionStatus,
    ...(opts?.helpers !== undefined ? { helpers: opts.helpers } : {}),
    plan: async (ctx: PlanCtx) => {
      const items = await ctx.select(selector);
      const scoped = applyScopeSelector(items, ctx.scope);
      if (opts?.statusesStore === undefined) return scoped;
      const open: WorkItem[] = [];
      for (const item of scoped) {
        // SPEC §A.3: subtract targets whose RESOLVED status is done — never
        // a raw OR over scopes (target-within-unit > target > unit).
        if (!(await opts.statusesStore.isDone(w.id, item, ladder.doneStatuses))) {
          open.push(item);
        }
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
