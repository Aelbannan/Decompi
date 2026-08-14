/**
 * Pipeline definition types (SPEC §10): `Step` (the smallest executable unit),
 * `Pipeline` (adapter-bound plan + steps), `Route` (retry routing off a
 * `foreach`'s `onReject`), and `StepCtx` (the execution context handed to
 * steps and to `Pipeline.plan`). The engine that executes these lives in
 * `./engine.ts`.
 *
 * Execution model (implemented by `PipelineEngine`):
 *  - bare `steps` run once per run against the items produced by `plan()`;
 *  - `foreach` groups its items (by `key` when set) into batches of `batch`
 *    and runs its child `steps` once PER batch (one shared agent session);
 *  - `select` stores a named binding consumed by a later `foreach.from`;
 *  - `agentLoop` holds one agent session across re-prompt turns: accepted
 *    items are finalized and leave play; rejected items stay in play until
 *    the loop exits (empty play, `final`, or `rejectionRetries` cap) and then
 *    surface as rejected (routed by `onReject` inside a foreach);
 *  - `onReject` routes rejected items to steps-only fragments (see `Route`).
 */
import type { Selector, Verifier, WorkItem } from "../types.js";
import type { AgentRuntime, SessionUsage } from "../agent/runtime.js";
import type { PromptSpec } from "../prompt/builder.js";
// Type-only: erased at compile time, so the cycle engine.ts <-> types.ts is safe.
import type { AgentTurn } from "./engine.js";
import type { HelperRegistry, ReadonlyStore } from "../workflow/helpers.js";
import type { CompletionAction, Tool, WorkflowConfig } from "../workflow/types.js";

/** The most recent agent turn in a scope (set by `agent` steps; shared across foreach forks). */
export interface LastAgentResult {
  model: string;
  /** The agent's final reply text. */
  text: string;
  usage: SessionUsage;
  /** sha256 of the injected style guide ("" when none); part of the prompt id (SPEC §12). */
  styleGuideHash: string;
}

/** Execution context handed to steps (and to `Pipeline.plan`). */
export interface StepCtx {
  runtime: AgentRuntime;
  verifiers: Map<string, Verifier>;
  select(selector: Selector): Promise<WorkItem[]>;
  items: WorkItem[]; // current scope items
  bindings: Map<string, WorkItem[]>;
  run(step: Step, items: WorkItem[]): Promise<StepOutcome>;
  log(level: string, msg: string): void;
  /**
   * Completion writer for `agentLoop` accepted items (SPEC §4): called with
   * `{ promote: true }` per accepted item. Optional — defaults to a no-op
   * when the run supplies no writer.
   */
  finalize?: (item: WorkItem, action: unknown) => Promise<void>;
  /** Most recent agent turn in this scope (agent steps; transforms may read it). */
  lastAgentResult?: LastAgentResult;
  /**
   * Read-only store view (`query` only) surfaced to workflow hooks as
   * `ctx.store` / `ctx.helpers.store` (SPEC §3). Populated by the run
   * integration; absent = an empty-query stub (stub-until-wired pattern).
   */
  store?: ReadonlyStore;
  /**
   * Adapter-wide helper registry merged into `ctx.helpers` (before the
   * workflow's local `helpers`, which win). Populated by the run integration.
   */
  helpers?: HelperRegistry;
}

/**
 * Per-batch config hook on a compiled `foreach` (SPEC §A.1): the engine runs
 * it ONCE per drawn batch, before the batch's `agentLoop`. `WorkflowConfig`
 * may sub-divide the batch (excess returns to the FRONT of the queue, so
 * every processed window ≤ the static `batch`), pick the loop's model, and
 * override the re-prompt cap. Compiled from `WorkflowDef.setup`; consumed by
 * `runForeachStep` in `./engine.ts`.
 */
export type ForeachSetup = (targets: WorkItem[], ctx: StepCtx) => Promise<WorkflowConfig>;

