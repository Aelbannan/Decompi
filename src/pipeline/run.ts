/**
 * M3 run lifecycle (SPEC §11): wraps an engine run with budget enforcement,
 * per-model pacing, and resume.
 *
 *  - **Budget**: a `BudgetTracker` checks a per-turn cost ESTIMATE before
 *    every agent step (model price × configurable token estimate, default
 *    100k in + 20k out) and charges after every agent turn from the actual
 *    `SessionUsage` × model cost. Once the cap is crossed the run aborts with
 *    `BudgetExceededError` (SPEC §11 "checked at step/round boundaries; a
 *    hard-abort path"). An unresolvable model is a hard error at both the
 *    estimate and the charge point — unknown cost is never treated as zero.
 *  - **Pacing**: every agent REQUEST — session creation AND each `prompt()`
 *    turn on that session — awaits `rateLimiter.acquire(model)`, so calls to a
 *    provider respect that model's `rpm` (per-model, per-request pacing, not
 *    one global pacer).
 *  - **Resume**: an optional `resumeState` records work finished by a prior
 *    run; items in `doneItems` are filtered out at the `select()` boundary, so
 *    `plan`/`select` steps never re-issue them. **M3 keeps this to a simple id
 *    set + step index** — full `run_workers.step_index`/`step_state`
 *    persistence lands in M4 (SPEC §11 restart semantics). Consequence: resume
 *    only skips items whose source is `ctx.select(...)`; a `plan` that returns
 *    items directly cannot be filtered this way.
 */
import type { AgentResult, AgentRuntime, AgentSession } from "../agent/runtime.js";
import type { ModelCost, Selector, WorkItem } from "../types.js";
import { BudgetExceededError, BudgetTracker, sessionCostMicroUsd } from "../agent/budget.js";
import type { RateLimiter } from "../agent/ratelimit.js";
import { PipelineEngine, type RunContext, type RunOutcome } from "./engine.js";
import type { WorkflowStatusStore } from "../workflow/status.js";
import type { HelperRegistry } from "../workflow/helpers.js";

export { BudgetExceededError } from "../agent/budget.js";

/** Completed-work snapshot handed to a resumed run (M3: id set + step index; full step_state in M4). */
export interface ResumeState {
  /** Work-item ids already finished; resume skips them. */
  doneItems: Set<string>;
  /** 0-based step index the prior run reached (informational in M3). */
  stepIndex: number;
}

/** Per-turn token estimate used by the pre-step affordability check (SPEC §11). */
export interface TurnEstimate {
  /** Estimated input tokens per agent turn; defaults to 100_000. */
  input?: number;
  /** Estimated output tokens per agent turn; defaults to 20_000. */
  output?: number;
}

/** Options for `runPipelineWithBudget` (M3 additions over the engine's RunContext). */
export interface RunOptions {
  /** Agent runtime the engine runs against; wired through the budget/pacing guard. */
  runtime: AgentRuntime;
  /** Default model for agent steps that don't override (SPEC §11 per-run model). */
  defaultModel: string;
  /** Whole-run cap in integer micro-USD; undefined = unlimited. */
  budgetMicroUsd?: number;
  /** Per-turn token estimate for the pre-step affordability check (SPEC §11). */
  turnEstimate?: TurnEstimate;
  /** Per-model pacer; every agent request (session + each prompt) awaits `acquire(model)` first. */
  rateLimiter?: RateLimiter;
  /** Completed work from a prior run; `doneItems` are skipped at select(). */
  resumeState?: ResumeState;
  /** Adapter style guide (Markdown file); injected + hashed into every agent prompt (SPEC §12). */
  styleGuidePath?: string;
  /** Passed through to the engine's RunContext. */
  verifiers?: RunContext["verifiers"];
  /** Passed through; wrapped with resume filtering when `resumeState` is set. */
  select?: RunContext["select"];
  /** Passed through to the engine's RunContext. */
  log?: RunContext["log"];
  /**
   * Workflow status store (SPEC §A.3): passed through to the engine's
   * RunContext — when the run supplies no `finalize`, accepted
   * `{ promote: true }` items record precise status rows through it (status
   * = the pipeline's compiled `completionStatus`, default "DONE"), so a
   * later plan skips them.
   */
  statusesStore?: WorkflowStatusStore;
  /**
   * Adapter-wide helper registry (SPEC §3): passed through to the engine's
   * RunContext so `forwardCtx` materializes `ctx.helpers` for workflow
   * hooks.
   */
  helpers?: HelperRegistry;
  /**
   * Called once when the run settles with the ACTUAL metered cost (micro-USD
   * charged from `SessionUsage` × model price). The caller records it in the
   * audit ledger (SPEC §16: spend caps measure spend, not reservations).
   */
  onBudgetSpent?: (spentMicroUsd: number) => void;
}

const NOOP_LOG = (_level: string, _msg: string): void => {};

/** Default per-turn token estimate when the caller does not override it. */
const DEFAULT_TURN_ESTIMATE: { input: number; output: number } = { input: 100_000, output: 20_000 };

/** Micro-USD price of one *estimated* agent turn (pre-step affordability check). */
function estimateTurnMicroUsd(estimate: { input: number; output: number }, cost: ModelCost): number {
  return Math.round(estimate.input * cost.inputPerM + estimate.output * cost.outputPerM);
}

/**
 * Run `pipelineId` with budget enforcement, per-model pacing, and optional
 * resume. Returns the engine's `RunOutcome`; throws `BudgetExceededError` when
 * the budget cap is crossed (or is already crossed at a step boundary).
 */
