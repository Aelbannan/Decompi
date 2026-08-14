/**
 * M4 run scheduler (SPEC §5, §11, §16, §19 M4 row): the piece of the control
 * plane that turns `RunSpec`s into `runs` rows and executes them through the
 * pipeline engine under a concurrency cap.
 *
 * Concurrency (SPEC §5): a FIFO counting semaphore caps concurrently ACTIVE
 * runs at `maxParallelRuns`. `createRun` inserts a `runs` row (status
 * `queued`) and enqueues it; queued runs start, FIFO, as slots free up.
 *
 * Execution: each active run calls `runPipelineWithBudget` with its own
 * model/budget (SPEC §11 per-run model) and a store-backed `select`; on
 * completion the row moves to `done` (or `failed` on error) with
 * `finished_at` set. All `runs`-table writes serialize through ONE
 * promise-chain write queue (single-writer safety, the same pattern the
 * StoreDaemon uses for its own writes); lifecycle events are routed through
 * a supplied `StoreDaemon`'s serialized event path when one is present, so
 * `events.seq` assignment stays daemon-owned (SPEC §18). The M2 daemon's
 * public surface has no runs-table API, so the runs rows themselves remain on
 * this scheduler's store-level queue — both queues share one adapter
 * connection, which serializes statements.
 *
 * Pause is COOPERATIVE (M4): `pause(id)` sets `runs.pause_requested = 1`; a
 * queued run parks at the gate (status `paused`), and a running run checks
 * `shouldPause(id)` at every agent-step boundary through a runtime-wrapper
 * hook (before `createSession` and before each `prompt` turn — the step
 * boundaries of the engine's `agent` steps). A run that yields marks itself
 * `paused`, FREES its semaphore slot (queued runs may start in its place),
 * and waits; `resume(id)` clears the flag and the run re-acquires a slot and
 * continues at the same boundary. A run that has no further agent steps
 * completes without observing a pending pause — documented limitation of
 * cooperative pause (M4 has no hard-abort path).
 *
 * Cancel: `cancel(id)` moves the row to `cancelled` immediately (terminal)
 * and stops workers cooperatively — queued runs never start, paused runs
 * stop at once, and a running run's in-flight agent turn completes before it
 * aborts at the next step boundary. The SIGTERM→SIGKILL hard-abort path of
 * SPEC §11 is out of scope for the M4 scheduler.
 *
 * Reads (`getRun`/`listRuns`) serialize through the same write queue so they
 * never observe an in-flight write's uncommitted state on the shared
 * connection (read-after-write consistency, as in the StoreDaemon).
 *
 * Completion audit (SPEC §16 spend caps): when a run's execution settles
 * (done/failed/cancelled) the scheduler writes an `audit_log` row carrying
 * the ACTUAL metered cost from the run's BudgetTracker (the create row only
 * records the reserved budget; actuals are folded in here, so budgetless
 * runs cannot silently bypass the global cap).
 *
 * Restart recovery (SPEC §11): construction re-pauses `runs` rows left
 * `running` by a crashed scheduler (they have no live execution here) and
 * re-enqueues stale `queued` rows with specs rebuilt from the row;
 * `resume()` on a recovered paused run recreates the execution.
 *
 * The scheduler does NOT own the `SqlAdapter` or the `PipelineEngine` — the
 * host creates, migrates, registers pipelines onto, and closes them.
 * `close()` cancels every non-terminal run and resolves once all in-flight
 * executions have settled; the store stays open (host-owned).
 */
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../agent/runtime.js";
import { MockAgentRuntime } from "../agent/mock.js";
import type { StoreDaemon } from "../core/daemon.js";
import type { SqlAdapter } from "../core/store/adapter.js";
import type { Selector } from "../types.js";
import { PipelineEngine, type RunContext } from "../pipeline/engine.js";
import { runPipelineWithBudget } from "../pipeline/run.js";
import { WorkItemRepo } from "../target/work-item.js";
import { applyScope, type RunScope } from "../workflow/scope.js";
import type { WorkflowCompletionStore } from "../workflow/completions.js";
import type { HelperRegistry } from "../workflow/helpers.js";

/** `runs.status` vocabulary (schema.sql). */
export type RunStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

