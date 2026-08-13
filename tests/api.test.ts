/**
 * M4 control-plane API tests (SPEC §16, §18): bearer auth on every endpoint
 * (REST + WS upgrade), run create/list/get + pause/resume/cancel round-trips
 * through the REAL M4 `RunScheduler`, audit_log rows on every mutating
 * action, the per-token and global spend caps, the events/work-items/metrics
 * read endpoints, and the hand-rolled WebSocket stream (exercised with a raw
 * socket client, so the RFC 6455 handshake and framing are tested on the
 * wire).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { AgentRuntime } from "../src/agent/runtime.js";
import type { ModelSpec, WorkItem } from "../src/types.js";
import { MockAgentRuntime, emptyUsage } from "../src/agent/mock.js";
import { PipelineEngine } from "../src/pipeline/engine.js";
import { StoreDaemon } from "../src/core/daemon.js";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { RunScheduler, type RunRecord } from "../src/server/scheduler.js";
import { WorkItemRepo } from "../src/target/work-item.js";
import {
  createApiServer,
  hashToken,
  AuthTokenProvider,
  type ApiServerOptions,
} from "../src/server/api.js";

const TS = "2025-05-01T00:00:00.000Z";
const SECRET = "test-bearer-secret";
const REVOKED_SECRET = "revoked-secret";
const CAP_SECRET = "capped-secret";

const FLASH: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 60,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    kind: "function",
    lifecycle: "pending",
    status: "NOT_STARTED",
    attempts: 0,
    exhausted: false,
    ready: true,
    meta: {},
    ...over,
  };
}

interface TestContext {
  db: SqliteAdapter;
  daemon: StoreDaemon;
  scheduler: RunScheduler;
  runtime: MockAgentRuntime;
  server: ReturnType<typeof createApiServer>;
  port: number;
  baseUrl: string;
}

/** Poll `predicate` every 5ms until it holds or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor: ${label} not satisfied within ${timeoutMs}ms`);
}

/** A promise plus its resolver (deterministic test gates). */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A runtime whose sessions' prompts wait on a gate (blocks the agent step). */
function blockingRuntime(gate: Deferred): AgentRuntime {
  return {
    resolveModel: async () => FLASH,
    createSession: async () => ({
      prompt: async () => {
        await gate.promise;
        return { finalText: "ok", usage: emptyUsage() };
      },
    }),
  };
}

/**
 * Fresh in-memory store + real M4 scheduler (registered "p" pipeline over
 * MockAgentRuntime) + seeded token + listening API server on an ephemeral
 * port.
 */
