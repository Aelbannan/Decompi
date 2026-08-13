/**
 * M2 event store (SPEC §6.2, §18).
 *
 * The store is the single writer for the `events` table: `emit` is the sole
 * seq assigner. Emits are **micro-batched** (§18: bounded queue, batched
 * writes, backpressure, never drop): events collect for ≤ `flushDelayMs` or
 * ≤ `batchSize` events, then ONE transaction increments `counters.next` by
 * K and inserts K rows with `seq = base+1..base+K` — so a burst produces
 * fewer transactions than emits and seqs stay gap-free. The counter
 * increment and the inserts commit together, so a failed batch rolls the
 * counter back with it.
 *
 * The pending queue is bounded at `maxPending`; beyond that, producers
 * block (backpressure — awaiters wait for a flush to free room) instead of
 * growing unboundedly. Nothing is ever dropped: awaiting `emit` resolves
 * only once the event's seq is committed.
 */
import type { SqlAdapter } from "./store/adapter.js";

/** `counters` row backing `events.seq` (SPEC §6.2). */
export const EVENTS_SEQ_COUNTER = "events.seq";

/** Event severity vocab (schema.sql `events.level`). */
export type EventLevel = "debug" | "info" | "warn" | "error";

/** Input accepted by `emit`. `data` is a JSON-serializable object. */
export interface EmitEvent {
  /** ISO-8601 timestamp, TEXT per §6.1. */
  ts: string;
  runId?: string;
  workItemId?: string;
  type: string;
  level?: EventLevel;
  data: Record<string, unknown>;
}

/** Micro-batching + backpressure configuration (SPEC §18). */
export interface EventStoreOptions {
  /** Max events flushed per transaction; defaults to 100. */
  batchSize?: number;
  /** Max pending (unflushed) events before producers block; defaults to 10000. */
  maxPending?: number;
  /** Micro-batch window: flush pending events at most this long after the
   * first pending emit; defaults to 10ms. */
  flushDelayMs?: number;
}

/** A materialized event row read back from the store. */
export interface EventRow {
  seq: number;
  ts: string;
  runId?: string;
  workItemId?: string;
  type: string;
  level: EventLevel;
  /** JSON payload parsed back from TEXT. */
  data: Record<string, unknown>;
}

/** Raw snake_case row as stored in the `events` table. */
interface EventRowRow {
  seq: number | bigint;
  ts: string;
  run_id: string | null;
  work_item_id: string | null;
  type: string;
  level: string | null;
  data: string;
}

const SELECT_EVENTS =
  "SELECT seq, ts, run_id, work_item_id, type, level, data FROM events";

/** Parse the TEXT JSON payload; corrupt rows degrade to {} rather than throw. */
function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toEventRow(row: EventRowRow): EventRow {
  return {
    seq: Number(row.seq),
    ts: row.ts,
    runId: row.run_id ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    type: row.type,
    level: (row.level ?? "info") as EventLevel,
    data: parseData(row.data),
  };
}

/** A queued, not-yet-flushed emit plus its completion callbacks. */
interface PendingEvent {
  e: EmitEvent;
  /** Pre-serialized `data` (a batch transaction can never fail on JSON). */
  payload: string;
  resolve: (seq: number) => void;
  reject: (err: unknown) => void;
}

export class EventStore {
  private readonly batchSize: number;
  private readonly maxPending: number;
  private readonly flushDelayMs: number;

  /** Events accepted but not yet flushed (bounded at `maxPending`). */
  private pending: PendingEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** Tail of the flush chain — flush transactions never overlap. */
  private flushTail: Promise<void> = Promise.resolve();
  /** Producers blocked by backpressure, woken when a flush frees room. */
  private roomWaiters: Array<() => void> = [];

  constructor(
    private readonly adapter: SqlAdapter,
    opts: EventStoreOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 100;
    this.maxPending = opts.maxPending ?? 10_000;
    this.flushDelayMs = opts.flushDelayMs ?? 10;
  }