/** Input to {@link RunScheduler.createRun} — one logical run to schedule. */
export interface RunSpec {
  /** Registered pipeline id (must be registered on the engine). */
  pipeline: string;
  /** Model directory name — the run's default model (SPEC §11 `Run.model`). */
  model: string;
  /** Declarative selection for `plan`/`select` steps (defaults to all). */
  selector?: Selector;
  /** Explicit run scope (SPEC §6): target/unit id allowlists, AND-ed into the
   * run's selection (`targetIds` → `filter.ids`, `unitIds` → `filter.unit`).
   * Folded into the persisted `runs.selector` so a restarted run keeps it. */
  scope?: RunScope;
  /** Whole-run spend cap in integer micro-USD; undefined = unlimited. */
  budgetMicroUsd?: number;
  /**
   * Audit actor (token id) that created the run. Recorded on the completion
   * audit row so ACTUAL spend counts against the creator's per-token cap
   * (SPEC §16); absent in direct (non-API) scheduler use.
   */
  actor?: string;
}

/** A materialized `runs` row, camelCase per §6.1. */
export interface RunRecord {
  id: string;
  pipeline: string;
  model: string;
  status: RunStatus;
  /** Integer micro-USD cap; null = unlimited. */
  budgetMicroUsd: number | null;
  /** ISO-8601 insert time. */
  createdAt: string;
  /** ISO-8601 first-start time; null until the run actually starts. */
  startedAt: string | null;
  /** ISO-8601 stop time (done/failed/cancelled); null while in flight. */
  finishedAt: string | null;
  /** Parsed `selector` JSON; null when the row stores no usable JSON. */
  selector: Selector | null;
}

/** Constructor options for {@link RunScheduler}. */
export interface RunSchedulerOptions {
  /** The store (host-owned, already migrated). */
  store: SqlAdapter;
  /** Pipeline engine with the target pipelines/fragments registered. */
  engine: PipelineEngine;
  /** Cap on concurrently ACTIVE runs (SPEC §5 "N concurrent runs"). */
  maxParallelRuns: number;
  /**
   * Agent runtime for every run. Defaults to a deterministic
   * `MockAgentRuntime` (tests) — pass a real adapter in production.
   */
  runtime?: AgentRuntime;
  /**
   * StoreDaemon when present: lifecycle events ride its serialized event
   * path (`events.seq` stays daemon-owned, SPEC §18).
   */
  daemon?: StoreDaemon;
  /** Verifiers passed through to `runPipelineWithBudget` (e.g. the `diff`
   * verifier for the builtin match pipeline). */
  verifiers?: RunContext["verifiers"];
  /**
   * Workflow completion store (SPEC §5): threaded into every run — when the
   * run supplies no `finalize`, accepted `{ promote: true }` items record
   * precise completion rows through it, so a later plan for the same
   * workflow skips them.
   */
  completions?: WorkflowCompletionStore;
  /**
   * Adapter-wide helper registry (SPEC §3): threaded into every run so
   * `forwardCtx` materializes `ctx.helpers` (e.g. the xenoblade coop-tool
   * helpers from `registerHelpers`).
   */
  helpers?: HelperRegistry;
  /**
   * Map a pipeline id to the `runs.adapter` column value. The engine does not
   * expose a pipeline's `adapter`, so the scheduler cannot resolve it itself;
   * the host (which registered the pipelines) should. Defaults to the
   * pipeline id.
   */
  adapterFor?: (pipelineId: string) => string;
}

/** Raw snake_case `runs` row as stored (schema.sql §6.2). */
interface RunRow {
  id: string;
  pipeline: string;
  model: string;
  status: string;
  budget_micro_usd: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  selector: string;
}

/** Map a raw `runs` row to a `RunRecord` (selector JSON parsed defensively). */
function rowToRunRecord(row: RunRow): RunRecord {
  let selector: Selector | null = null;
  try {
    const parsed: unknown = JSON.parse(row.selector);
    if (parsed !== null && typeof parsed === "object") {
      selector = parsed as Selector;
    }
  } catch {
    selector = null;
  }
  return {
    id: row.id,
    pipeline: row.pipeline,
    model: row.model,
    status: row.status as RunStatus,
    budgetMicroUsd: row.budget_micro_usd,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    selector,
  };
}

