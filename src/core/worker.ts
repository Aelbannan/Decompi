/**
 * M2.5 persistent worker protocol (SPEC §7.1): a bounded pool of long-lived
 * child processes speaking NDJSON on stdio, with per-request timeouts,
 * kill+respawn+retry-once, and request-id correlation.
 *
 * Framing: the pool writes one JSON object per line to the worker's stdin —
 * `{"id", "method", "params"}` — and reads one JSON object per line from
 * stdout: `{"id", "result"}` on success or `{"id", "error": {"message"}}` on
 * failure. `id` is a pool-unique integer, freshly assigned per ATTEMPT: a
 * retry never reuses the wire id of the attempt it replaces, so a late
 * response from a killed process can never satisfy a retry (a stale response
 * is simply ignored).
 *
 * Concurrency: exactly one outstanding request per worker process. Requests
 * queue FIFO and dispatch to the next non-busy worker; `poolSize` bounds the
 * number of worker processes. Workers are spawned eagerly at construction
 * (warmup per SPEC §7.1 — "spawned at daemon start and serve many requests",
 * no per-call interpreter/import startup) and dead slots are respawned
 * lazily on the next dispatch.
 *
 * Failure (SPEC §7.1): a request that does not answer within `timeoutMs` has
 * its worker SIGKILLed (a wedged worker such as z3 mid-SMT is fenced, not
 * left to hang), the slot is respawned, and the request is retried ONCE on
 * the fresh process; a second timeout rejects with `WorkerTimeoutError`
 * (typed, with the attempt count). A worker that dies while serving a
 * request rejects it with `WorkerCrashError`; a worker that violates the
 * NDJSON framing is killed and its request rejects with
 * `WorkerProtocolError`; a spawn failure rejects with `WorkerSpawnError`; an
 * `{error}` envelope rejects with `WorkerRpcError` — error envelopes are
 * definitive answers from the worker and are never retried (retry-once is
 * reserved for timeouts, per §7.1).
 *
 * Lock discipline (SPEC §7.1): the pool itself never touches the build
 * flock; callers wrap build-performing RPCs (`buildUnit`, `diff`) in the
 * flock and run `witness`/SMT RPCs lock-free.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Persistent-worker engine description (SPEC §7.1): a command speaking
 * NDJSON on stdio, a per-request timeout, a pool size, and an optional
 * spawn environment. */
export interface WorkerSpec {
  /** Executable + argv of the worker process (e.g. `["python3", "hexdiff.py"]`). */
  command: string[];
  /** Wire framing; only `"ndjson"` is implemented. */
  protocol: "ndjson";
  /** Per-request fence: a worker that does not answer in time is killed. */
  timeoutMs: number;
  /** Bound on parallel worker processes; defaults to 1. */
  poolSize?: number;
  /** Environment for the spawned worker processes. When set it REPLACES the
   * environment (spawn semantics), so pass a full `{...process.env, K: V}`
   * map; when unset the worker inherits the host environment. Lets the
   * adapter hand the worker config (e.g. `XENOBLADE_REPO`) without mutating
   * `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Base class for every typed worker-pool failure (SPEC §7.1 "typed error"). */
export class WorkerError extends Error {
  /** Machine-readable discriminator: timeout | crash | protocol | spawn | rpc | closed. */
  readonly code: string;
  /** The RPC method that failed ("" for pool-level failures). */
  readonly method: string;

  constructor(code: string, message: string, method: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.method = method;
  }
}

/** A request that did not answer within `timeoutMs`; retried once first. */
export class WorkerTimeoutError extends WorkerError {
  /** Dispatches made for this request: 2 means "retried once, then failed". */
  readonly attempts: number;
  readonly timeoutMs: number;

