/**
 * M2 embedded store daemon (SPEC §5, §6.3, §18): the single writer for one
 * store, in-process, no REST/UI (the local socket for subprocess workers
 * lands in M4).
 *
 * Single-writer facade: every mutating call — `claim`, `heartbeat`,
 * `release`, `reapExpired`, `emit`, `importWorkItems`,
 * `finalizeWorkflowItem` — serializes through
 * one promise-chain `writeQueue`, so enqueue order is commit order and
 * `events.seq` assignment (via the EventStore's counters transaction, which
 * is already single-writer-safe) is deterministic and gap-free even under
 * concurrent callers.
 *
 * Epoch (SPEC §6.3): the daemon carries a start UUID (`randomUUID()` by
 * default). `claim`/`heartbeat`/`release` bind every lease to this epoch, so
 * a restarted daemon generation can never touch the previous generation's
 * leases — orphan recovery is the time sweep (`reapExpired`), which frees
 * only rows that are actually expired. `start()` runs that sweep once, then
 * keeps sweeping on a `reapIntervalMs` timer for the life of the daemon
 * (SPEC §6.3: "reap continuously, not just at daemon start"); `close()`
 * stops the timer. `reapNow()` sweeps on demand.
 *
 * Read-after-write consistency: reads (`select`, `readAfter`,
 * `exportRegistry`) also serialize through the write queue, so they never
 * observe an in-flight write's uncommitted state on the shared connection
 * (e.g. a `select` during `importWorkItems` sees the whole registry or
 * none of it, never a partial one).
 *
 * The daemon does NOT own the `SqlAdapter`: the host creates, migrates, and
 * closes it. `close()` only drains the write queue and stops further writes.
 */
import { randomUUID } from "node:crypto";
import type { SqlAdapter } from "./store/adapter.js";
import type { Selector, WorkItem } from "../types.js";
import { ClaimStore, type ClaimRequest } from "../target/claim.js";
import {
  EventStore,
  EVENTS_SEQ_COUNTER,
  type EmitEvent,
  type EventRow,
} from "./events.js";
import { WorkflowStatusStore } from "../workflow/status.js";
import type { CompletionAction } from "../workflow/types.js";
import {
  exportRegistry,
  importRegistry,
  type RegistrySnapshot,
} from "../target/registry.js";
import { WorkItemRepo } from "../target/work-item.js";

/** Claim input for the daemon: `ClaimRequest` minus the daemon-owned `epoch`. */
export type ClaimArgs = Omit<ClaimRequest, "epoch">;

/** Event input for the daemon (see {@link EventStore.emit}). */
export type EmitArgs = EmitEvent;

/**
 * Finalize input for the daemon (SPEC §A.4): the workflow, the target, the
 * actor, the decider's `CompletionAction` (what "complete" means for this
 * target), and the workflow's `completionStatus` (the status written when
 * the action carries none — compiled from `WorkflowDef.completionStatus`,
 * defaulting to the ladder's last status). The daemon is the ONLY writer
 * for this transition — hooks never reach `execute`/`transaction` directly.
 */
export interface FinalizeWorkflowItemInput {
  workflowId: string;
  target: WorkItem;
  actor: string;
  action: CompletionAction;
  /** Default status when `action.status` is absent; defaults to "DONE". */
  completionStatus?: string;
}

export interface StoreDaemonOptions {
  /** Daemon-start UUID (SPEC §6.3); defaults to a fresh `randomUUID()`. */
  epoch?: string;
  /** Continuous reap cadence in ms (SPEC §6.3); defaults to 5000. */
  reapIntervalMs?: number;
}

/** Default reap cadence (SPEC §6.3). */
const DEFAULT_REAP_INTERVAL_MS = 5000;

export class StoreDaemon {
  private readonly claims: ClaimStore;
  private readonly events: EventStore;
  private readonly repo: WorkItemRepo;
  private readonly epoch: string;
  private readonly reapIntervalMs: number;

  /** Tail of the write serialization chain — every write waits on this. */
  private writeTail: Promise<void> = Promise.resolve();