async function setup(
  overrides: Partial<ApiServerOptions> = {},
  runtime?: AgentRuntime,
): Promise<TestContext> {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  const daemon = new StoreDaemon(db);
  const rt = runtime ?? new MockAgentRuntime({ flash: FLASH });
  const engine = new PipelineEngine();
  engine.registerPipeline({
    id: "p",
    adapter: "fixture",
    plan: async () => [item("wi_a")],
    steps: [{ kind: "agent", prompt: { template: "match" } }],
  });
  const scheduler = new RunScheduler({
    store: db,
    engine,
    maxParallelRuns: 1,
    runtime: rt,
    daemon,
  });
  const authTokens = new AuthTokenProvider(db);
  await authTokens.issue("tok-1", SECRET);
  const server = createApiServer({
    store: db,
    scheduler,
    authTokens,
    globalSpendCapMicroUsd: 1e12,
    pollIntervalMs: 25,
    port: 0,
    ...overrides,
  });
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    db,
    daemon,
    scheduler,
    runtime: rt as MockAgentRuntime,
    server,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function teardown(ctx: TestContext): Promise<void> {
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  await ctx.scheduler.close();
  await ctx.daemon.close();
  ctx.db.close();
}

async function seedToken(
  db: SqliteAdapter,
  id: string,
  secret: string,
  opts: { spendCap?: number | null; revoked?: boolean } = {},
): Promise<void> {
  await db.execute(
    "INSERT INTO auth_tokens (id, secret_hash, spend_cap_micro_usd, pipeline_allowlist, created_at, revoked_at) VALUES (?, ?, ?, '[]', ?, ?)",
    [id, hashToken(secret), opts.spendCap ?? null, TS, opts.revoked ? TS : null],
  );
}

async function seedAudit(
  db: SqliteAdapter,
  id: string,
  actor: string,
  costMicroUsd: number,
): Promise<void> {
  await db.execute(
    "INSERT INTO audit_log (id, ts, actor, action, run_id, cost_micro_usd, data) VALUES (?, ?, ?, 'run-create', NULL, ?, '{}')",
    [id, TS, actor, costMicroUsd],
  );
}

async function api(
  baseUrl: string,
  path: string,
  opts: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== null) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function runOf(body: unknown): RunRecord {
  const obj = body as { run?: RunRecord };
  assert.ok(obj.run !== undefined, "expected { run } response body");
  return obj.run;
}

function runsOf(body: unknown): RunRecord[] {
  const obj = body as { runs?: RunRecord[] };
  assert.ok(obj.runs !== undefined, "expected { runs } response body");
  return obj.runs;
}

/** Fetch a run's status via the API (for waitFor predicates). */
async function statusOf(ctx: TestContext, id: string): Promise<string | undefined> {
  const res = await api(ctx.baseUrl, `/api/runs/${id}`, { token: SECRET });
  if (res.status !== 200) return undefined;
  return runOf(res.body).status;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test("every endpoint returns 401 without a bearer token", async () => {
  const ctx = await setup();
  try {
    const paths: Array<[string, string]> = [
      ["GET", "/api/health"],
      ["GET", "/api/metrics"],
      ["GET", "/api/runs"],
      ["POST", "/api/runs"],
      ["POST", "/api/analyze"],
      ["GET", "/api/runs/nope"],
      ["POST", "/api/runs/nope/pause"],
      ["GET", "/api/work-items"],
      ["GET", "/api/events"],
      ["GET", "/api/does-not-exist"],
    ];
    for (const [method, path] of paths) {
      const res = await api(ctx.baseUrl, path, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  } finally {
    await teardown(ctx);
  }
});

test("invalid and revoked tokens are rejected with 401", async () => {
  const ctx = await setup();
  try {
    await seedToken(ctx.db, "tok-revoked", REVOKED_SECRET, { revoked: true });
    assert.equal((await api(ctx.baseUrl, "/api/health", { token: "wrong-secret" })).status, 401);
    assert.equal((await api(ctx.baseUrl, "/api/health", { token: REVOKED_SECRET })).status, 401);
    assert.equal((await api(ctx.baseUrl, "/api/health", { token: SECRET })).status, 200);
    // An empty Bearer value is not a token.
    const headers: Record<string, string> = { authorization: "Bearer " };
    const res = await fetch(`${ctx.baseUrl}/api/health`, { headers });
    assert.equal(res.status, 401);
  } finally {
    await teardown(ctx);
  }
});

test("an exhausted per-token cap gates run-create (403) but never 401s reads", async () => {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  try {
    await seedToken(db, "tok-capped", CAP_SECRET, { spendCap: 50 });
    await seedAudit(db, "a1", "tok-capped", 60); // spent 60 > cap 50
    const provider = new AuthTokenProvider(db);
    // Exhausted: validate still returns the identity (reads must work) with
    // the flag set — it does NOT reject with null (M4 spend-cap fix).
    const exhausted = await provider.validate(CAP_SECRET);
    assert.deepEqual(exhausted, { id: "tok-capped", exhausted: true, pipelineAllowlist: [] });
    // A within-cap token validates normally.
    await seedToken(db, "tok-under", "under-cap-secret", { spendCap: 50 });
    assert.deepEqual(await provider.validate("under-cap-secret"), {
      id: "tok-under",
      pipelineAllowlist: [],
    });
    // Unknown tokens are null too.
    assert.equal(await provider.validate("no-such-token"), null);
  } finally {
    db.close();
  }

  // API level: an exhausted token still reads (200) but cannot create runs (403).
  const ctx = await setup();
  try {
    await seedToken(ctx.db, "tok-capped-api", CAP_SECRET, { spendCap: 50 });
    await seedAudit(ctx.db, "a1", "tok-capped-api", 60);
    assert.equal((await api(ctx.baseUrl, "/api/health", { token: CAP_SECRET })).status, 200);
    assert.equal((await api(ctx.baseUrl, "/api/runs", { token: CAP_SECRET })).status, 200);
    const denied = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: CAP_SECRET,
      body: { pipeline: "p", model: "flash", budgetMicroUsd: 100_000 },
    });
    assert.equal(denied.status, 403);
    assert.match(String((denied.body as { error: string }).error), /spend cap/i);
    // No run row was created.
    const runs = await ctx.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM runs");
    assert.equal(Number(runs[0]!.n), 0);
  } finally {
    await teardown(ctx);
  }
});

test("health and metrics with a valid token", async () => {
  const ctx = await setup();
  try {
    const health = await api(ctx.baseUrl, "/api/health", { token: SECRET });
    assert.equal(health.status, 200);
    assert.equal((health.body as { status: string }).status, "ok");

    const metrics = await api(ctx.baseUrl, "/api/metrics", { token: SECRET });
    assert.equal(metrics.status, 200);
    const body = metrics.body as { totalRuns: number; activeRuns: number; spendMicroUsd: number };
    assert.deepEqual(body, { totalRuns: 0, activeRuns: 0, spendMicroUsd: 0 });
  } finally {
    await teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// Runs: create / list / get / actions, audit trail
// ---------------------------------------------------------------------------

test("run create/list/get round-trip through the real scheduler, audit row, and 404s", async () => {
  const ctx = await setup();
  try {
    const create = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: {
        pipeline: "p",
        model: "flash",
        selector: { filter: { status: ["NOT_STARTED"] }, limit: 10 },
        // Must cover the pre-step affordability estimate for one turn
        // (FLASH: 100k in + 20k out ≈ 80,000µ$) or the run aborts with
        // BudgetExceededError instead of completing (SPEC §11).
        budgetMicroUsd: 100_000,
      },
    });
    assert.equal(create.status, 201);
    const run = runOf(create.body);
    assert.equal(run.pipeline, "p");
    assert.equal(run.model, "flash");
    assert.equal(run.budgetMicroUsd, 100_000);
    assert.ok(run.id.length > 0);
    assert.ok(["queued", "running", "done"].includes(run.status), `unexpected status ${run.status}`);

    // The real scheduler actually ran it: the run lands on done (mock).
    await waitFor(
      async () => (await statusOf(ctx, run.id)) === "done",
      5_000,
      "created run reaches done",
    );

    // audit_log got TWO rows, in insert order: the run-create row with the
    // RESERVED budget, then the run-complete row with the ACTUAL metered
    // cost (SPEC §16: spend caps measure spend, not reservations).
    await waitFor(
      async () => {
        const rows = await ctx.db.query<{ action: string }>(
          "SELECT action FROM audit_log WHERE run_id = ?",
          [run.id],
        );
        return rows.length === 2;
      },
      5_000,
      "create + completion audit rows",
    );
    const audit = await ctx.db.query<{
      actor: string;
      action: string;
      run_id: string | null;
      cost_micro_usd: number | null;
    }>(
      "SELECT actor, action, run_id, cost_micro_usd FROM audit_log WHERE run_id = ? ORDER BY rowid",
      [run.id],
    );
    assert.deepEqual(
      audit.map((row) => row.action),
      ["run-create", "run-complete"],
    );
    for (const row of audit) assert.equal(row.actor, "tok-1");
    assert.equal(audit[0]!.run_id, run.id);
    assert.equal(audit[0]!.cost_micro_usd, 100_000, "create row records the reserved budget");
    assert.ok(
      audit[1]!.cost_micro_usd !== null && audit[1]!.cost_micro_usd > 0,
      `completion row records the ACTUAL metered cost (got ${String(audit[1]!.cost_micro_usd)})`,
    );

    // List round-trip.
    const list = await api(ctx.baseUrl, "/api/runs", { token: SECRET });
    assert.equal(list.status, 200);
    const listed = runsOf(list.body);
    assert.ok(listed.some((r) => r.id === run.id), "created run appears in the list");
    assert.equal(listed.find((r) => r.id === run.id)!.status, "done");

    // Get round-trip.
    const got = await api(ctx.baseUrl, `/api/runs/${run.id}`, { token: SECRET });
    assert.equal(got.status, 200);
    const gotRun = runOf(got.body);
    assert.equal(gotRun.id, run.id);
    assert.equal(gotRun.status, "done");
    assert.ok(gotRun.startedAt !== null, "started_at set on execution");
    assert.ok(gotRun.finishedAt !== null, "finished_at set on completion");

    // Unknown run / route → 404.
    assert.equal(
      (await api(ctx.baseUrl, "/api/runs/does-not-exist", { token: SECRET })).status,
      404,
    );
    assert.equal(
      (await api(ctx.baseUrl, "/api/runs/1/bogus", { method: "POST", token: SECRET })).status,
      404,
    );
  } finally {
    await teardown(ctx);
  }
});

test("pause/resume/cancel transition the run and audit each action", async () => {
  const gate = deferred();
  const ctx = await setup({}, blockingRuntime(gate));
  try {
    // Run A grabs the only slot and blocks at its agent step. A budget is
    // required because setup() configures a (large) global spend cap — a
    // budgetless run-create is refused under a configured cap (SPEC §16).
    const a = runOf(
      (
        await api(ctx.baseUrl, "/api/runs", {
          method: "POST",
          token: SECRET,
          body: { pipeline: "p", model: "flash", budgetMicroUsd: 100_000 },
        })
      ).body,
    );
    await waitFor(
      async () => (await statusOf(ctx, a.id)) === "running",
      5_000,
      "run A starts",
    );

    // Run B stays queued behind A: pause parks it, resume makes it startable.
    const b = runOf(
      (
        await api(ctx.baseUrl, "/api/runs", {
          method: "POST",
          token: SECRET,
          body: { pipeline: "p", model: "flash", budgetMicroUsd: 100_000 },
        })
      ).body,
    );
    await waitFor(
      async () => (await statusOf(ctx, b.id)) === "queued",
      5_000,
      "run B queued",
    );

    const paused = await api(ctx.baseUrl, `/api/runs/${b.id}/pause`, {
      method: "POST",
      token: SECRET,
    });
    assert.equal(paused.status, 200);
    assert.equal(runOf(paused.body).status, "paused");

    const resumed = await api(ctx.baseUrl, `/api/runs/${b.id}/resume`, {
      method: "POST",
      token: SECRET,
    });
    assert.equal(resumed.status, 200);
    assert.equal(runOf(resumed.body).status, "queued");

    const cancelled = await api(ctx.baseUrl, `/api/runs/${b.id}/cancel`, {
      method: "POST",
      token: SECRET,
    });
    assert.equal(cancelled.status, 200);
    assert.equal(runOf(cancelled.body).status, "cancelled");
    assert.equal(runOf(cancelled.body).startedAt, null, "a cancelled queued run never starts");

    // Unknown id → 404, and no audit row is written for it.
    assert.equal(
      (await api(ctx.baseUrl, "/api/runs/does-not-exist/cancel", { method: "POST", token: SECRET }))
        .status,
      404,
    );

    // One audit row per mutating action, in order, all by the token's id.
    const audit = await ctx.db.query<{ actor: string; action: string; run_id: string | null }>(
      "SELECT actor, action, run_id FROM audit_log",
    );
    assert.deepEqual(
      audit.map((row) => row.action),
      ["run-create", "run-create", "run-pause", "run-resume", "run-cancel"],
    );
    for (const row of audit) {
      assert.equal(row.actor, "tok-1");
      if (row.action === "run-cancel") assert.equal(row.run_id, b.id);
    }

    // Release A so it finishes and teardown has nothing in flight.
    gate.resolve();
    await waitFor(
      async () => (await statusOf(ctx, a.id)) === "done",
      5_000,
      "run A done after gate release",
    );
  } finally {
    await teardown(ctx);
  }
});

test("global spend cap refuses new runs only once cumulative spend exceeds it", async () => {
  // Exceeded → 403, and the scheduler is never touched.
  const refused = await setup({ globalSpendCapMicroUsd: 500 });
  try {
    await seedAudit(refused.db, "a1", "tok-1", 1000);
    const res = await api(refused.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "p", model: "flash" },
    });
    assert.equal(res.status, 403);
    assert.match(String((res.body as { error: string }).error), /spend cap/i);

    // No run row was created and no audit row was added.
    const runs = await refused.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM runs");
    assert.equal(Number(runs[0]!.n), 0);
    const audit = await refused.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log");
    assert.equal(Number(audit[0]!.n), 1);

    const metrics = (await api(refused.baseUrl, "/api/metrics", { token: SECRET })).body as {
      spendMicroUsd: number;
    };
    assert.equal(metrics.spendMicroUsd, 1000);
  } finally {
    await teardown(refused);
  }

  // Exactly at the cap is still allowed (`>`, not `>=`). A budget is
  // required under a configured cap, so the create is budgeted.
  const atCap = await setup({ globalSpendCapMicroUsd: 1000 });
  try {
    await seedAudit(atCap.db, "a1", "tok-1", 1000);
    const res = await api(atCap.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "p", model: "flash", budgetMicroUsd: 100_000 },
    });
    assert.equal(res.status, 201);
  } finally {
    await teardown(atCap);
  }
});