export function runPipelineWithBudget(
  engine: PipelineEngine,
  pipelineId: string,
  opts: RunOptions,
): Promise<RunOutcome> {
  // Always meter actuals — a run WITHOUT a cap still gets a tracker with an
  // Infinity limit, so `onBudgetSpent` reports real spend and the ledger is
  // not blind to budgetless runs (SPEC §16 spend caps).
  const budget = new BudgetTracker(opts.budgetMicroUsd ?? Infinity);
  const log = opts.log ?? NOOP_LOG;
  const runtime = guardRuntime(opts.runtime, {
    budget,
    rateLimiter: opts.rateLimiter,
    turnEstimate: { ...DEFAULT_TURN_ESTIMATE, ...(opts.turnEstimate ?? {}) },
  });
  const select =
    opts.select === undefined ? undefined : wrapResumeSelect(opts.select, opts.resumeState, log);
  const ctx0: RunContext = {
    runtime,
    defaultModel: opts.defaultModel,
    verifiers: opts.verifiers ?? {},
    ...(select !== undefined ? { select } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.styleGuidePath !== undefined ? { styleGuidePath: opts.styleGuidePath } : {}),
    ...(opts.statusesStore !== undefined ? { statusesStore: opts.statusesStore } : {}),
    ...(opts.helpers !== undefined ? { helpers: opts.helpers } : {}),
  };
  return engine.runPipeline(pipelineId, ctx0).finally(() => {
    // Report the ACTUAL metered cost once the run settles (also on error —
    // the charge already happened). The caller folds it into audit_log.
    opts.onBudgetSpent?.(budget.spentMicroUsd);
  });
}

interface GuardHooks {
  budget?: BudgetTracker;
  rateLimiter?: RateLimiter;
  turnEstimate: { input: number; output: number };
}

/**
 * Wrap `runtime` so every agent step is budget-checked (pre) and paced, and
 * every agent turn is charged (post) against the actual usage (SPEC §11).
 * The wrapped session ALSO paces each `prompt()` call, so a session used for
 * several turns still respects the model's rpm per request.
 */
function guardRuntime(runtime: AgentRuntime, hooks: GuardHooks): AgentRuntime {
  return {
    resolveModel: (name) => runtime.resolveModel(name),
    async createSession(opts): Promise<AgentSession> {
      if (hooks.budget !== undefined) {
        // Pre-step check: estimate the upcoming turn from the model's per-M
        // price and the configured per-turn token estimate, and abort BEFORE
        // any spend when the estimate alone would exceed the cap. An
        // unresolvable model cannot be priced — unknown cost is NOT zero cost
        // (SPEC §11: a hard-abort path).
        const spec = await runtime.resolveModel(opts.model);
        if (spec === null) {
          throw new Error(
            `cannot price model "${opts.model}": resolveModel returned null (unknown cost ≠ zero cost)`,
          );
        }
        const estimateMicroUsd = estimateTurnMicroUsd(hooks.turnEstimate, spec.cost);
        if (!hooks.budget.check(estimateMicroUsd)) {
          throw new BudgetExceededError(
            hooks.budget.spentMicroUsd,
            hooks.budget.limitMicroUsd,
            estimateMicroUsd,
          );
        }
      }
      if (hooks.rateLimiter !== undefined) {
        await hooks.rateLimiter.acquire(opts.model);
      }
      const session = await runtime.createSession(opts);
      if (hooks.budget === undefined && hooks.rateLimiter === undefined) return session;
      return guardSession(session, opts.model, runtime, hooks);
    },
  };
}

/** Wrap a session so each turn is paced and charged against the budget. */
function guardSession(
  session: AgentSession,
  model: string,
  runtime: AgentRuntime,
  hooks: GuardHooks,
): AgentSession {
  return {
    async prompt(text): Promise<AgentResult> {
      // Per-request pacing: a session prompted several times must pace every
      // request, not just the one that created the session.
      if (hooks.rateLimiter !== undefined) {
        await hooks.rateLimiter.acquire(model);
      }
      const result = await session.prompt(text);
      if (hooks.budget === undefined) return result;
      const spec = await runtime.resolveModel(model);
      if (spec === null) {
        throw new Error(
          `cannot charge model "${model}": resolveModel returned null (unknown cost ≠ zero cost)`,
        );
      }
      const cost = sessionCostMicroUsd(result.usage, spec.cost);
      // The turn already happened: record the real cost, then abort the run
      // if the cap is now crossed (next steps must not start fresh spend).
      if (!hooks.budget.spend(cost)) {
        throw new BudgetExceededError(hooks.budget.spentMicroUsd, hooks.budget.limitMicroUsd, cost);
      }
      return result;
    },
  };
}

/** Filter already-finished items out of every select() call (M3 resume). */
function wrapResumeSelect(
  base: (selector: Selector) => Promise<WorkItem[]>,
  resume: ResumeState | undefined,
  log: (level: string, msg: string) => void,
): (selector: Selector) => Promise<WorkItem[]> {
  return async (selector) => {
    const items = await base(selector);
    if (resume === undefined || resume.doneItems.size === 0) return items;
    const done = resume.doneItems instanceof Set ? resume.doneItems : new Set(resume.doneItems);
    const kept = items.filter((item) => !done.has(item.id));
    if (kept.length !== items.length) {
      log("info", `resume: skipped ${items.length - kept.length} already-finished item(s)`);
    }
    return kept;
  };
}
