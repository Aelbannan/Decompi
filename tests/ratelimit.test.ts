/**
 * M3 per-model pacing tests (SPEC §11): `RateLimiter` + `StaticModelRegistry`
 * with an injected fake clock. The fake `sleep` advances the clock by the
 * requested duration, so pacing arithmetic is fully deterministic — no real
 * timers — and the exact inter-request gaps are asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, StaticModelRegistry } from "../src/agent/ratelimit.js";

/** Fake clock: sleep advances time by the requested wait. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    time: () => t,
  };
}

test("rpm <= 0 (or an unknown model) is unlimited: acquire resolves with no pacing", async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(
    new StaticModelRegistry({ free: 0, negative: -5 }),
    clock,
  );
  await Promise.all([
    limiter.acquire("free"),
    limiter.acquire("negative"),
    limiter.acquire("unknown-model"), // unregistered -> 0 -> unlimited
  ]);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(limiter.releases.size, 0);
});

test("rpm=60 paces sequential requests 1000ms apart (interval = 60000/rpm)", async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(new StaticModelRegistry({ flash: 60 }), clock);

  const at: number[] = [clock.time()];
  await limiter.acquire("flash");
  at.push(clock.time());
  await limiter.acquire("flash");
  at.push(clock.time());
  await limiter.acquire("flash");
  at.push(clock.time());

  // First request fires immediately (no sleep for a zero wait); each next
  // request waits a full interval.
  assert.deepEqual(clock.sleeps, [1000, 1000]);
  assert.deepEqual(at, [0, 0, 1000, 2000]);
  // now() at each release, in order, one interval apart.
  assert.deepEqual(limiter.releases.get("flash"), [0, 1000, 2000]);
});

test("concurrent acquires serialize per model: one request per interval, no bursts", async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(new StaticModelRegistry({ flash: 60 }), clock);

  const order: number[] = [];
  await Promise.all(
    [0, 1, 2].map(async (i) => {
      await limiter.acquire("flash");
      order.push(i);
    }),
  );

  // FIFO completion via the per-model promise chain...
  assert.deepEqual(order, [0, 1, 2]);
  // ...with releases spread exactly one interval apart (no burst). The first
  // acquire has a zero wait, so no sleep is recorded for it.
  assert.deepEqual(limiter.releases.get("flash"), [0, 1000, 2000]);
  assert.deepEqual(clock.sleeps, [1000, 1000]);
});

test("pacing is keyed per model: a 60rpm and a 6rpm model never block each other", async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(
    new StaticModelRegistry({ fast: 60, slow: 6 }),
    clock,
  );

  await limiter.acquire("fast"); // t=0, fast nextAt=1000
  await limiter.acquire("slow"); // t=0, slow nextAt=10000
  await limiter.acquire("fast"); // waits 1000ms
  await limiter.acquire("slow"); // waits 9000ms

  // fast: interval 1000ms; slow: interval 10000ms. Independent windows.
  assert.deepEqual(limiter.releases.get("fast"), [0, 1000]);
  assert.deepEqual(limiter.releases.get("slow"), [0, 10000]);
});

test("StaticModelRegistry.register adds and overwrites rpm caps", () => {
  const reg = new StaticModelRegistry({ a: 10 }).register("b", 20).register("a", 30);
  assert.equal(reg.rpm("a"), 30);
  assert.equal(reg.rpm("b"), 20);
  assert.equal(reg.rpm("missing"), 0); // unknown -> unlimited
});