/**
 * Internal signal that a run must stop at a step boundary (cancel/close).
 * Distinct from an engine/budget error: the run's row is already terminal.
 */
class RunAbortedError extends Error {
  constructor(runId: string, reason: string) {
    super(`run ${runId}: ${reason}`);
    this.name = "RunAbortedError";
  }
}

/** Rebuild a {@link RunSpec} from a materialized row (restart recovery: the
 * in-memory `specs` map is empty after a restart, but the row has everything
 * executeRun needs). */
function specFromRecord(record: RunRecord): RunSpec {
  return {
    pipeline: record.pipeline,
    model: record.model,
    ...(record.selector !== null ? { selector: record.selector } : {}),
    ...(record.budgetMicroUsd !== null ? { budgetMicroUsd: record.budgetMicroUsd } : {}),
  };
}

/**
 * FIFO counting semaphore (SPEC §5): `tryAcquire` for the pump, async
 * `acquire` for a resumed run re-taking a slot, `release` to free one.
 * `acquire` resolves TRUE when a slot was granted and FALSE when
 * `close()` woke the waiter WITHOUT granting — a woken caller aborts
 * without touching capacity (M4 cancel/close race fix).
 */
class Semaphore {
  private slots: number;
  private closed = false;
  private readonly waiters: Array<(granted: boolean) => void> = [];

  constructor(capacity: number) {
    this.slots = capacity;
  }

  /** Take a slot immediately when one is free; false otherwise. */
  tryAcquire(): boolean {
    if (this.closed || this.slots <= 0) return false;
    this.slots -= 1;
    return true;
  }

  /** Take a slot, waiting FIFO for one to be released. Resolves false when
   * the semaphore was closed without granting (the caller must NOT mark the
   * run running). */
  acquire(): Promise<boolean> {
    if (this.tryAcquire()) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => this.waiters.push(resolve));
  }

  /**
   * Free one slot. Hands it to the longest-waiting acquirer (capacity
   * unchanged — the waiter owns the slot) or restores it to the pool.
   */
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next(true);
      return;
    }
    this.slots += 1;
  }

  /** Wake all waiters WITHOUT granting slots; each resolves false. */
  close(): void {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake(false);
  }
}

/**
 * The M4 run scheduler: `runs` rows + execution with a concurrency cap,
 * cooperative pause, cancel, and single-writer-safe store access.
 */
export class RunScheduler {
  private readonly store: SqlAdapter;
  private readonly engine: PipelineEngine;
  private readonly runtime: AgentRuntime;
  private readonly daemon: StoreDaemon | undefined;
  private readonly verifiers: RunContext["verifiers"] | undefined;
  private readonly completions: WorkflowCompletionStore | undefined;
  private readonly helpers: HelperRegistry | undefined;
  private readonly maxParallelRuns: number;
  private readonly semaphore: Semaphore;
  private readonly repo: WorkItemRepo;
  private readonly adapterFor: (pipelineId: string) => string;

  /** Tail of the runs-table write serialization chain (single-writer safety). */
  private writeTail: Promise<void> = Promise.resolve();

  /** FIFO of queued run ids; startable = not pause-requested. */
  private readonly queued: string[] = [];
  /** Run specs by id (what `executeRun` needs after the row is inserted). */
  private readonly specs = new Map<string, RunSpec>();
  /** In-flight executions (running + paused-waiting), id → promise. */
  private readonly executions = new Map<string, Promise<void>>();
  /** Run ids currently holding a semaphore slot. */
  private readonly slotOwners = new Set<string>();
  /** Pause-requested flag mirror (source of truth is `runs.pause_requested`). */
  private readonly pauseRequested = new Set<string>();
  /** Cancelled runs (terminal intent mirror of `runs.status = 'cancelled'`). */
  private readonly cancelled = new Set<string>();
  /** Paused executions awaiting resume(), id → release. */
  private readonly resumeWaiters = new Map<string, () => void>();

  private closed = false;