/** The smallest executable unit of a pipeline (SPEC §10). */
export type Step =
  | { kind: "agent"; prompt: PromptSpec; model?: string; tools?: string[]; maxParallel?: number }
  | { kind: "shell"; run: (ctx: StepCtx) => Promise<string[]> }
  | { kind: "verify"; verifier: string }
  | { kind: "transform"; fn: (ctx: StepCtx) => Promise<void> }
  | { kind: "select"; selector: Selector; into: string }
  | {
      kind: "foreach";
      from?: string;
      batch: number;
      key?: string;
      steps: Step[];
      onReject?: Route[];
      /** Per-batch config hook (SPEC §A.1): run once per drawn batch, before the body. */
      setup?: ForeachSetup;
    }
  | { kind: "gate"; when: (ctx: StepCtx) => boolean | Promise<boolean> }
  | {
      kind: "agentLoop";
      start: (targets: WorkItem[], ctx: StepCtx) => Promise<string>;
      reprompt: (
        targets: WorkItem[],
        ctx: StepCtx,
        lastTurn: AgentTurn,
      ) => Promise<{
        accepted: WorkItem[];
        rejected: WorkItem[];
        feedback?: string;
        final?: boolean;
      }>;
      rejectionRetries?: number;
      model?: string;
      tools?: string[];
      /**
       * Workflow custom tools (definitions), assembled with the engine's core
       * built-ins into the session toolset (SPEC §B.1). Compiled from
       * `WorkflowDef.customTools`; fragments reuse the compiled loop.
       */
      customTools?: Tool[];
      /**
       * Status written by the engine's default run-time acceptance finalize
       * (SPEC §A.1) — the compiled ladder's last status; also the status the
       * `finish` built-in drains with (SPEC §B.4).
       */
      completionStatus?: string;
      /**
       * The workflow's `complete` decider, adapted to the engine surface
       * (SPEC §2/§5.2): called per accepted target; its `CompletionAction` is
       * what the engine finalizes with (absent = default promote +
       * `completionStatus`). Compiled from `WorkflowDef.complete`.
       */
      complete?: (target: WorkItem, ctx: StepCtx) => Promise<CompletionAction>;
    };

/**
 * Ordered retry predicate (SPEC §10). Evaluated in order for each rejected
 * item; the first route whose `when` matches receives the item, which is then
 * run through the named fragment (`to`) under the route's `model`/`maxAttempts`.
 * An empty/absent `when` matches everything (catch-all rebatch branch).
 */
export interface Route {
  when?: { sizeBelow?: number; status?: string[]; attempts?: { min?: number; max?: number } };
  to: string; // named sub-pipeline (steps-only fragment) id
  model?: string;
  maxAttempts?: number;
}

/**
 * Event-triggered pipeline hop (SPEC §10). M3 dispatches `unitComplete`
 * (fires once per (pipeline, unit) after a run whose unit reached zero
 * non-accepted items); `runStart`/`runEnd` are reserved for M4.
 */
export interface Trigger {
  when: "unitComplete" | "runStart" | "runEnd" | string;
  /** Pipeline id to run when the trigger fires (e.g. `tu-final`). */
  to: string;
}

/** A pipeline: adapter-bound plan (initial items) + steps (SPEC §10). */
export interface Pipeline {
  id: string;
  adapter: string;
  plan(ctx: StepCtx): Promise<WorkItem[]>;
  steps: Step[];
  /** Event triggers evaluated after a run (SPEC §10). */
  triggers?: Trigger[];
  /**
   * Adapter-wide helper registry compiled onto the pipeline by the workflow
   * compiler (SPEC §3): the engine materializes it into `ctx.helpers` when
   * the run context supplies none (a run-specific `RunContext.helpers`
   * wins).
   */
  helpers?: HelperRegistry;
  // ── Status ladder (SPEC §A.1), compiled by the workflow compiler ────────
  /** The workflow's status ladder (default ["DONE"]). */
  statuses?: string[];
  /** Statuses that count as done for plan subtraction (default [last]). */
  doneStatuses?: string[];
  /** Status written by the engine's default run-time finalize (default last). */
  completionStatus?: string;
}

/** Result of running a step (or a `StepCtx.run` sub-step). */
export type StepOutcome = { accepted: WorkItem[]; rejected: WorkItem[] };
