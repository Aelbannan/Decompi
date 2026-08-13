/**
 * WorkerPool tests (SPEC §7.1 / M2.5): NDJSON framing + request-id
 * correlation, per-request timeout with kill+respawn+retry-once, crash
 * respawn, FIFO queueing under a single worker vs parallel dispatch under
 * poolSize > 1, the `{error: {message}}` envelope (with exit_code/stderr
 * passthrough), chunk-boundary framing (split lines, many lines per chunk),
 * spawn ENOENT, protocol violations, spawn env passthrough, a late response
 * from a killed timed-out worker being ignored, and close semantics — all
 * against the fake worker fixture (tests/helpers/fake-worker.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WorkerClosedError,
  WorkerCrashError,
  WorkerError,
  WorkerPool,
  WorkerProtocolError,
  WorkerRpcError,
  WorkerSpawnError,
  WorkerTimeoutError,
  type WorkerSpec,
} from "../src/core/worker.js";

const FAKE_WORKER = fileURLToPath(new URL("./helpers/fake-worker.mjs", import.meta.url));

function makeSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    command: [process.execPath, FAKE_WORKER],
    protocol: "ndjson",
    timeoutMs: 500,
    ...overrides,
  };
}

/** Capture the rejection of a promise (asserting it did reject). */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected the request to reject");
    },
    (err: unknown) => err,
  );
}

test("echo round-trips with request-id correlation (poolSize 1)", async () => {
  const pool = new WorkerPool(makeSpec());
  try {
    // A single echo returns its params unchanged, across JSON value shapes.
    assert.deepEqual(
      await pool.request("echo", { n: 1, list: [1, 2, 3], ok: true, nil: null, deep: { a: ["b"] } }),
      { n: 1, list: [1, 2, 3], ok: true, nil: null, deep: { a: ["b"] } },
    );
    // Two concurrent echoes queue on the single worker; each promise must
    // resolve with ITS OWN params (wire-id correlation), in dispatch order.
    const [a, b] = await Promise.all([
      pool.request("echo", "first"),
      pool.request("echo", "second"),
    ]);
    assert.deepEqual([a, b], ["first", "second"]);
    // Explicit wire-id check: the worker reports the request id it saw.
    const id1 = await pool.request("id");
    const id2 = await pool.request("id");
    assert.equal(typeof id1, "number");
    assert.equal(typeof id2, "number");
    assert.notEqual(id1, id2, "each request must carry a distinct wire id");
  } finally {
    await pool.close();
  }
});

test("poolSize defaults to 1", async () => {
  const pool = new WorkerPool(makeSpec({ poolSize: undefined }));
  try {
    assert.equal(await pool.request("echo", "one"), "one");
  } finally {
    await pool.close();
  }
});

test("a slow request times out, is retried once on a fresh worker, then rejects with WorkerTimeoutError", async () => {
  const pool = new WorkerPool(makeSpec({ timeoutMs: 200 }));
  try {
    const err = await rejection(pool.request("slow"));
    assert.ok(err instanceof WorkerTimeoutError, `got ${String(err)}`);
    assert.equal(err.code, "timeout");
    assert.equal(err.method, "slow");
    assert.equal(err.attempts, 2, "the request must be retried exactly once before rejecting");
    // The pool is still usable after the timeout kill + respawn cycle.
    assert.equal(await pool.request("echo", "still alive"), "still alive");
  } finally {
    await pool.close();
  }
});

test("a crashing worker rejects with a typed error and is respawned for the next request", async () => {
  const pool = new WorkerPool(makeSpec());
  try {
    assert.equal(await pool.request("echo", "before"), "before");
    const err = await rejection(pool.request("boom"));
    assert.ok(err instanceof WorkerCrashError, `got ${String(err)}`);
    assert.equal(err.code, "crash");
    assert.equal(err.exitCode, 3, "the fixture exits 3 on boom");
    // The dead slot is respawned lazily: a subsequent echo succeeds.
    assert.equal(await pool.request("echo", "after"), "after");
  } finally {
    await pool.close();
  }
});

test("two concurrent requests queue on a single worker and resolve in order", async () => {
  const pool = new WorkerPool(makeSpec()); // poolSize 1
  try {
    const payloads = Array.from({ length: 5 }, (_, i) => ({ i, tag: `req-${i}` }));
    const results = await Promise.all(payloads.map((p) => pool.request("echo", p)));
    assert.deepEqual(results, payloads);
  } finally {
    await pool.close();
  }
});

test("poolSize 2 runs concurrent slow requests in parallel, not serialized", async () => {
  const pool = new WorkerPool(makeSpec({ poolSize: 2, timeoutMs: 5000 }));
  try {
    const start = Date.now();
    const results = await Promise.all([pool.request("slow"), pool.request("slow")]);
    const elapsed = Date.now() - start;
    assert.deepEqual(results, [{ slept: 2000 }, { slept: 2000 }]);
    assert.ok(
      elapsed < 3000,
      `two slow requests should overlap on poolSize 2: elapsed ${elapsed}ms`,
    );
  } finally {
    await pool.close();
  }
});

test("an error envelope rejects with a typed WorkerError carrying the worker message", async () => {
  const pool = new WorkerPool(makeSpec());
  try {
    const err = await rejection(pool.request("nope"));
    assert.ok(err instanceof WorkerError);
    assert.equal(err.code, "rpc");
    assert.match(String(err.message), /unknown method nope/);
  } finally {
    await pool.close();
  }
});