test("a budgetless run-create is refused when a global spend cap is configured", async () => {
  const capped = await setup({ globalSpendCapMicroUsd: 1_000_000 });
  try {
    const denied = await api(capped.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "p", model: "flash" },
    });
    assert.equal(denied.status, 403);
    assert.match(String((denied.body as { error: string }).error), /budget/i);
    // No run row was created and no audit row was added.
    const runs = await capped.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM runs");
    assert.equal(Number(runs[0]!.n), 0);
    const audit = await capped.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log");
    assert.equal(Number(audit[0]!.n), 0);
    // A budgeted create still works under the cap.
    const ok = await api(capped.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "p", model: "flash", budgetMicroUsd: 100_000 },
    });
    assert.equal(ok.status, 201);
  } finally {
    await teardown(capped);
  }

  // Unlimited (Infinity) = not configured: budgetless is allowed.
  const open = await setup({ globalSpendCapMicroUsd: Infinity });
  try {
    const res = await api(open.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "p", model: "flash" },
    });
    assert.equal(res.status, 201);
  } finally {
    await teardown(open);
  }
});

/** A runtime whose prompts report a FIXED usage snapshot (deterministic metering). */
function usageRuntime(input: number, output: number): AgentRuntime {
  return {
    resolveModel: async () => FLASH,
    createSession: async () => ({
      prompt: async () => ({
        finalText: "ok",
        usage: { input, output, cacheRead: 0, cacheWrite: 0 },
      }),
    }),
  };
}