  constructor(opts: RunSchedulerOptions) {
    this.store = opts.store;
    this.engine = opts.engine;
    this.runtime = opts.runtime ?? new MockAgentRuntime();
    this.daemon = opts.daemon;
    this.verifiers = opts.verifiers;
    this.completions = opts.completions;
    this.helpers = opts.helpers;
    this.adapterFor = opts.adapterFor ?? ((pipelineId: string) => pipelineId);
    const cap = opts.maxParallelRuns;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(
        `RunScheduler: maxParallelRuns must be a positive integer (got ${String(cap)})`,
      );
    }
    this.maxParallelRuns = cap;
    this.semaphore = new Semaphore(cap);
    this.repo = new WorkItemRepo(this.store);
    // Restart recovery (SPEC §11): reconcile rows left by a crashed/restarted
    // scheduler (fire-and-forget; serialized on the write queue ahead of any
    // createRun).
    this.recoverStaleRuns();
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  /**
   * Insert a `runs` row (status `queued`) and start it as soon as a slot
   * frees (immediately when `maxParallelRuns` has room). Resolves with the
   * new run's id.
   */
  async createRun(spec: RunSpec): Promise<string> {
    this.assertOpen();
    this.validateSpec(spec);
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.enqueue(() =>
      this.store.execute(
        `INSERT INTO runs
           (id, pipeline, adapter, model, selector, status, pause_requested,
            budget_micro_usd, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
        [
          id,
          spec.pipeline,
          this.adapterFor(spec.pipeline),
          spec.model,
          // SPEC §6 persistence: the run scope is folded into the stored
          // selector (targetIds → filter.ids, unitIds → filter.unit) so a
          // restarted run keeps its scope (applyScope with no scope is a no-op).
          JSON.stringify(applyScope(spec.selector ?? {}, spec.scope)),
          spec.budgetMicroUsd ?? null,
          now,
        ],
      ),
    );
    this.specs.set(id, spec);
    this.queued.push(id);
    this.emit("run-created", id);
    this.pump();
    return id;
  }

  /**
   * Request a cooperative pause: set `pause_requested = 1`. A queued run
   * parks at the gate (status `paused`, never starts); a running run keeps
   * running until it yields at its next agent-step boundary (see header).
   */
  async pause(id: string): Promise<void> {
    this.assertOpen();
    const record = await this.getRun(id);
    if (record === null) throw new Error(`pause: no such run "${id}"`);
    if (this.isTerminal(record.status)) return; // done/failed/cancelled: nothing to pause
    this.pauseRequested.add(id);
    await this.enqueue(() =>
      this.store.execute("UPDATE runs SET pause_requested = 1 WHERE id = ?", [id]),
    );
    if (record.status === "queued") {
      // Park the run at the gate rather than letting it start. Guarded on
      // status so a run that started between the read and this write is not
      // clobbered — its checkpoint will observe the pause instead.
      await this.enqueue(() =>
        this.store.execute(
          "UPDATE runs SET status = 'paused' WHERE id = ? AND status = 'queued'",
          [id],
        ),
      );
      this.emit("run-paused", id);
    }
  }

  /**
   * Clear `pause_requested` and resume. A paused run re-acquires a semaphore
   * slot and continues at the boundary where it yielded; a queued run parked
   * by {@link pause} becomes startable again.
   */
  async resume(id: string): Promise<void> {
    this.assertOpen();
    const record = await this.getRun(id);
    if (record === null) throw new Error(`resume: no such run "${id}"`);
    this.pauseRequested.delete(id);
    await this.enqueue(() =>
      this.store.execute("UPDATE runs SET pause_requested = 0 WHERE id = ?", [id]),
    );
    const release = this.resumeWaiters.get(id);
    if (release !== undefined) {
      // The run yielded at a step boundary: wake it; it re-acquires a slot.
      this.resumeWaiters.delete(id);
      release();
      this.emit("run-resumed", id);
    } else if (record.status === "paused") {
      // Either a queued run parked by pause() (still in the queue), or a
      // restart-recovered paused run with NO live execution (SPEC §11):
      // recreate the spec from the stored row if needed and make it
      // startable again — resume() recreates the execution.
      if (!this.specs.has(id)) this.specs.set(id, specFromRecord(record));
      if (!this.queued.includes(id)) this.queued.push(id);
      await this.enqueue(() =>
        this.store.execute(
          "UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'paused'",
          [id],
        ),
      );
      this.emit("run-resumed", id);
      this.pump();
    }
    // Running but pause was requested before a boundary: the flag is now
    // cleared, so the run never yields. No state change.
  }

  /**
   * Cancel a run: move the row to `cancelled` (terminal) and stop workers
   * cooperatively — queued runs never start, paused runs stop at once, and a
   * running run's in-flight agent turn completes before it aborts at the
   * next step boundary.
   */
  async cancel(id: string): Promise<void> {
    this.assertOpen();
    const record = await this.getRun(id);
    if (record === null) throw new Error(`cancel: no such run "${id}"`);
    if (this.isTerminal(record.status)) return;
    this.cancelled.add(id);
    await this.enqueue(() =>
      this.store.execute(
        "UPDATE runs SET status = 'cancelled', pause_requested = 0 WHERE id = ?",
        [id],
      ),
    );
    // Queued: never started — just drop it from the pump's queue.
    const qi = this.queued.indexOf(id);
    if (qi >= 0) this.queued.splice(qi, 1);
    // Paused: wake the execution so it observes the cancellation and stops.
    const release = this.resumeWaiters.get(id);
    if (release !== undefined) {
      this.resumeWaiters.delete(id);
      release();
    }
    this.emit("run-cancelled", id);
  }

  /** Fetch one run by id, or null when absent. */
  getRun(id: string): Promise<RunRecord | null> {
    return this.enqueue(() =>
      this.store
        .query<RunRow>(
          `SELECT id, pipeline, model, status, budget_micro_usd, created_at,
                  started_at, finished_at, selector
           FROM runs WHERE id = ?`,
          [id],
        )
        .then((rows) => {
          const row = rows[0];
          return row === undefined ? null : rowToRunRecord(row);
        }),
    );
  }

  /** All runs, oldest first (insert order). */
  listRuns(): Promise<RunRecord[]> {
    return this.enqueue(() =>
      this.store
        .query<RunRow>(
          `SELECT id, pipeline, model, status, budget_micro_usd, created_at,
                  started_at, finished_at, selector
           FROM runs ORDER BY created_at, id`,
        )
        .then((rows) => rows.map(rowToRunRecord)),
    );
  }

  /**
   * Stop the scheduler: reject new work, cancel every non-terminal run
   * (queued runs immediately; running/paused runs finish their in-flight
   * agent turn and stop at the next step boundary), and resolve once all
   * in-flight executions have settled. Idempotent. The store stays open
   * (host-owned). Reads still work after close.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      const now = new Date().toISOString();
      // Queued runs never start.
      for (const id of this.queued.splice(0)) {
        this.cancelled.add(id);
        this.pauseRequested.delete(id);
        this.specs.delete(id);
        await this.enqueue(() =>
          this.store.execute(
            "UPDATE runs SET status = 'cancelled', pause_requested = 0 WHERE id = ?",
            [id],
          ),
        );
      }
      // In-flight executions (running, paused, or re-acquiring a slot):
      // flag them cancelled; their next checkpoint aborts them. finished_at
      // is written by the execution when it actually stops.
      for (const id of [...this.executions.keys()]) {
        this.cancelled.add(id);
        await this.enqueue(() =>
          this.store.execute(
            `UPDATE runs SET status = 'cancelled', pause_requested = 0
             WHERE id = ? AND status NOT IN ('done', 'failed')`,
            [id],
          ),
        );
      }
      // Paused executions wait on a resume waiter: wake them so they observe
      // the cancellation and stop instead of waiting forever.
      for (const [, release] of this.resumeWaiters) release();
      this.resumeWaiters.clear();
      // A resumed run re-acquiring a slot waits on the semaphore: wake it
      // (no slot granted); it aborts on the closed check.
      this.semaphore.close();
    }
    await Promise.allSettled([...this.executions.values()]);
  }

  // -------------------------------------------------------------------------
  // scheduling core
  // -------------------------------------------------------------------------

  /**
   * Start queued runs while slots are free (FIFO among startable runs; a
   * pause-requested queued run is skipped, not blocking the queue).
   */
  private pump(): void {
    if (this.closed) return;
    while (this.queued.length > 0) {
      const idx = this.queued.findIndex((id) => !this.shouldPause(id));
      if (idx === -1) return; // every queued run is pause-requested
      if (!this.semaphore.tryAcquire()) return; // no free slot: wait for a release
      const id = this.queued.splice(idx, 1)[0]!;
      this.slotOwners.add(id);
      const execution = this.executeRun(id);
      this.executions.set(id, execution);
      // executeRun never rejects (its own catch is exhaustive); keep the
      // chain live regardless.
      execution.catch(() => undefined);
    }
  }

  /**
   * Execute one run: mark it running, run the pipeline under
   * `runPipelineWithBudget` with the run's model/budget and a pause/cancel
   * aware runtime, then finalize the row (`done` / `failed` / leave
   * `cancelled`). Always releases its semaphore slot in the end.
   */
  private async executeRun(id: string): Promise<void> {
    const spec = this.specs.get(id)!;
    // Audit actor for the completion row (SPEC §16): the token that created
    // the run (reserved cost is recorded at create; the ACTUAL metered cost
    // lands here). Direct scheduler use has no actor — fall back to a fixed
    // label so the NOT NULL column still counts toward the global cap.
    const actor = spec.actor ?? "scheduler";
    // Actual metered cost from the run's BudgetTracker (always metered, even
    // without a cap — see runPipelineWithBudget).
    let spentMicroUsd = 0;
    try {
      await this.markRunning(id);
      this.emit("run-start", id);
      // Cancellation can land between pump() and the first agent step.
      await this.checkpoint(id);
      const outcome = await runPipelineWithBudget(this.engine, spec.pipeline, {
        runtime: this.pauseAwareRuntime(id),
        defaultModel: spec.model,
        ...(spec.budgetMicroUsd !== undefined
          ? { budgetMicroUsd: spec.budgetMicroUsd }
          : {}),
        verifiers: this.verifiers ?? {},
        ...(this.completions !== undefined ? { completions: this.completions } : {}),
        ...(this.helpers !== undefined ? { helpers: this.helpers } : {}),
        // SPEC §6: intersect the run scope at the store level — every plan/
        // select selector is AND-ed with the scope's target/unit allowlists
        // (a restarted run carries the scope in its folded `runs.selector`).
        select: (selector: Selector) => this.repo.list(applyScope(selector, spec.scope)),
        onBudgetSpent: (spent) => {
          spentMicroUsd = spent;
        },
      });
      void outcome;
      if (this.cancelled.has(id) || this.closed) {
        // Cancellation won (e.g. close()): leave the row's terminal status.
        await this.finishAborted(id);
        await this.writeCompletionAudit(id, actor, spentMicroUsd, "run-cancelled");
        return;
      }
      this.pauseRequested.delete(id);
      await this.enqueue(() =>
        this.store.execute(
          `UPDATE runs SET status = 'done', pause_requested = 0, finished_at = ?
           WHERE id = ? AND status != 'cancelled'`,
          [new Date().toISOString(), id],
        ),
      );
      this.emit("run-done", id);
      await this.writeCompletionAudit(id, actor, spentMicroUsd, "run-complete");
    } catch (err) {
      if (err instanceof RunAbortedError || this.cancelled.has(id) || this.closed) {
        // Aborted by cancel()/close(): the row is already terminal; record
        // when the execution actually stopped and the spend so far.
        await this.finishAborted(id);
        await this.writeCompletionAudit(id, actor, spentMicroUsd, "run-cancelled");
        return;
      }
      this.pauseRequested.delete(id);
      await this.enqueue(() =>
        this.store
          .execute(
            `UPDATE runs SET status = 'failed', pause_requested = 0, finished_at = ?
             WHERE id = ? AND status != 'cancelled'`,
            [new Date().toISOString(), id],
          )
          .catch(() => undefined),
      );
      this.emit("run-failed", id);
      await this.writeCompletionAudit(id, actor, spentMicroUsd, "run-failed");
    } finally {
      this.executions.delete(id);
      this.cancelled.delete(id);
      this.pauseRequested.delete(id);
      this.specs.delete(id);
      if (this.slotOwners.delete(id)) this.semaphore.release();
      this.pump();
    }
  }

  /**
   * Cooperative stop/yield point between agent steps (see header): abort on
   * cancel/close; yield into {@link pauseAndWait} when a pause is requested.
   */
  private async checkpoint(id: string): Promise<void> {
    if (this.cancelled.has(id) || this.closed) {
      throw new RunAbortedError(id, "cancelled");
    }
    if (this.shouldPause(id)) {
      await this.pauseAndWait(id);
      // Cancel/close may have landed while we waited (or re-acquired).
      if (this.cancelled.has(id) || this.closed) {
        throw new RunAbortedError(id, "cancelled");
      }
    }
  }

  /** True while `pause_requested` is set for the run (mirror of the row). */
  private shouldPause(id: string): boolean {
    return this.pauseRequested.has(id);
  }

  /**
   * A run yields at a step boundary: mark itself `paused`, FREE its
   * semaphore slot (queued runs may start), and wait for resume(). On resume
   * it re-acquires a slot and marks itself `running` again (preserving the
   * original `started_at`). Cancel/close while paused resolve the wait; the
   * run then aborts at the checkpoint. The resume waiter is registered FIRST
   * so a resume racing the yield can never miss it.
   *
   * M4 cancel/close race fix: after the semaphore re-acquire, cancel/close
   * may have landed while we waited (or the semaphore may have closed
   * without granting). Re-check BEFORE taking the slot or marking the run
   * `running` — a terminal row must never flip back to `running`.
   */
  private async pauseAndWait(id: string): Promise<void> {
    let release!: () => void;
    const waiter = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.resumeWaiters.get(id);
    if (prior !== undefined) {
      // Defensive: never leave a stale waiter (a previously released one).
      this.resumeWaiters.delete(id);
      prior();
    }
    this.resumeWaiters.set(id, release);
    if (this.cancelled.has(id) || this.closed) {
      this.resumeWaiters.delete(id);
      return; // cancelled while registering: the checkpoint aborts
    }
    await this.enqueue(() =>
      this.store.execute(
        "UPDATE runs SET status = 'paused' WHERE id = ? AND status = 'running'",
        [id],
      ),
    );
    this.emit("run-paused", id);
    this.slotOwners.delete(id);
    this.semaphore.release();
    this.pump(); // a freed slot may start a queued run
    await waiter;
    if (this.closed || this.cancelled.has(id)) {
      return; // stopped while paused; no slot to re-acquire
    }
    const granted = await this.semaphore.acquire();
    if (!granted || this.closed || this.cancelled.has(id)) {
      // Cancel/close landed while we waited for a slot (or the semaphore
      // closed without granting): abort WITHOUT slotOwners.add/markRunning.
      if (granted) this.semaphore.release(); // a slot we never owned
      return;
    }
    this.slotOwners.add(id);
    await this.markRunning(id);
  }

  /**
   * Wrap the run's runtime so every agent-step boundary (session creation
   * and each prompt turn) runs {@link checkpoint}: this is the cooperative
   * pause/cancel hook between agent steps (SPEC §11, M4).
   */
  private pauseAwareRuntime(id: string): AgentRuntime {
    const base = this.runtime;
    return {
      resolveModel: (name) => base.resolveModel(name),
      createSession: async (opts) => {
        await this.checkpoint(id);
        const session = await base.createSession(opts);
        return {
          prompt: async (text) => {
            await this.checkpoint(id);
            return session.prompt(text);
          },
        };
      },
    };
  }

  /**
   * Mark the run `running`, setting `started_at` only on first start.
   * Guarded on status (M4 cancel/close race fix): a cancel/close that won
   * while the execution waited for a slot can never flip a terminal row
   * (cancelled/done/failed) back to `running`.
   */
  private markRunning(id: string): Promise<void> {
    return this.enqueue(() =>
      this.store
        .execute(
          `UPDATE runs SET status = 'running',
                  started_at = COALESCE(started_at, ?)
           WHERE id = ? AND status NOT IN ('cancelled', 'done', 'failed')`,
          [new Date().toISOString(), id],
        )
        .then(() => undefined),
    );
  }

  /** Record when a cancelled/closed execution actually stopped. */
  private finishAborted(id: string): Promise<void> {
    return this.enqueue(() =>
      this.store
        .execute(
          "UPDATE runs SET finished_at = COALESCE(finished_at, ?) WHERE id = ?",
          [new Date().toISOString(), id],
        )
        .then(() => undefined),
    ).catch(() => undefined);
  }

  /**
   * One `audit_log` row written when a run's execution settles: the ACTUAL
   * metered cost from the BudgetTracker (SPEC §16 — spend caps measure
   * spend, not the reserved budget recorded at create). Written on the
   * scheduler's own write queue (single-writer safety); a failed audit write
   * must never corrupt run state.
   */
  private writeCompletionAudit(
    id: string,
    actor: string,
    spentMicroUsd: number,
    action: "run-complete" | "run-failed" | "run-cancelled",
  ): Promise<void> {
    return this.enqueue(() =>
      this.store.execute(
        `INSERT INTO audit_log (id, ts, actor, action, run_id, cost_micro_usd, data)
         VALUES (?, ?, ?, ?, ?, ?, '{}')`,
        [randomUUID(), new Date().toISOString(), actor, action, id, spentMicroUsd],
      ),
    )
      .then(() => undefined)
      .catch(() => undefined);
  }

  /**
   * Restart recovery (SPEC §11): a crashed scheduler leaves `runs` rows with
   * status `running` but no live execution in THIS process. Re-pause them so
   * the operator can `resume()` (which recreates the execution); stale
   * `queued` rows are re-enqueued with their specs reconstructed from the
   * stored row, so they start as slots free. Runs the recovery once at
   * construction, serialized on the write queue ahead of any createRun — a
   * fresh run can never be double-enqueued.
   */
  private recoverStaleRuns(): void {
    // ONE atomic op on the write queue: the UPDATE + SELECT run together,
    // ahead of any createRun's INSERT, so a fresh run can never be
    // double-enqueued (a chained .then() would let a concurrent createRun
    // slip its row between the recovery steps and get queued twice).
    this.enqueue(async () => {
      await this.store.execute("UPDATE runs SET status = 'paused' WHERE status = 'running'", []);
      const rows = await this.store.query<RunRow>(
        `SELECT id, pipeline, model, status, budget_micro_usd, created_at,
                started_at, finished_at, selector
         FROM runs WHERE status = 'queued'`,
      );
      for (const row of rows) {
        const record = rowToRunRecord(row);
        this.specs.set(record.id, specFromRecord(record));
        this.queued.push(record.id);
      }
      this.pump();
    }).catch(() => undefined); // a startup hiccup must never crash construction
  }

  // -------------------------------------------------------------------------
  // store plumbing
  // -------------------------------------------------------------------------

  /**
   * Serialize one write behind the queue tail. A failed write rejects its own
   * caller but leaves the chain intact for the writes queued behind it.
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(op);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Lifecycle event → the daemon's serialized event path when one is present
   * (SPEC §18); otherwise a no-op. Fire-and-forget: a failed emit (e.g. the
   * daemon closed) must never crash the run or the scheduler.
   */
  private emit(type: string, runId: string): void {
    if (this.daemon === undefined) return;
    this.daemon
      .emit({ ts: new Date().toISOString(), runId, type, data: {} })
      .catch(() => undefined);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("run scheduler: closed");
  }

  private isTerminal(status: RunStatus): boolean {
    return status === "done" || status === "failed" || status === "cancelled";
  }

  private validateSpec(spec: RunSpec): void {
    if (typeof spec.pipeline !== "string" || spec.pipeline.length === 0) {
      throw new Error("createRun: spec.pipeline must be a non-empty string");
    }
    if (typeof spec.model !== "string" || spec.model.length === 0) {
      throw new Error("createRun: spec.model must be a non-empty string");
    }
    if (
      spec.budgetMicroUsd !== undefined &&
      (!Number.isFinite(spec.budgetMicroUsd) || spec.budgetMicroUsd < 0)
    ) {
      throw new Error(
        `createRun: budgetMicroUsd must be a non-negative number (got ${String(spec.budgetMicroUsd)})`,
      );
    }
  }
}
