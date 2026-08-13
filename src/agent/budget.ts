/**
 * Budget enforcement (SPEC §11): integer micro-USD accounting per run.
 *
 *  - `sessionCostMicroUsd` derives one agent turn's cost from `SessionUsage`
 *    and the model's per-million-token `ModelCost`.
 *  - `BudgetTracker` tracks spend against a run limit: `check` predicts
 *    affordability without mutating ("false when it would exceed"), `spend`
 *    records real costs and reports when the run goes over.
 *  - `BudgetExceededError` aborts a run at the next step boundary once the cap
 *    is crossed (SPEC §11 "checked at step/round boundaries; a hard-abort
 *    path").
 */
import type { ModelCost } from "../types.js";
import type { SessionUsage } from "./runtime.js";

/**
 * Micro-USD cost of one agent turn: `tokens × perM` — a price expressed in USD
 * per million tokens is exactly the micro-USD price of a single token, so the
 * token counts times the per-M rates give micro-USD directly. Rounded to an
 * integer per SPEC §11's "integer micro-USD, no float error" rule.
 */
export function sessionCostMicroUsd(usage: SessionUsage, cost: ModelCost): number {
  return Math.round(
    usage.input * cost.inputPerM +
      usage.output * cost.outputPerM +
      usage.cacheRead * cost.cacheReadPerM +
      usage.cacheWrite * cost.cacheWritePerM,
  );
}

/** Thrown when a run exceeds its budget; carries the accounting snapshot. */
export class BudgetExceededError extends Error {
  /** Micro-USD actually charged (may exceed the limit — the API call happened). */
  readonly spentMicroUsd: number;
  /** The run's hard cap in micro-USD. */
  readonly limitMicroUsd: number;
  /** Cost of the step that pushed the run over, when known. */
  readonly stepCostMicroUsd?: number;

  constructor(spentMicroUsd: number, limitMicroUsd: number, stepCostMicroUsd?: number) {
    const step = stepCostMicroUsd === undefined ? "n/a" : `${stepCostMicroUsd}µ$`;
    super(`budget exceeded: spent ${spentMicroUsd}µ$ of ${limitMicroUsd}µ$ (step cost ${step})`);
    this.name = "BudgetExceededError";
    this.spentMicroUsd = spentMicroUsd;
    this.limitMicroUsd = limitMicroUsd;
    this.stepCostMicroUsd = stepCostMicroUsd;
  }
}

/** Integer micro-USD spend tracker for one run (SPEC §11). */
export class BudgetTracker {
  /** Hard cap in micro-USD; `Infinity` = unlimited. */
  readonly limitMicroUsd: number;
  private _spentMicroUsd: number;

  /**
   * @param limitMicroUsd whole-run cap (>= 0, or Infinity for unlimited)
   * @param initialSpentMicroUsd pre-seeded spend (e.g. resumed run)
   */
  constructor(limitMicroUsd: number, initialSpentMicroUsd = 0) {
    if (limitMicroUsd !== Infinity && (!Number.isFinite(limitMicroUsd) || limitMicroUsd < 0)) {
      throw new Error(
        `BudgetTracker: limitMicroUsd must be >= 0 (got ${String(limitMicroUsd)})`,
      );
    }
    if (!Number.isFinite(initialSpentMicroUsd) || initialSpentMicroUsd < 0) {
      throw new Error(
        `BudgetTracker: initialSpentMicroUsd must be >= 0 (got ${String(initialSpentMicroUsd)})`,
      );
    }
    this.limitMicroUsd = limitMicroUsd;
    this._spentMicroUsd = initialSpentMicroUsd;
  }

  /** Micro-USD charged so far. */
  get spentMicroUsd(): number {
    return this._spentMicroUsd;
  }

  /** Micro-USD left before the cap (floored at 0). */
  get remainingMicroUsd(): number {
    return Math.max(0, this.limitMicroUsd - this._spentMicroUsd);
  }

  /**
   * True when spending `costMicroUsd` now would stay within the limit; false
   * when it would exceed. Never mutates. An exact hit (`spent + cost ===
   * limit`) is affordable.
   */
  check(costMicroUsd: number): boolean {
    if (!Number.isFinite(costMicroUsd) || costMicroUsd < 0) {
      throw new Error(
        `BudgetTracker.check: costMicroUsd must be >= 0 (got ${String(costMicroUsd)})`,
      );
    }
    return this._spentMicroUsd + costMicroUsd <= this.limitMicroUsd;
  }

  /**
   * Record a real cost — the API call already happened, so the spend is
   * unconditional. Returns true while the run is still within the limit,
   * false once it has gone over.
   */
  spend(costMicroUsd: number): boolean {
    if (!Number.isFinite(costMicroUsd) || costMicroUsd < 0) {
      throw new Error(
        `BudgetTracker.spend: costMicroUsd must be >= 0 (got ${String(costMicroUsd)})`,
      );
    }
    this._spentMicroUsd += costMicroUsd;
    return this.check(0);
  }
}