test("a completed run's ACTUAL cost lands in audit_log and spend — budgetless runs are metered", async () => {
  const ctx = await setup({ globalSpendCapMicroUsd: Infinity }, usageRuntime(10_000, 5_000));
  try {
    // NO budgetMicroUsd: the run-create row records a NULL reservation, so
    // the only way its cost can reach the ledger is the completion hook.
    const create = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "p", model: "flash" },
    });
    assert.equal(create.status, 201);
    const run = runOf(create.body);
    await waitFor(
      async () => (await statusOf(ctx, run.id)) === "done",
      5_000,
      "run done",
    );
    await waitFor(
      async () => {
        const rows = await ctx.db.query<{ action: string }>(
          "SELECT action FROM audit_log WHERE run_id = ?",
          [run.id],
        );
        return rows.some((row) => row.action === "run-complete");
      },
      5_000,
      "completion audit row",
    );
    const rows = await ctx.db.query<{ action: string; cost_micro_usd: number | null }>(
      "SELECT action, cost_micro_usd FROM audit_log WHERE run_id = ? ORDER BY rowid",
      [run.id],
    );
    assert.equal(rows[0]!.action, "run-create");
    assert.equal(rows[0]!.cost_micro_usd, null, "budgetless create records no reservation");
    assert.equal(rows[1]!.action, "run-complete");
    // 10k input × 0.5 + 5k output × 1.5 = 12 500 µ$ actual metered cost.
    assert.equal(rows[1]!.cost_micro_usd, 12_500);
    // The global spend ledger reflects the ACTUAL (SUM skips the NULL reservation).
    const metrics = (await api(ctx.baseUrl, "/api/metrics", { token: SECRET })).body as {
      spendMicroUsd: number;
    };
    assert.equal(metrics.spendMicroUsd, 12_500);
  } finally {
    await teardown(ctx);
  }
});