  constructor(method: string, attempts: number, timeoutMs: number) {
    super(
      "timeout",
      `worker request ${JSON.stringify(method)} did not answer within ${timeoutMs}ms (attempt ${attempts} of ${MAX_ATTEMPTS})`,
      method,
    );
    this.attempts = attempts;
    this.timeoutMs = timeoutMs;
  }
}

/** The worker process died while serving the request. */
export class WorkerCrashError extends WorkerError {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    method: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderrTail = "",
  ) {
    const detail =
      exitCode !== null ? `exit code ${exitCode}` : `signal ${signal ?? "unknown"}`;
    super("crash", `worker serving ${JSON.stringify(method)} died (${detail})`, method);
    this.exitCode = exitCode;
    this.signal = signal;
    if (stderrTail.trim() !== "") {
      this.message += `; stderr: ${stderrTail.trimEnd().slice(-500)}`;
    }
  }
}

/** The worker violated the NDJSON framing (unparseable or non-object line). */
export class WorkerProtocolError extends WorkerError {
  constructor(method: string, detail: string) {
    super(
      "protocol",
      `worker protocol violation while serving ${JSON.stringify(method)}: ${detail}`,
      method,
    );
  }
}

/** The worker process could not be spawned (e.g. ENOENT). */
export class WorkerSpawnError extends WorkerError {
  constructor(command: string, cause: unknown) {
    super(
      "spawn",
      `failed to spawn worker ${JSON.stringify(command)}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      command,
    );
  }
}

/** The worker answered with an `{error: {message}}` envelope. */
export class WorkerRpcError extends WorkerError {
  /** The worker-reported exit code of the underlying tool (e.g. hexdiff rc),
   * when the error envelope carried one (diff-engine.py serialises
   * `exit_code`); undefined otherwise. */
  readonly exitCode: number | undefined;
  /** The worker-reported stderr tail, when the envelope carried one. */
  readonly stderr: string | undefined;

  constructor(method: string, message: string, exitCode?: number, stderr?: string) {
    super("rpc", `worker request ${JSON.stringify(method)} failed: ${message}`, method);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** The pool is closed; no further requests are accepted. */
export class WorkerClosedError extends WorkerError {
  constructor() {
    super("closed", "worker pool is closed", "");
  }
}

type ManagedProcess = ChildProcessWithoutNullStreams;

/** One logical RPC, queued or in flight on exactly one worker. */
interface PendingRequest {
  /** Wire id — freshly assigned per attempt by `dispatch`. */
  rid: number;
  method: string;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  /** How many times this request has been dispatched (1 or 2). */
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One worker-process slot: at most one request in flight per slot. */
interface WorkerSlot {
  proc: ManagedProcess | null;
  /** True while one request is in flight on this worker. */
  busy: boolean;
  current: PendingRequest | null;
  /** Partial stdout line not yet terminated by `\n`. */
  buffer: string;
  /** Last few stderr lines, for crash diagnostics. */
  stderrTail: string[];
  /** Resolves when this slot's current process exits/errors/closes. */
  settled: Promise<void>;
}

/** Max dispatches per request: 1 initial + 1 retry (SPEC §7.1). */
const MAX_ATTEMPTS = 2;
/** SIGTERM → SIGKILL grace for `close()` (SPEC §5 process model). */
const CLOSE_GRACE_MS = 200;

export class WorkerPool {
  /** `Required<WorkerSpec>` except `env` stays optional (spawn defaults to
   * the inherited environment when absent). */
  private readonly spec: Omit<Required<WorkerSpec>, "env"> & {
    env: NodeJS.ProcessEnv | undefined;
  };
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingRequest[] = [];
  private nextId = 1;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(spec: WorkerSpec) {
    if (spec.protocol !== "ndjson") {
      throw new Error(
        `worker pool: unsupported protocol ${JSON.stringify(spec.protocol)}; only "ndjson" is implemented`,
      );
    }
    if (
      !Array.isArray(spec.command) ||
      spec.command.length === 0 ||
      !spec.command.every((c) => typeof c === "string")
    ) {
      throw new Error("worker pool: command must be a non-empty string array (argv)");
    }
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
      throw new Error("worker pool: timeoutMs must be a positive number");
    }
    const poolSize = spec.poolSize ?? 1;
    if (!Number.isInteger(poolSize) || poolSize < 1) {
      throw new Error(`worker pool: poolSize must be a positive integer, got ${poolSize}`);
    }
    this.spec = {
      command: [...spec.command],
      protocol: "ndjson",
      timeoutMs: spec.timeoutMs,
      poolSize,
      env: spec.env,
    };
    // Warmup (SPEC §7.1): workers are spawned at construction so the first
    // request never pays interpreter/import startup. Dead slots (crash,
    // timeout kill, spawn failure) are respawned lazily on the next
    // dispatch, so the pool always serves from a fresh process after a kill.
    for (let i = 0; i < poolSize; i++) {
      const slot: WorkerSlot = {
        proc: null,
        busy: false,
        current: null,
        buffer: "",
        stderrTail: [],
        settled: Promise.resolve(),
      };
      this.slots.push(slot);
      this.spawn(slot);
    }
  }

  /**
   * Run one RPC: `{id, method, params}` on some free worker (queued FIFO
   * when all `poolSize` workers are busy), resolving with the `result` of
   * the matching `{id, result}` response. A request that does not answer
   * within `timeoutMs` is retried once on a fresh worker; failure after
   * both attempts rejects with a typed error.
   */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new WorkerClosedError());
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ rid: 0, method, params, resolve, reject, attempts: 0, timer: null });
      this.pump();
    });
  }

  /**
   * Shut the pool down: reject queued and in-flight requests with
   * `WorkerClosedError`, SIGTERM every worker, SIGKILL any that do not exit
   * within `CLOSE_GRACE_MS`, and resolve once the processes are gone.
   * Idempotent; further `request()` calls reject with `WorkerClosedError`.
   */
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const req of queued) req.reject(new WorkerClosedError());
    const procs: ManagedProcess[] = [];
    for (const slot of this.slots) {
      const req = slot.current;
      if (req) {
        if (req.timer) clearTimeout(req.timer);
        slot.current = null;
        slot.busy = false;
        req.reject(new WorkerClosedError());
      }
      if (slot.proc) {
        procs.push(slot.proc);
        slot.proc = null; // exit/close of these processes is now stale
      }
    }
    const settled = Promise.all(this.slots.map((s) => s.settled));
    for (const proc of procs) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    let graceElapsed = false;
    const grace = new Promise<void>((resolve) => {
      setTimeout(() => {
        graceElapsed = true;
        resolve();
      }, CLOSE_GRACE_MS);
    });
    await Promise.race([settled, grace]);
    if (graceElapsed) {
      for (const proc of procs) {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }
      // SIGKILL is uncatchable: the survivors exit immediately, so close()
      // waits for their exit events before resolving — no child is left for
      // the host to reap after close() returns.
      await settled;
    }
  }

  /** FIFO dispatch: assign queued requests to the next non-busy worker. */
  private pump(): void {
    if (this.closed) {
      const queued = this.queue.splice(0);
      for (const req of queued) req.reject(new WorkerClosedError());
      return;
    }
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => !s.busy);
      if (!slot) break; // all workers busy: the rest of the queue waits
      const req = this.queue.shift();
      if (!req) break;
      this.dispatch(slot, req);
    }
  }

  private dispatch(slot: WorkerSlot, req: PendingRequest): void {
    if (slot.proc === null || slot.proc.exitCode !== null || slot.proc.signalCode !== null) {
      // Dead or never-spawned slot: spawn a fresh process for this request.
      slot.proc = null;
      try {
        this.spawn(slot);
      } catch (err) {
        // Synchronous spawn failure (bad command/options): reject typed so
        // the request is never left dangling, and keep pumping the queue.
        slot.busy = false;
        req.reject(new WorkerSpawnError(this.spec.command[0]!, err));
        this.pump();
        return;
      }
    }
    const proc = slot.proc;
    if (proc === null) {
      req.reject(new WorkerSpawnError(this.spec.command[0]!, new Error("spawn failed")));
      this.pump();
      return;
    }
    slot.busy = true;
    slot.current = req;
    req.attempts += 1;
    req.rid = this.nextId++; // fresh wire id per attempt (see header)
    try {
      proc.stdin.write(
        JSON.stringify({ id: req.rid, method: req.method, params: req.params }) + "\n",
      );
    } catch {
      // The process died between the liveness check and the write.
      slot.current = null;
      slot.busy = false;
      slot.proc = null;
      req.reject(new WorkerCrashError(req.method, proc.exitCode, proc.signalCode));
      this.pump();
      return;
    }
    req.timer = setTimeout(() => this.onTimeout(slot, req), this.spec.timeoutMs);
  }

  private onData(slot: WorkerSlot, proc: ManagedProcess, chunk: string): void {
    if (slot.proc !== proc) return; // stale data from a replaced process
    slot.buffer += chunk;
    let nl: number;
    while ((nl = slot.buffer.indexOf("\n")) >= 0) {
      const line = slot.buffer.slice(0, nl).replace(/\r$/, "");
      slot.buffer = slot.buffer.slice(nl + 1);
      if (line.trim() === "") continue; // blank lines are tolerated
      this.onLine(slot, proc, line);
      if (slot.proc !== proc) return; // onLine killed/replaced the process
    }
  }

  private onLine(slot: WorkerSlot, proc: ManagedProcess, line: string): void {
    const current = slot.current;
    if (!current) return; // stray line (late response from a replaced attempt)
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      this.failWorker(
        slot,
        proc,
        new WorkerProtocolError(current.method, `unparseable line: ${JSON.stringify(line.slice(0, 120))}`),
      );
      return;
    }
    if (typeof obj !== "object" || obj === null) {
      this.failWorker(
        slot,
        proc,
        new WorkerProtocolError(current.method, `non-object JSON: ${JSON.stringify(line.slice(0, 120))}`),
      );
      return;
    }
    const env = obj as { id?: unknown; result?: unknown; error?: unknown };
    if (env.id !== current.rid) return; // not for the in-flight request
    if (env.error !== undefined && env.error !== null) {
      // Error envelopes may carry the tool's exit code / stderr tail
      // (diff-engine.py serialises {message, exit_code, stderr}) — keep them
      // on the typed error so callers (e.g. verify()) can classify failures.
      const raw = env.error;
      let message = "worker error";
      let exitCode: number | undefined;
      let stderr: string | undefined;
      if (typeof raw === "string") {
        message = raw;
      } else if (typeof raw === "object" && raw !== null) {
        const e = raw as { message?: unknown; exit_code?: unknown; stderr?: unknown };
        if (typeof e.message === "string") message = e.message;
        if (typeof e.exit_code === "number") exitCode = e.exit_code;
        if (typeof e.stderr === "string") stderr = e.stderr;
      }
      this.settle(slot, current, new WorkerRpcError(current.method, message, exitCode, stderr));
      return;
    }
    if (env.result === undefined) {
      // `{id}` with neither `result` nor `error` violates the framing.
      this.failWorker(
        slot,
        proc,
        new WorkerProtocolError(
          current.method,
          `response carries neither result nor error: ${JSON.stringify(line.slice(0, 120))}`,
        ),
      );
      return;
    }
    this.settle(slot, current, undefined, env.result);
  }

  /** Resolve/reject the in-flight request and dispatch whatever queued next. */
  private settle(slot: WorkerSlot, req: PendingRequest, err: unknown, value?: unknown): void {
    if (slot.current === req) {
      slot.current = null;
      slot.busy = false;
      if (req.timer) clearTimeout(req.timer);
      req.timer = null;
    }
    if (err !== undefined) req.reject(err);
    else req.resolve(value);
    this.pump();
  }

  private onTimeout(slot: WorkerSlot, req: PendingRequest): void {
    if (slot.current !== req) return; // settled while the timer was pending
    slot.current = null;
    slot.busy = false;
    req.timer = null;
    const proc = slot.proc;
    slot.proc = null; // detach before the kill: this process's exit is stale
    if (proc) {
      try {
        proc.kill("SIGKILL"); // fence the wedged worker, never leave it hanging
      } catch {
        /* already dead */
      }
    }
    if (req.attempts < MAX_ATTEMPTS) {
      // Retry ONCE on a fresh worker: re-queue at the head so the retry is
      // served before later requests, and let pump dispatch it to a free
      // slot (respawned if the killed one was the only one). dispatch
      // increments `attempts` and assigns a fresh wire id, so a late
      // response from the killed process can never satisfy the retry.
      this.queue.unshift(req);
      this.pump();
    } else {
      req.reject(new WorkerTimeoutError(req.method, req.attempts, this.spec.timeoutMs));
      this.pump(); // serves anything else queued; the dead slot respawns lazily
    }
  }

  private onExit(
    slot: WorkerSlot,
    proc: ManagedProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (slot.proc !== proc) return; // replaced (timeout/failure kill or close) — stale
    slot.proc = null;
    const req = slot.current;
    slot.current = null;
    slot.busy = false;
    if (req) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new WorkerCrashError(req.method, code, signal, slot.stderrTail.join("")));
    }
    this.pump();
  }

  private onSpawnError(slot: WorkerSlot, proc: ManagedProcess, err: Error): void {
    if (slot.proc !== proc) return; // stale
    slot.proc = null;
    const req = slot.current;
    slot.current = null;
    slot.busy = false;
    if (req && req.timer) clearTimeout(req.timer);
    if (req) req.reject(new WorkerSpawnError(this.spec.command[0]!, err));
    this.pump();
  }

  /** Kill a protocol-violating worker and reject its in-flight request. */
  private failWorker(slot: WorkerSlot, proc: ManagedProcess, err: WorkerError): void {
    if (slot.proc !== proc) return; // already replaced — stale
    const req = slot.current;
    slot.current = null;
    slot.busy = false;
    if (req && req.timer) clearTimeout(req.timer);
    slot.proc = null; // detach so exit/close of the dying process is stale
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    if (req) req.reject(err);
    this.pump();
  }

  private spawn(slot: WorkerSlot): void {
    const cmd = this.spec.command[0]!;
    const args = this.spec.command.slice(1);
    const proc = spawn(
      cmd,
      args,
      this.spec.env === undefined ? undefined : { env: this.spec.env },
    ); // default stdio: pipe, pipe, pipe
    slot.proc = proc;
    // Each new process starts with a clean framing buffer: a partial line
    // flushed by a replaced (killed/crashed) process must never contaminate
    // the next process's first line (a stale prefix would corrupt its parse).
    slot.buffer = "";
    slot.settled = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.once("error", () => resolve());
      proc.once("close", () => resolve());
    });
    // setEncoding keeps multi-byte UTF-8 intact across chunk boundaries.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(slot, proc, chunk));
    proc.stderr.on("data", (chunk: string) => {
      slot.stderrTail.push(chunk);
      if (slot.stderrTail.length > 20) slot.stderrTail.shift();
    });
    // A dying process can EPIPE on stdin; liveness is enforced by the
    // dispatch liveness check and the timeout fence, so swallow stream
    // errors rather than crashing the host.
    proc.stdin.on("error", () => {});
    proc.on("error", (err) => this.onSpawnError(slot, proc, err));
    proc.on("exit", (code, signal) => this.onExit(slot, proc, code, signal));
  }
}