  /**
   * Enqueue one event for the next micro-batch (SPEC §18). Returns a promise
   * that resolves with the event's daemon-assigned `seq` once its batch is
   * committed. Events are collected for ≤ `flushDelayMs` or ≤ `batchSize`
   * events and flushed in one transaction (gap-free, monotonic seqs); the
   * pending queue is capped at `maxPending`, beyond which producers block
   * (backpressure) until a flush frees room — events are never dropped.
   * A failed emit (e.g. a circular `data` payload, rejected eagerly at
   * enqueue) rejects only its own caller and never breaks the queue.
   */
  async emit(e: EmitEvent): Promise<number> {
    // Serialize eagerly so a bad payload rejects only its own emit and can
    // never poison a shared batch flush (in an async fn the throw rejects).
    const payload = JSON.stringify(e.data);
    // Backpressure: wait for a flush to free room before accepting more.
    while (this.pending.length >= this.maxPending) {
      await new Promise<void>((resolve) => this.roomWaiters.push(resolve));
    }
    return new Promise<number>((resolve, reject) => {
      this.pending.push({ e, payload, resolve, reject });
      this.scheduleFlush();
    });
  }

  /** Micro-batch trigger: flush immediately at batch size, else after the window. */
  private scheduleFlush(): void {
    if (this.pending.length >= this.batchSize) {
      // Batch is full: flush now, cancelling any pending window timer (a
      // full batch must never wait out the rest of the window).
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      void this.flushNow();
      return;
    }
    if (this.flushTimer !== null) return; // a flush is already scheduled
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pending.length > 0) void this.flushNow();
    }, this.flushDelayMs);
  }

  /** Serialize flush transactions: each starts only after the previous ends. */
  private flushNow(): Promise<void> {
    const run = this.flushTail.then(() => this.drain());
    this.flushTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Flush up to `batchSize` pending events in one transaction: seed the
   * counter once, increment `next` by K, insert K rows with
   * `seq = base+1..base+K`, resolve each emit with its seq. A failure
   * rejects every emit in the batch; the counter rolls back with it.
   */
  private async drain(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.batchSize);
    // Room freed: let blocked producers proceed (each re-checks the cap).
    if (this.pending.length < this.maxPending) {
      const waiters = this.roomWaiters.splice(0);
      for (const wake of waiters) wake();
    }
    try {
      const firstSeq = await this.adapter.transaction(async (tx) => {
        // Seed the counter row once (insertIgnore is a no-op when present).
        await tx.insertIgnore(
          "INSERT INTO counters (name, next) VALUES (?, ?)",
          [EVENTS_SEQ_COUNTER, 0],
        );
        await tx.execute("UPDATE counters SET next = next + ? WHERE name = ?", [
          batch.length,
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
        const base = Number(next) - batch.length;
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i]!;
          await tx.execute(
            "INSERT INTO events (seq, ts, run_id, work_item_id, type, level, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
              base + i + 1,
              item.e.ts,
              item.e.runId ?? null,
              item.e.workItemId ?? null,
              item.e.type,
              item.e.level ?? "info",
              item.payload,
            ],
          );
        }
        return base + 1;
      });
      batch.forEach((item, i) => item.resolve(firstSeq + i));
    } catch (err) {
      for (const item of batch) item.reject(err);
    }
  }

  /** Events with `seq > seq`, ascending, optionally capped at `limit`. */
  readAfter(seq: number, limit?: number): Promise<EventRow[]> {
    return this.readWhere("WHERE seq > ?", [seq], limit);
  }

  /** Events for a run, ascending, optionally capped at `limit`. */
  readByRun(runId: string, limit?: number): Promise<EventRow[]> {
    return this.readWhere("WHERE run_id = ?", [runId], limit);
  }

  /** Events for a work item, ascending, optionally capped at `limit`. */
  readByWorkItem(workItemId: string, limit?: number): Promise<EventRow[]> {
    return this.readWhere("WHERE work_item_id = ?", [workItemId], limit);
  }

  /** Total number of events. */
  async count(): Promise<number> {
    const rows = await this.adapter.query<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM events",
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async readWhere(
    where: string,
    params: unknown[],
    limit?: number,
  ): Promise<EventRow[]> {
    const sql = `${SELECT_EVENTS} ${where} ORDER BY seq ASC${
      limit !== undefined ? " LIMIT ?" : ""
    }`;
    const rows = await this.adapter.query<EventRowRow>(
      sql,
      limit !== undefined ? [...params, limit] : params,
    );
    return rows.map(toEventRow);
  }
}