test("close() rejects queued and in-flight requests, then further requests; idempotent", async () => {
  const pool = new WorkerPool(makeSpec({ poolSize: 2 }));
  try {
    // Fire a burst synchronously: 2 dispatch immediately, the rest queue.
    const pending = Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => pool.request("echo", i)),
    );
    await pool.close();
    const settled = await pending;
    assert.equal(settled.length, 8);
    for (const r of settled) {
      if (r.status === "fulfilled") {
        assert.equal(typeof r.value, "number");
      } else {
        assert.ok(
          r.reason instanceof WorkerClosedError,
          `rejected with ${String(r.reason)}`,
        );
      }
    }
    // The pool is permanently closed: further requests reject typed.
    const err = await rejection(pool.request("echo", "post-close"));
    assert.ok(err instanceof WorkerClosedError);
    await pool.close(); // idempotent
  } finally {
    await pool.close();
  }
});

test("a response line split across two stdout chunks is reassembled", async () => {
  const pool = new WorkerPool(makeSpec());
  try {
    // "split" writes half the JSON now and the rest (+"\n") 40ms later;
    // the pool must reassemble the partial line, not mis-parse it.
    const payload = { payload: "x".repeat(64), n: 1, nested: { a: [1, 2, 3] } };
    assert.deepEqual(await pool.request("split", payload), payload);
  } finally {
    await pool.close();
  }
});

test("many response lines in one stdout chunk are parsed; duplicates and stale ids are ignored", async () => {
  const pool = new WorkerPool(makeSpec());
  try {
    // "bundle" writes, in a single write() call: the real response, a
    // duplicate for the same id, and a stale-id line. The pool settles on
    // the first, ignores the rest, and must stay healthy.
    assert.equal(await pool.request("bundle", undefined), "first");
    assert.equal(await pool.request("echo", "still healthy"), "still healthy");
  } finally {
    await pool.close();
  }
});

test("spawn ENOENT rejects with WorkerSpawnError", async () => {
  const pool = new WorkerPool(
    makeSpec({ command: ["/definitely/not/a/real/binary-zzz", "--arg"] }),
  );
  try {
    const err = await rejection(pool.request("echo", "hi"));
    assert.ok(err instanceof WorkerSpawnError, `got ${String(err)}`);
    assert.equal(err.code, "spawn");
    assert.match(String(err.message), /ENOENT/i);
  } finally {
    await pool.close();
  }
});

test("a non-JSON stdout line rejects with WorkerProtocolError and the worker is fenced", async () => {
  const pool = new WorkerPool(makeSpec());
  try {
    const err = await rejection(pool.request("garbage"));
    assert.ok(err instanceof WorkerProtocolError, `got ${String(err)}`);
    assert.equal(err.code, "protocol");
    assert.match(String(err.message), /unparseable line/);
    // The protocol-violating worker was killed; the dead slot respawns.
    assert.equal(await pool.request("echo", "recovered"), "recovered");
  } finally {
    await pool.close();
  }
});

test("a response {id} with neither result nor error is a protocol violation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-bare-id-"));
  const worker = join(dir, "bare.mjs");
  writeFileSync(
    worker,
    String.raw`process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: msg.id }) + "\n"); // bare {id}
  }
});`,
  );
  const pool = new WorkerPool(makeSpec({ command: [process.execPath, worker] }));
  try {
    const err = await rejection(pool.request("echo", "hi"));
    assert.ok(err instanceof WorkerProtocolError, `got ${String(err)}`);
    assert.equal(err.code, "protocol");
    assert.match(String(err.message), /neither result nor error/);
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a late response from a killed timed-out worker is ignored: the retry result wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-slow-once-"));
  const marker = join(dir, "marker");
  try {
    const pool = new WorkerPool(
      makeSpec({
        timeoutMs: 300,
        env: { ...process.env, SLOW_ONCE_MARKER: marker },
      }),
    );
    try {
      const result = await pool.request("slow-once", { n: 1 });
      assert.deepEqual(
        result,
        { winner: "retry" },
        "the retried attempt's result must win over the killed attempt",
      );
      assert.ok(existsSync(marker), "the first (killed) attempt must have run");
    } finally {
      await pool.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WorkerSpec.env is passed to the spawned worker process", async () => {
  const pool = new WorkerPool(
    makeSpec({ env: { ...process.env, FAKE_WORKER_ECHO: "via-spec-env" } }),
  );
  try {
    assert.equal(await pool.request("env"), "via-spec-env");
  } finally {
    await pool.close();
  }
});

test("an error envelope carries the worker's exit_code / stderr on WorkerRpcError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-exit-code-"));
  const worker = join(dir, "exit-code.mjs");
  writeFileSync(
    worker,
    String.raw`process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    process.stdout.write(
      JSON.stringify({ id: msg.id, error: { message: "symbol missing", exit_code: 4, stderr: "boom" } }) + "\n",
    );
  }
});`,
  );
  const pool = new WorkerPool(makeSpec({ command: [process.execPath, worker] }));
  try {
    const err = await rejection(pool.request("diff"));
    assert.ok(err instanceof WorkerRpcError, `got ${String(err)}`);
    assert.equal(err.code, "rpc");
    assert.equal(err.exitCode, 4, "the envelope's exit_code must be preserved");
    assert.equal(err.stderr, "boom", "the envelope's stderr must be preserved");
    assert.match(String(err.message), /symbol missing/);
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