  private started = false;
  private closed = false;
  private reapTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly adapter: SqlAdapter,
    opts: StoreDaemonOptions = {},
  ) {
    this.epoch = opts.epoch ?? randomUUID();
    this.reapIntervalMs = opts.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    this.claims = new ClaimStore(adapter);
    this.events = new EventStore(adapter);
    this.repo = new WorkItemRepo(adapter);
  }

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

  /** Reject (never throw) when the daemon has been closed: no further writes. */
  private closedError<T>(): Promise<T> {
    return Promise.reject(new Error("store daemon: closed"));
  }

  /**
   * CAS claim (SPEC §6.3) under this daemon's `epoch`. True when the item
   * was free, or is already held by the same owner+epoch with a live lease
   * (re-arms the lease: extends expiry and refreshes `allowed_paths`);
   * false when held by anyone else — a different owner, a different daemon
   * generation, or an expired lease awaiting the reaper.
   */
  claim(args: ClaimArgs): Promise<boolean> {
    if (this.closed) return this.closedError();
    return this.enqueue(() => this.claims.claim({ ...args, epoch: this.epoch }));
  }

  /**
   * Extend the lease expiry (`expires_at = now + ttlMs`) and bump
   * `heartbeat_at`, but only while the row is still held by `owner` under
   * this daemon's `epoch`. Returns false (no change) otherwise.
   */
  heartbeat(workItemId: string, owner: string, ttlMs: number): Promise<boolean> {
    if (this.closed) return this.closedError();
    return this.enqueue(() =>
      this.claims.heartbeat(workItemId, owner, this.epoch, ttlMs),
    );
  }

  /**
   * Delete the lease, but only while it is still held by `owner` under this
   * daemon's `epoch` (a stale-epoch row from a previous daemon generation is
   * left for the reaper). Returns false if nothing matched.
   */
  release(workItemId: string, owner: string): Promise<boolean> {
    if (this.closed) return this.closedError();
    return this.enqueue(() => this.claims.release(workItemId, owner, this.epoch));
  }

  /**
   * Sweep expired leases (`expires_at < now`, ISO-8601 UTC; SPEC §6.3).
   * `now` is epoch milliseconds; defaults to the wall clock. Runs on the
   * write queue, so the sweep never interleaves with a claim/heartbeat in
   * flight. Returns the number of rows deleted.
   */
  reapExpired(now?: number): Promise<number> {
    if (this.closed) return this.closedError();
    const iso = new Date(now ?? Date.now()).toISOString();
    return this.enqueue(() => this.claims.reapExpired(iso));
  }

  /**
   * Append an event and return its daemon-assigned `seq` (SPEC §18). The
   * EventStore's counters transaction is already single-writer-safe; routing
   * through the daemon queue makes enqueue order == seq order airtight.
   */
  emit(e: EmitArgs): Promise<number> {
    if (this.closed) return this.closedError();
    return this.enqueue(() => this.events.emit(e));
  }

  /**
   * Finalize one workflow item (SPEC §A.4): the single writer for run-time
   * workflow status. ONE transaction writes, in order:
   *
   *   1. the precise status row `(wf, unit-of-target, target)` — an UPSERT
   *      on the UNIQUE key (SPEC §A.2), with status = `action.status ??
   *      input.completionStatus ?? "DONE"`; re-finalizing a target REPLACES
   *      its status rather than stacking a row;
   *   2. the `CompletionAction` write on `work_items`: `promote:true` sets
   *      `lifecycle='accepted'` and `status` (COALESCE keeps the current
   *      status when none is given); `{status}` alone sets only status;
   *      `promote:false` with no status skips the work_items write entirely;
   *   3. a `target-status` event row, appended in the SAME transaction via
   *      the events counter (the same seq source `EventStore.emit` uses, so
   *      seqs stay gap-free even alongside micro-batched emits), emitted
   *      ONLY on a status CHANGE — the old status is resolved before the
   *      upsert and compared to the new one; a same-status re-finalize
   *      writes the row but never a duplicate event. The row, the item
   *      write, and the event commit or roll back together.
   */
  finalizeWorkflowItem(input: FinalizeWorkflowItemInput): Promise<void> {
    if (this.closed) return this.closedError();
    return this.enqueue(() =>
      this.adapter.transaction(async (tx) => {
        const ts = new Date().toISOString();
        const { workflowId, target, actor, action } = input;
        const unitId = target.unitId ?? "";
        const actionStatus = "status" in action ? action.status : undefined;
        // Default status: the action's status, else the workflow's
        // completionStatus (threaded from the compiled def), else "DONE"
        // (the ladder default, SPEC §A.1).
        const status = actionStatus ?? input.completionStatus ?? "DONE";

        // 1. Precise status row (SPEC §A.2), resolved BEFORE the upsert so
        //    the event below knows whether the status actually changed.
        const statuses = new WorkflowStatusStore(tx);
        const previous = await statuses.resolveStatus(workflowId, {
          id: target.id,
          unitId,
        });
        await statuses.setStatus({
          workflowId,
          unitId,
          targetId: target.id,
          status,
          actor,
          reason: "run-time",
        });

        // 2. The CompletionAction write (SPEC §A.4).
        const promote = "promote" in action && action.promote === true;
        if (promote) {
          await tx.execute(
            "UPDATE work_items SET lifecycle = 'accepted', status = COALESCE(?, status), updated_at = ? WHERE id = ?",
            [actionStatus ?? null, ts, target.id],
          );
        } else if (actionStatus !== undefined) {
          await tx.execute(
            "UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?",
            [actionStatus, ts, target.id],
          );
        }
        // { promote: false } without a status: no work_items write at all.

        // 3. `target-status` event, same transaction, ONLY on a status
        //    change (from → to); a same-status re-finalize never emits.
        if (previous !== status) {
          // Seq from the events counter — the same source EventStore.emit
          // drains, so seqs stay gap-free across both write paths.
          await tx.insertIgnore(
            "INSERT INTO counters (name, next) VALUES (?, ?)",
            [EVENTS_SEQ_COUNTER, 0],
          );
          await tx.execute("UPDATE counters SET next = next + 1 WHERE name = ?", [
            EVENTS_SEQ_COUNTER,
          ]);
          const rows = await tx.query<{ next: number | bigint }>(
            "SELECT next FROM counters WHERE name = ?",
            [EVENTS_SEQ_COUNTER],
          );
          const next = rows[0]?.next;
          if (next === undefined) {
            throw new Error(
              `event store: counter ${EVENTS_SEQ_COUNTER} missing after increment`,
            );
          }
          const payload: Record<string, unknown> = {
            workflowId,
            actor,
            from: previous ?? null,
            updatedAt: ts,
            status,
          };
          if ("evidence" in action && action.evidence !== undefined) {
            payload.evidence = action.evidence;
          }
          // Serialized here (inside the transaction): an unserializable
          // payload (e.g. a circular `evidence`) aborts and rolls back the
          // row + item write with it — atomic, never a half-finalize.
          await tx.execute(
            "INSERT INTO events (seq, ts, run_id, work_item_id, type, level, data) VALUES (?, ?, NULL, ?, 'target-status', 'info', ?)",
            [Number(next), ts, target.id, JSON.stringify(payload)],
          );
        }
      }),
    );
  }

  /** Select work items via the compiled selector (SQL push-down + meta post-filter). */
  select(selector: Selector): Promise<WorkItem[]> {
    return this.enqueue(() => this.repo.list(selector));
  }

  /** Events with `seq > seq`, ascending, optionally capped at `limit`. */
  readAfter(seq: number, limit?: number): Promise<EventRow[]> {
    return this.enqueue(() => this.events.readAfter(seq, limit));
  }

  /**
   * Import work items atomically (one transaction, via the registry importer):
   * a duplicate `id` throws and rolls the whole batch back — nothing partial
   * is ever persisted. Resolves with the number of items inserted.
   */
  importWorkItems(items: WorkItem[]): Promise<number> {
    if (this.closed) return this.closedError();
    return this.enqueue(() =>
      importRegistry(this.adapter, { workItems: items, deps: [], capabilities: [] }).then(
        (result) => result.inserted,
      ),
    );
  }

  /**
   * Export a consistent registry snapshot (SPEC §6.3, §15). The three reads
   * (work items + deps + capabilities) run inside one transaction, so a
   * concurrent write can never tear the snapshot; routing through the write
   * queue additionally guarantees the snapshot reflects every already-queued
   * write (read-after-write consistency).
   */
  exportRegistry(): Promise<RegistrySnapshot> {
    return this.enqueue(() => this.adapter.transaction((tx) => exportRegistry(tx)));
  }

  /**
   * On-start orphan recovery, then continuous reap (SPEC §6.3): sweep
   * expired leases once at start, then every `reapIntervalMs` for the life
   * of the daemon (timer cleared by {@link close}). Idempotent — a second
   * call is a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reapExpired();
    this.reapTimer = setInterval(() => {
      // Fire-and-forget: a sweep failure (e.g. the adapter was closed under
      // us) must never crash the process; the next tick retries.
      this.reapExpired().catch(() => undefined);
    }, this.reapIntervalMs);
    // In-process daemon: the timer must not keep the host process alive.
    this.reapTimer.unref();
  }

  /** Sweep expired leases on demand (alias of {@link reapExpired}). */
  reapNow(): Promise<number> {
    return this.reapExpired();
  }

  /**
   * Stop the daemon: stop the reap timer, reject further writes, and wait
   * for already-queued writes to drain. The adapter stays open (host-owned).
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reapTimer !== null) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    await this.writeTail;
  }
}
