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
 *  - `onReject` routes rejected items to steps-only fragments (see `Route`).
 */
import type { Selector, Verifier, WorkItem } from "../types.js";
import type { AgentRuntime, SessionUsage } from "../agent/runtime.js";
import type { PromptSpec } from "../prompt/builder.js";

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
  /** Most recent agent turn in this scope (agent steps; transforms may read it). */
  lastAgentResult?: LastAgentResult;
}

/** The smallest executable unit of a pipeline (SPEC §10). */
export type Step =
  | { kind: "agent"; prompt: PromptSpec; model?: string; tools?: string[]; maxParallel?: number }
  | { kind: "shell"; run: (ctx: StepCtx) => Promise<string[]> }
  | { kind: "verify"; verifier: string }
  | { kind: "transform"; fn: (ctx: StepCtx) => Promise<void> }
  | { kind: "select"; selector: Selector; into: string }
  | { kind: "foreach"; from?: string; batch: number; key?: string; steps: Step[]; onReject?: Route[] }
  | { kind: "gate"; when: (ctx: StepCtx) => boolean | Promise<boolean> };

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
}

/** Result of running a step (or a `StepCtx.run` sub-step). */
export type StepOutcome = { accepted: WorkItem[]; rejected: WorkItem[] };
