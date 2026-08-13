/**
 * Fake NDJSON worker for the WorkerPool tests (M2.5 / SPEC §7.1).
 *
 * Reads one JSON request per line on stdin — `{id, method, params}` — and
 * writes one JSON response per line on stdout — `{id, result}` or
 * `{id, error: {message}}`.
 *
 * Methods:
 *   echo       → responds with `params` unchanged (round-trip + correlation)
 *   id         → responds with the request id it saw (explicit id correlation)
 *   env        → responds with `process.env.FAKE_WORKER_ECHO` (spawn-env test)
 *   diff       → responds with a fake DiffResult-shaped document stamped with
 *                the worker process's per-process `instance` id (adapter
 *                pool-reuse / verify tests). `symbol === "MISSING_SYMBOL"`
 *                answers an error envelope with `exit_code: 4`; `symbol ===
 *                "MISMATCH"` answers a mismatching diff (mismatch_count > 0).
 *   slow       → sleeps 2000ms before responding (drives per-request timeouts)
 *   slow-once  → first process (marker file absent, `SLOW_ONCE_MARKER` env):
 *                flushes a PARTIAL response line to the pipe (a "late
 *                response" fragment the pool must discard when it kills us),
 *                then answers in full only after 2000ms. Later processes
 *                (marker present) answer immediately — drives the
 *                kill+respawn+retry "retry result wins" test.
 *   split      → writes the response line across two stdout writes, 40ms
 *                apart (partial-line reassembly test)
 *   bundle     → writes THREE response lines in one stdout write call: the
 *                real response, a duplicate for the same id, and a stale
 *                id 999999 line (many-lines-per-chunk + stale-id tests)
 *   garbage    → writes a non-JSON line (protocol-violation test)
 *   boom       → exits with code 3 without responding (crash while serving)
 *   other      → responds `{error: {message: "unknown method …"}}`
 */
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

/** Unique per-process id — lets tests prove WHICH worker process served a
 * request (two processes never share an id). */
const INSTANCE = `${process.pid}-${Math.random().toString(36).slice(2)}`;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result, error) {
  const msg = error ? { id, error: { message: error } } : { id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Respond with a structured error envelope carrying an exit code (mirrors
 * diff-engine.py's `{message, exit_code, stderr}` serialisation). */
function respondError(id, message, exitCode) {
  const error = { message };
  if (exitCode !== undefined) error.exit_code = exitCode;
  process.stdout.write(JSON.stringify({ id, error }) + "\n");
}

/** A fake DiffResult-shaped document (the adapter's diff()/verify() tests). */
function fakeDiff(params, mismatch = false) {
  const { unit, symbol } = params;
  return {
    symbol,
    retail_path: "fake.o",
    decomp_path: "fake-decomp.o",
    retail_size: 16,
    decomp_size: 16,
    total_instructions: 4,
    mismatch_count: mismatch ? 2 : 0,
    reg_swap_count: mismatch ? 1 : 0,
    pure_reg_swap_count: mismatch ? 0 : 0,
    structural_count: mismatch ? 1 : 0,
    reg_mapping: {},
    instructions: [],
    size_check: null,
    retail_relocations: [],
    decomp_relocations: [],
    reloc_drift: [],
    reloc_suggestions: {},
    unit,
    instance: INSTANCE,
  };
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.exit(2); // garbage on stdin: not an NDJSON worker
  }
  const { id, method, params } = msg;
  if (method === "boom") {
    process.exit(3); // crash mid-request, without ever responding
  }
  if (method === "slow") {
    setTimeout(() => respond(id, { slept: 2000 }), 2000);
    return;
  }
  if (method === "slow-once") {
    const marker = process.env.SLOW_ONCE_MARKER;
    if (marker && existsSync(marker)) {
      respond(id, { winner: "retry" });
      return;
    }
    if (marker) writeFileSync(marker, String(process.pid));
    // First (about-to-be-killed) process: flush a partial response line to
    // the pipe NOW — a "late response" fragment the pool must discard when
    // it times us out — then answer in full only after 2000ms.
    process.stdout.write(JSON.stringify({ id, result: { winner: "stale" } }).slice(0, 24));
    setTimeout(() => respond(id, { winner: "stale" }), 2000);
    return;
  }
  if (method === "split") {
    const text = JSON.stringify({ id, result: params });
    const mid = Math.floor(text.length / 2);
    process.stdout.write(text.slice(0, mid));
    setTimeout(() => process.stdout.write(text.slice(mid) + "\n"), 40);
    return;
  }
  if (method === "bundle") {
    const lines = [
      JSON.stringify({ id, result: "first" }),
      JSON.stringify({ id, result: "duplicate" }),
      JSON.stringify({ id: 999999, result: "stray" }),
    ];
    process.stdout.write(lines.join("\n") + "\n"); // one write(): many responses per chunk
    return;
  }
  if (method === "garbage") {
    process.stdout.write("this is not json at all\n");
    return;
  }
  if (method === "env") {
    respond(id, process.env.FAKE_WORKER_ECHO ?? null);
    return;
  }
  if (method === "id") {
    respond(id, id);
    return;
  }
  if (method === "diff") {
    if (params && params.symbol === "MISSING_SYMBOL") {
      respondError(
        id,
        "hexdiff diff failed for MISSING_SYMBOL (exit 4, no JSON on stdout): symbol not found",
        4,
      );
      return;
    }
    if (params && params.symbol === "MISMATCH") {
      respond(id, fakeDiff(params, true));
      return;
    }
    respond(id, fakeDiff(params));
    return;
  }
  if (method === "echo") {
    respond(id, params);
    return;
  }
  respond(id, undefined, `unknown method ${String(method)}`);
});

rl.on("close", () => process.exit(0));
