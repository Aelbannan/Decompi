/**
 * M3 budget tests (SPEC §11): `sessionCostMicroUsd` derives a turn's cost from
 * `SessionUsage` × `ModelCost`; `BudgetTracker` tracks spend against a limit
 * (`check` predicts affordability, `spend` records real costs); the
 * `BudgetExceededError` carries the accounting snapshot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelCost } from "../src/types.js";
import {
  BudgetExceededError,
  BudgetTracker,
  sessionCostMicroUsd,
} from "../src/agent/budget.js";

const COST: ModelCost = {
  inputPerM: 0.5,
  outputPerM: 1.5,
  cacheReadPerM: 0.1,
  cacheWritePerM: 1.5,
};

test("sessionCostMicroUsd: tokens × per-million price = micro-USD", () => {
  const cost = sessionCostMicroUsd(
    { input: 1000, output: 2000, cacheRead: 500, cacheWrite: 100 },
    COST,
  );
  // 1000*0.5 + 2000*1.5 + 500*0.1 + 100*1.5 = 3700 µ$
  assert.equal(cost, 3700);
});

test("cost scale: 1M input tokens at $0.5/M = $0.50 = 500000 micro-USD", () => {
  const cost = sessionCostMicroUsd(
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    COST,
  );
  assert.equal(cost, 500_000);
});

test("sessionCostMicroUsd: a zero-usage turn costs nothing", () => {
  assert.equal(
    sessionCostMicroUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, COST),
    0,
  );
});

test("check is non-mutating and reports affordability against the limit", () => {
  const b = new BudgetTracker(100);
  assert.equal(b.spentMicroUsd, 0);
  assert.equal(b.check(50), true);
  assert.equal(b.check(100), true); // exact hit allowed
  assert.equal(b.check(101), false); // would exceed
  assert.equal(b.spentMicroUsd, 0); // check never mutates
  assert.equal(b.remainingMicroUsd, 100);
});

test("spend records real costs and reports when the run goes over budget", () => {
  const b = new BudgetTracker(100);
  assert.equal(b.spend(40), true);
  assert.equal(b.spentMicroUsd, 40);
  assert.equal(b.spend(60), true); // exact hit: still within the limit
  assert.equal(b.spentMicroUsd, 100);
  assert.equal(b.remainingMicroUsd, 0);
  // The API call already happened: the spend is recorded even past the cap.
  assert.equal(b.spend(1), false);
  assert.equal(b.spentMicroUsd, 101);
});

test("constructor validates the limit and seeds spent for resumed runs", () => {
  assert.throws(() => new BudgetTracker(-1), /limitMicroUsd/);
  assert.throws(() => new BudgetTracker(NaN), /limitMicroUsd/);
  const resumed = new BudgetTracker(100, 60);
  assert.equal(resumed.spentMicroUsd, 60);
  assert.equal(resumed.check(40), true);
  assert.equal(resumed.check(41), false);
});

test("negative costs are rejected (no free money)", () => {
  const b = new BudgetTracker(100);
  assert.throws(() => b.check(-5), /costMicroUsd/);
  assert.throws(() => b.spend(-5), /costMicroUsd/);
});

test("Infinity limit is unlimited", () => {
  const b = new BudgetTracker(Infinity);
  assert.equal(b.spend(1e9), true);
  assert.equal(b.spentMicroUsd, 1e9);
  assert.equal(b.check(Number.MAX_SAFE_INTEGER), true);
});

test("BudgetExceededError carries spent/limit/step cost", () => {
  const err = new BudgetExceededError(120, 100, 25);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "BudgetExceededError");
  assert.equal(err.spentMicroUsd, 120);
  assert.equal(err.limitMicroUsd, 100);
  assert.equal(err.stepCostMicroUsd, 25);
  assert.match(err.message, /budget exceeded: spent 120µ\$ of 100µ\$/);
  assert.match(err.message, /step cost 25µ\$/);
});