test("POST /api/runs validates the body (400)", async () => {
  const ctx = await setup();
  try {
    // Missing required field.
    const missing = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { model: "flash" },
    });
    assert.equal(missing.status, 400);

    // Non-object body.
    const bad = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: "not json {",
    });
    assert.equal(bad.status, 400);

    // Invalid selector inside the create body.
    const badSelector = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "p", model: "flash", selector: { filter: { status: "FULL_MATCH" } } },
    });
    assert.equal(badSelector.status, 400);

    // Negative budget.
    const badBudget = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "p", model: "flash", budgetMicroUsd: -1 },
    });
    assert.equal(badBudget.status, 400);

    // Nothing was created.
    const runs = await ctx.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM runs");
    assert.equal(Number(runs[0]!.n), 0);
  } finally {
    await teardown(ctx);
  }
});

test("pipeline allowlist gates run-create (403) but never reads", async () => {
  const ctx = await setup();
  try {
    await new AuthTokenProvider(ctx.db).issue("tok-list", "list-secret", {
      pipelineAllowlist: ["p"],
    });

    // A pipeline outside the token's allowlist is refused at create…
    const denied = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: "list-secret",
      body: { pipeline: "other", model: "flash", budgetMicroUsd: 100_000 },
    });
    assert.equal(denied.status, 403);
    assert.match(String((denied.body as { error: string }).error), /allowlist/i);
    // …but reads and actions still authenticate (the allowlist is a create
    // gate, not an auth gate).
    assert.equal((await api(ctx.baseUrl, "/api/health", { token: "list-secret" })).status, 200);

    // An allowlisted pipeline creates fine.
    const ok = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: "list-secret",
      body: { pipeline: "p", model: "flash", budgetMicroUsd: 100_000 },
    });
    assert.equal(ok.status, 201);
    const run = runOf(ok.body);
    await waitFor(
      async () => (await statusOf(ctx, run.id)) === "done",
      5_000,
      "allowlisted run completes",
    );

    // A token with NO allowlist (empty = allow-all) can create anything.
    const wildcard = await api(ctx.baseUrl, "/api/runs", {
      method: "POST",
      token: SECRET,
      body: { pipeline: "not-registered", model: "flash", budgetMicroUsd: 100_000 },
    });
    assert.equal(wildcard.status, 201, "empty allowlist = allow-all");
    // The unregistered pipeline fails at EXECUTION (not at the allowlist).
    const wildcardRun = runOf(wildcard.body);
    await waitFor(
      async () => (await statusOf(ctx, wildcardRun.id)) === "failed",
      5_000,
      "unregistered pipeline fails at execution",
    );
  } finally {
    await teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// Read endpoints: events, work-items
// ---------------------------------------------------------------------------

test("GET /api/events returns rows filtered by runId, after, and limit", async () => {
  const ctx = await setup();
  try {
    await ctx.daemon.emit({ ts: TS, type: "run.started", runId: "r1", data: { step: 1 } });
    await ctx.daemon.emit({ ts: TS, type: "run.started", runId: "r2", data: { step: 2 } });
    await ctx.daemon.emit({ ts: TS, type: "run.finished", runId: "r1", data: {} });

    type EventsBody = {
      events: Array<{ seq: number; type: string; runId?: string; data: Record<string, unknown> }>;
    };
    const all = (await api(ctx.baseUrl, "/api/events?after=0", { token: SECRET })).body as EventsBody;
    assert.equal(all.events.length, 3);
    assert.deepEqual(
      all.events.map((e) => e.seq),
      [1, 2, 3],
    );
    assert.equal(all.events[2]!.type, "run.finished");
    assert.equal(all.events[0]!.runId, "r1");
    assert.deepEqual(all.events[0]!.data, { step: 1 });

    const runOnly = (await api(ctx.baseUrl, "/api/events?runId=r1&after=0", { token: SECRET })).body as EventsBody;
    assert.deepEqual(
      runOnly.events.map((e) => e.seq),
      [1, 3],
    );

    const after = (await api(ctx.baseUrl, "/api/events?after=2", { token: SECRET })).body as EventsBody;
    assert.deepEqual(
      after.events.map((e) => e.seq),
      [3],
    );

    const limited = (await api(ctx.baseUrl, "/api/events?after=0&limit=1", { token: SECRET })).body as EventsBody;
    assert.equal(limited.events.length, 1);

    assert.equal((await api(ctx.baseUrl, "/api/events?after=oops", { token: SECRET })).status, 400);
    assert.equal((await api(ctx.baseUrl, "/api/events?limit=0", { token: SECRET })).status, 400);
  } finally {
    await teardown(ctx);
  }
});

test("GET /api/work-items selects via the selector JSON and returns camelCase items", async () => {
  const ctx = await setup();
  try {
    const repo = new WorkItemRepo(ctx.db);
    const items: WorkItem[] = [
      {
        id: "wi_full",
        kind: "function",
        unitId: "kyoshin/CGame",
        lifecycle: "pending",
        status: "FULL_MATCH",
        size: 128,
        attempts: 0,
        exhausted: false,
        ready: true,
        meta: {},
      },
      {
        id: "wi_code",
        kind: "function",
        unitId: "kyoshin/CGame",
        lifecycle: "pending",
        status: "CODE_MATCH",
        size: 64,
        attempts: 2,
        exhausted: false,
        ready: true,
        meta: { note: "near miss" },
      },
    ];
    for (const entry of items) await repo.insert(entry);

    const full = encodeURIComponent(JSON.stringify({ filter: { status: ["FULL_MATCH"] } }));
    const res = await api(ctx.baseUrl, `/api/work-items?selector=${full}`, { token: SECRET });
    assert.equal(res.status, 200);
    const body = res.body as { workItems: WorkItem[] };
    assert.deepEqual(
      body.workItems.map((w) => w.id),
      ["wi_full"],
    );
    assert.equal(body.workItems[0]!.unitId, "kyoshin/CGame");
    assert.equal(body.workItems[0]!.status, "FULL_MATCH");

    // Unfiltered (no selector param) returns everything.
    const all = (await api(ctx.baseUrl, "/api/work-items", { token: SECRET })).body as {
      workItems: WorkItem[];
    };
    assert.equal(all.workItems.length, 2);

    // Bad JSON / invalid selector shape → 400.
    assert.equal(
      (await api(ctx.baseUrl, "/api/work-items?selector=not-json", { token: SECRET })).status,
      400,
    );
    const badShape = encodeURIComponent(JSON.stringify({ filter: { status: "FULL_MATCH" } }));
    assert.equal(
      (await api(ctx.baseUrl, `/api/work-items?selector=${badShape}`, { token: SECRET })).status,
      400,
    );
  } finally {
    await teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// Introspection: POST /api/analyze (SPEC §17)
// ---------------------------------------------------------------------------

test("POST /api/analyze runs the introspection agent, bounds the prompt, and audits", async () => {
  const ctx = await setup();
  try {
    const res = await api(ctx.baseUrl, "/api/analyze", {
      method: "POST",
      token: SECRET,
      body: { prompt: "RESPOND: r1 was cancelled" },
    });
    assert.equal(res.status, 200);
    const body = res.body as { result: string };
    assert.equal(typeof body.result, "string");
    assert.equal(body.result, "r1 was cancelled");

    // The call is audited under the token's id (SPEC §16).
    const audit = await ctx.db.query<{ actor: string; action: string }>(
      "SELECT actor, action FROM audit_log",
    );
    assert.deepEqual(
      audit.map((r) => r.action),
      ["analyze"],
    );
    assert.equal(audit[0]!.actor, "tok-1");

    // runId is accepted; the prompt is BOUNDED (400 beyond the cap).
    const scoped = await api(ctx.baseUrl, "/api/analyze", {
      method: "POST",
      token: SECRET,
      body: { prompt: "RESPOND: ok", runId: "r1" },
    });
    assert.equal(scoped.status, 200);
    const tooLong = await api(ctx.baseUrl, "/api/analyze", {
      method: "POST",
      token: SECRET,
      body: { prompt: "x".repeat(40_000) },
    });
    assert.equal(tooLong.status, 400);
    const empty = await api(ctx.baseUrl, "/api/analyze", {
      method: "POST",
      token: SECRET,
      body: { prompt: "   " },
    });
    assert.equal(empty.status, 400);
    const badRunId = await api(ctx.baseUrl, "/api/analyze", {
      method: "POST",
      token: SECRET,
      body: { prompt: "RESPOND: x", runId: "" },
    });
    assert.equal(badRunId.status, 400);
  } finally {
    await teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// WebSocket tests (raw RFC 6455 client over a plain socket)
// ---------------------------------------------------------------------------

interface WsHandshake {
  status: number;
  headers: Record<string, string>;
  socket: Socket;
  leftover: Buffer;
}

/** Minimal raw-socket WS handshake: GET + headers, resolve on the HTTP response head. */
function openWs(
  port: number,
  opts: { token?: string; path?: string } = {},
): Promise<WsHandshake> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    const request =
      [
        `GET ${opts.path ?? "/ws/events"} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...(opts.token !== undefined ? [`Authorization: Bearer ${opts.token}`] : []),
        "",
        "",
      ].join("\r\n") + "\r\n";
    const chunks: Buffer[] = [];
    let settled = false;
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      chunks.push(chunk);
      const joined = Buffer.concat(chunks);
      const idx = joined.indexOf("\r\n\r\n");
      if (idx === -1) return;
      settled = true;
      const head = joined.subarray(0, idx).toString("latin1");
      const lines = head.split("\r\n");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const m = /^([^:]+):\s*(.*)$/.exec(line);
        if (m !== null) headers[m[1]!.toLowerCase()] = m[2]!;
      }
      resolve({ status, headers, socket, leftover: joined.subarray(idx + 4) });
    };
    const onError = (err: Error): void => {
      if (!settled) reject(err);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.write(request);
  });
}

/** Parse one server→client frame (unmasked, or masked defensively). */
function parseTestFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey: Buffer | null = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (maskKey !== null) {
    for (let i = 0; i < payload.length; i++) payload[i]! ^= maskKey[i % 4]!;
  }
  return { opcode, payload, consumed: offset + len };
}

/** Accumulates server frames; `next()` resolves with the next text frame. */
class WsFrameClient {
  private buffer: Buffer;
  private queue: string[] = [];
  private waiters: Array<(frame: string) => void> = [];

  constructor(
    private readonly socket: Socket,
    initial: Buffer,
  ) {
    this.buffer = initial;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseTestFrame(this.buffer);
      if (parsed === null) break;
      this.buffer = this.buffer.subarray(parsed.consumed);
      if (parsed.opcode !== 0x1) continue; // only text frames carry event lines
      const text = parsed.payload.toString("utf8");
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(text);
      else this.queue.push(text);
    }
  }

  next(timeoutMs = 10_000): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a WebSocket frame")),
        timeoutMs,
      );
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

test("ws/events upgrade without a valid token is rejected with 401", async () => {
  const ctx = await setup();
  try {
    const anonymous = await openWs(ctx.port, {});
    assert.equal(anonymous.status, 401);
    anonymous.socket.destroy();

    const badToken = await openWs(ctx.port, { token: "wrong-secret" });
    assert.equal(badToken.status, 401);
    badToken.socket.destroy();
  } finally {
    await teardown(ctx);
  }
});

test("ws/events upgrades to 101 and streams new event rows as JSON lines", async () => {
  const ctx = await setup();
  let client: WsFrameClient | null = null;
  try {
    const handshake = await openWs(ctx.port, { token: SECRET });
    assert.equal(handshake.status, 101);
    assert.ok(handshake.headers["sec-websocket-accept"], "101 must carry Sec-WebSocket-Accept");
    client = new WsFrameClient(handshake.socket, handshake.leftover);

    // Events emitted AFTER the upgrade (cursor = max seq at connect) stream in.
    await ctx.daemon.emit({ ts: TS, type: "run.started", runId: "r1", data: { step: 1 } });
    const line = await client.next();
    const event = JSON.parse(line) as { seq: number; type: string; runId?: string };
    assert.equal(event.type, "run.started");
    assert.equal(event.runId, "r1");
    assert.equal(event.seq, 1);
    assert.ok(line.endsWith("\n"), "each frame is a JSON line");
  } finally {
    client?.close();
    await teardown(ctx);
  }
});

test("ws/events?after=0 replays pre-existing events in seq order", async () => {
  const ctx = await setup();
  let client: WsFrameClient | null = null;
  try {
    await ctx.daemon.emit({ ts: TS, type: "run.started", runId: "r1", data: {} });
    await ctx.daemon.emit({ ts: TS, type: "run.finished", runId: "r1", data: {} });

    const handshake = await openWs(ctx.port, { token: SECRET, path: "/ws/events?after=0" });
    assert.equal(handshake.status, 101);
    client = new WsFrameClient(handshake.socket, handshake.leftover);

    const first = JSON.parse(await client.next()) as { type: string };
    const second = JSON.parse(await client.next()) as { type: string };
    assert.deepEqual(
      [first.type, second.type],
      ["run.started", "run.finished"],
    );
  } finally {
    client?.close();
    await teardown(ctx);
  }
});

/** Resolve once the server terminates the connection (close and/or error). */
function expectSocketClose(socket: Socket, label: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: connection did not close within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {
      /* a reset is fine — the close event follows */
    });
  });
}

/** Collect every frame until the close frame (or the socket closes); resolves
 * with the frames seen, INCLUDING the close frame (opcode 8) if any. */
function collectFramesUntilClose(
  socket: Socket,
  timeoutMs: number,
): Promise<Array<{ opcode: number; payload: Buffer }>> {
  return new Promise((resolve, reject) => {
    const frames: Array<{ opcode: number; payload: Buffer }> = [];
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(
      () => reject(new Error(`timed out collecting frames after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const settled = (): void => {
      clearTimeout(timer);
      resolve(frames);
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseTestFrame(buffer);
        if (parsed === null) break;
        buffer = buffer.subarray(parsed.consumed);
        frames.push({ opcode: parsed.opcode, payload: parsed.payload });
        if (parsed.opcode === 0x8) {
          settled();
          return;
        }
      }
    });
    socket.once("close", () => settled());
    socket.once("error", () => {
      /* close follows */
    });
  });
}

test("ws/events drops a client that declares an oversized frame", async () => {
  const ctx = await setup({ wsMaxFrameBytes: 1 << 20 });
  try {
    const handshake = await openWs(ctx.port, { token: SECRET });
    assert.equal(handshake.status, 101);
    // A 2 MiB text frame (FIN+text, 64-bit length) exceeds the 1 MiB cap:
    // the server must never allocate it — it terminates the connection.
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x7f;
    header.writeBigUInt64BE(BigInt(2 << 20), 2);
    handshake.socket.write(header);
    await expectSocketClose(handshake.socket, "oversized frame", 5_000);
    handshake.socket.destroy();
  } finally {
    await teardown(ctx);
  }
});

test("ws/events closes a connection that goes idle", async () => {
  const ctx = await setup({ wsIdleTimeoutMs: 150 });
  try {
    const handshake = await openWs(ctx.port, { token: SECRET });
    assert.equal(handshake.status, 101);
    // The client sends nothing (not even a ping) → dropped after the idle
    // timeout. Sending a ping would reset the timer.
    await expectSocketClose(handshake.socket, "idle timeout", 5_000);
    handshake.socket.destroy();
  } finally {
    await teardown(ctx);
  }
});

test("ws/events drops-with-sentinel once the buffered-bytes cap is exceeded", async () => {
  const ctx = await setup({ wsMaxBufferedBytes: 128, pollIntervalMs: 10 });
  try {
    const handshake = await openWs(ctx.port, { token: SECRET });
    assert.equal(handshake.status, 101);
    // A single ~2 KiB frame exceeds the 128-byte cap: the server must drop
    // the stream (bounded buffering) and signal it with a WS close frame
    // (code 1008) instead of silently buffering forever.
    const framesPromise = collectFramesUntilClose(handshake.socket, 5_000);
    await ctx.daemon.emit({
      ts: TS,
      type: "run.log",
      runId: "r1",
      data: { payload: "x".repeat(2048) },
    });
    const frames = await framesPromise;
    const closeFrame = frames.find((f) => f.opcode === 0x8);
    assert.ok(closeFrame !== undefined, "stream ends with a WS close frame (sentinel)");
    assert.equal(closeFrame!.payload.readUInt16BE(0), 1008, "close code 1008 = policy violation");
    assert.ok(
      frames.every((f) => f.opcode === 0x1 || f.opcode === 0x8),
      "only text frames followed by the close frame",
    );
    handshake.socket.destroy();
  } finally {
    await teardown(ctx);
  }
});

test("ws/events drops a slow consumer instead of buffering without bound", async () => {
  const ctx = await setup({ wsMaxBufferedBytes: 4096, pollIntervalMs: 10 });
  try {
    const handshake = await openWs(ctx.port, { token: SECRET });
    assert.equal(handshake.status, 101);
    // Slow consumer: PAUSE so the socket's receive window closes and the
    // server's writes back up until the buffered-bytes cap trips the drop
    // (a flowing socket would discard in userland and writableLength would
    // never grow).
    handshake.socket.pause();
    let received = 0;
    handshake.socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    const EMITTED = 5000;
    for (let i = 0; i < EMITTED; i++) {
      await ctx.daemon.emit({
        ts: new Date().toISOString(),
        type: "run.log",
        runId: "r1",
        data: { payload: "x".repeat(4096) },
      });
    }
    // Give the server time to trip the cap, then drain: the server's
    // terminate() end()s the socket, so the pending data + FIN reach us.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    handshake.socket.resume();
    await expectSocketClose(handshake.socket, "backpressure drop", 15_000);
    // Bounded buffering: the client received a small fraction of the ~20 MB
    // emitted (kernel + cap-bounded userland), never the whole stream.
    assert.ok(received > 0, "some events were streamed before the drop");
    assert.ok(
      received < 10_000_000,
      `bounded buffering: received ${received} bytes of ~${(EMITTED * 4106).toLocaleString()} emitted`,
    );
    handshake.socket.destroy();
  } finally {
    await teardown(ctx);
  }
});
