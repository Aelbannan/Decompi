/**
 * M2.5 — Xenoblade adapter unit tests (SPEC §7 / §7.1) — no xenoblade repo
 * required. The diff-engine WorkerPool is faked (tests/helpers/fake-worker.mjs)
 * so the pool lifecycle (one persistent pool reused across diff() calls,
 * dispose()), verify()'s diff-error → rejected-verdict mapping, the build
 * lock path, and the dist packaging of diff-engine.py are all testable in
 * the hermetic CI environment. The repo-gated parity tests (worker vs
 * `hexdiff.py --json` on real goldens) live in tests/xenoblade-parity.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  XenobladeAdapter,
  resolveXenobladeRoot,
} from "../adapters/xenoblade/adapter.js";
import type { AdapterCtx, DiffResult } from "../src/adapter/types.js";
import type { WorkerSpec } from "../src/core/worker.js";
import type { WorkItem } from "../src/types.js";

const FAKE_WORKER = fileURLToPath(new URL("./helpers/fake-worker.mjs", import.meta.url));

/** Adapter whose diffEngine points at the fake worker (no repo needed). */
class FakeEngineAdapter extends XenobladeAdapter {
  override diffEngine(): WorkerSpec {
    return {
      command: [process.execPath, FAKE_WORKER],
      protocol: "ndjson",
      timeoutMs: 5000,
      poolSize: 1,
    };
  }
}

/** M2.5 diff()/verify() never touch ctx.store (the §7.1 pool handoff is M4). */
const ctx = {} as AdapterCtx;

function item(symbol: string, unit = "kyoshin/CGame"): WorkItem {
  return {
    id: `t-${symbol}`,
    kind: "function",
    lifecycle: "pending",
    status: "NOT_STARTED",
    unitId: unit,
    symbol,
    attempts: 0,
    exhausted: false,
    ready: false,
    meta: {},
  };
}

test("diff() reuses ONE persistent WorkerPool across calls; dispose() closes it and a later diff respawns", async () => {
  const adapter = new FakeEngineAdapter();
  // The fake worker stamps every diff response with its per-process instance
  // id: the SAME id across two diff() calls proves both were served by one
  // long-lived worker process (no per-call spawn).
  const a = (await adapter.diff(ctx, item("sym_a"))) as DiffResult & { instance: string };
  const b = (await adapter.diff(ctx, item("sym_b"))) as DiffResult & { instance: string };
  assert.equal(
    a.instance,
    b.instance,
    "diff() must reuse the persistent worker process, not spawn one per call",
  );
  await adapter.dispose();
  // dispose() closed the pool; the next diff() lazily builds a fresh one.
  const c = (await adapter.diff(ctx, item("sym_c"))) as DiffResult & { instance: string };
  assert.notEqual(
    c.instance,
    a.instance,
    "dispose() closes the pool; the next diff() must spawn a fresh worker",
  );
  await adapter.dispose(); // idempotent
});

test("verify() maps a diff error envelope (exit 4) to a rejected NOT_FOUND verdict, never throws", async () => {
  const adapter = new FakeEngineAdapter();
  try {
    // The fake worker answers symbol "MISSING_SYMBOL" with
    // {error: {message, exit_code: 4}} — the hexdiff symbol-not-found rc.
    const verdict = await adapter.verify(ctx, item("MISSING_SYMBOL"));
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.status, "NOT_FOUND");
    assert.equal(verdict.evidence.symbol, "MISSING_SYMBOL");
    assert.match(String(verdict.feedback), /exit 4/);
  } finally {
    await adapter.dispose();
  }
});

test("verify() accepts a clean diff (FULL_MATCH) and rejects a mismatching diff with feedback", async () => {
  const adapter = new FakeEngineAdapter();
  try {
    const clean = await adapter.verify(ctx, item("CLEAN"));
    assert.equal(clean.accepted, true);
    assert.equal(clean.status, "FULL_MATCH");
    assert.equal(clean.evidence.symbol, "CLEAN");
    assert.equal((clean.evidence.diff as { mismatch_count: number }).mismatch_count, 0);

    // The fake worker answers "MISMATCH" with a diff carrying mismatch_count
    // 2 / reg_swap 1 / structural 1 — verify rejects with feedback, no throw.
    const mismatch = await adapter.verify(ctx, item("MISMATCH"));
    assert.equal(mismatch.accepted, false);
    assert.equal(mismatch.status, undefined);
    assert.match(String(mismatch.feedback), /2\/4 instructions differ/);
    assert.match(String(mismatch.feedback), /1 structural/);
  } finally {
    await adapter.dispose();
  }
});

test("buildLockPath() resolves to build/<region>/.hexdiff.lock and honours DECOMPI_XENOBLADE_REGION", () => {
  const adapter = new XenobladeAdapter();
  const root = resolveXenobladeRoot();
  assert.equal(adapter.buildLockPath(ctx), join(root, "build", "us", ".hexdiff.lock"));
  const prev = process.env.DECOMPI_XENOBLADE_REGION;
  process.env.DECOMPI_XENOBLADE_REGION = "eu";
  try {
    assert.equal(adapter.buildLockPath(ctx), join(root, "build", "eu", ".hexdiff.lock"));
  } finally {
    if (prev === undefined) delete process.env.DECOMPI_XENOBLADE_REGION;
    else process.env.DECOMPI_XENOBLADE_REGION = prev;
  }
});

test("the build script copies diff-engine.py into dist/ next to the compiled adapter", () => {
  // The compiled adapter resolves the engine via `new URL("diff-engine.py",
  // import.meta.url)` → dist/adapters/xenoblade/diff-engine.py, so the build
  // script must copy the Python worker next to adapter.js or the packaged
  // package is broken (adversarial review LOW-8).
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  const build = pkg.scripts.build;
  assert.ok(build, "package.json must define a build script");
  assert.match(
    build,
    /copyFileSync\(['"]adapters\/xenoblade\/diff-engine\.py['"]\s*,\s*['"]dist\/adapters\/xenoblade\/diff-engine\.py['"]\)/,
    "build must copy adapters/xenoblade/diff-engine.py → dist/adapters/xenoblade/diff-engine.py",
  );
});
