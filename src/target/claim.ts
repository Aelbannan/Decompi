/**
 * Lease claims (SPEC §6.3): `ClaimStore` over the portable `SqlAdapter`.
 *
 * A claim is a heartbeat-refreshed lease on a `work_items` row, keyed by the
 * `claims` PK (`work_item_id`). Ownership is `owner + epoch`:
 * - `owner = "<run_id>:<worker_seq>"` — never a PID (v1's PID-reuse bug).
 * - `epoch` = daemon-start UUID — the PID-reuse guard: after a daemon restart
 *   the old generation's epoch no longer matches, so `heartbeat`/`release`
 *   refuse to touch the stale row and a re-claim by the new generation fails.
 *
 * `claim()` is a portable CAS: `insertIgnore` on the PK (false if already
 * held); a re-claim by the *same* owner+epoch re-arms a live lease via a
 * guarded UPDATE that ALSO extends `expires_at` and refreshes
 * `allowed_paths` (a re-claim of an expired or swept row returns false —
 * the two-active-workers guard). `reapExpired()` sweeps `expires_at < now`
 * rows (daemon timer + run cancel/pause/fail — SPEC §6.3). Claims are
 * ephemeral and never git-exported; durable assignment lives in `work_items`.
 *
 * Owners are validated as `"<run_id>:<worker_seq>"` (`run_id` without a
 * colon, `worker_seq` all digits); a malformed owner is rejected up front
 * rather than silently deriving garbage `run_id`/`worker_seq` columns.
 *
 * Timestamps are ISO-8601 UTC TEXT (same format as the adapter's contract);
 * lexicographic comparison is chronological, so `expires_at < ?` is correct.
 */
import type { SqlAdapter } from "../core/store/adapter.js";

/** The store's SQL surface: query + execute + the CAS insert primitive. */
type ClaimSql = Pick<SqlAdapter, "query" | "execute" | "insertIgnore">;

/** A decoded `claims` row: camelCase, `allowed_paths` parsed from JSON. */
export interface ClaimRow {
  workItemId: string;
  /** `"<run_id>:<worker_seq>"` — never a PID. */
  owner: string;
  runId: string | null;
  workerSeq: number | null;
  /** Decoded `allowed_paths` JSON array. */
  allowedPaths: string[];
  /** Daemon-start UUID (PID-reuse guard). */
  epoch: string;
  claimedAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

/** Input to `ClaimStore.claim` (SPEC §6.3 lease model). */
export interface ClaimRequest {
  workItemId: string;
  /** `"<run_id>:<worker_seq>"` — never a PID. */
  owner: string;
  /** Stored in `claims.run_id`; derived from `owner` when omitted. */
  runId?: string;
  /** Stored in `claims.worker_seq`; derived from `owner` when omitted. */
  workerSeq?: number;
  /** Write-scope allowlist for the worker, serialized as a JSON array. */
  allowedPaths?: string[];
  /** Daemon-start UUID (PID-reuse guard). */
  epoch: string;
  /** Lease duration in milliseconds; `expires_at = now + ttlMs`. */
  ttlMs: number;
}

export interface ClaimStoreOptions {
  /** Clock override for deterministic tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

const CLAIM_COLUMNS =
  "(work_item_id, owner, run_id, worker_seq, allowed_paths, epoch, claimed_at, expires_at, heartbeat_at)";

const INSERT_CLAIM_SQL = `INSERT INTO claims ${CLAIM_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Split `"<run_id>:<worker_seq>"` back into its parts (last colon wins). */
function parseOwner(owner: string): { runId: string | null; workerSeq: number | null } {
  const idx = owner.lastIndexOf(":");
  if (idx < 0) return { runId: owner, workerSeq: null };
  const seqStr = owner.slice(idx + 1);
  return {
    runId: owner.slice(0, idx),
    workerSeq: /^\d+$/.test(seqStr) ? Number(seqStr) : null,
  };
}

/**
 * Valid owner format (SPEC §6.3): `"<run_id>:<worker_seq>"` — the run id
 * must not contain a colon and the worker seq must be all digits (never a
 * PID; a PID string like `1234` would otherwise parse as a "run id").
 */
const OWNER_PATTERN = /^[^:]+:\d+$/;

/** A raw `claims` row as stored: snake_case keys, `allowed_paths` still TEXT. */
interface ClaimRowRaw {
  work_item_id: string;
  owner: string;
  run_id: string | null;
  worker_seq: number | null;
  allowed_paths: string;
  epoch: string;
  claimed_at: string;
  expires_at: string;
  heartbeat_at: string;
}

/** Defensive parse of the `allowed_paths` TEXT column; junk degrades to []. */
function parseAllowedPaths(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

function decodeClaimRow(row: ClaimRowRaw): ClaimRow {
  return {
    workItemId: row.work_item_id,
    owner: row.owner,
    runId: row.run_id,
    workerSeq: row.worker_seq,
    allowedPaths: parseAllowedPaths(row.allowed_paths),
    epoch: row.epoch,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
  };
}

/**
 * Lease claim store over the portable `SqlAdapter` (SPEC §6.3). Claims are
 * one row per `work_items` row; ownership is `owner + epoch`; every mutating
 * operation is guarded by those two values.
 */
export class ClaimStore {
  constructor(
    private readonly sql: ClaimSql,
    private readonly opts: ClaimStoreOptions = {},
  ) {}

  private isoNow(): string {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }

  /**
   * Atomic CAS claim on the `claims` PK (SPEC §6.3).
   *
   * - No row yet: `insertIgnore` succeeds → true (claimed).
   * - Row held by a different owner **or a different epoch**: false.
   * - Row held by the SAME owner+epoch with a **live** lease: a guarded
   *   UPDATE re-arms it (extends `expires_at`, bumps `heartbeat_at`, and
   *   refreshes `allowed_paths`) → true. A re-claim of an *expired* or
   *   already-*swept* row is refused (false) — the lease is dead, so the
   *   worker must not keep going (two-active-workers guard) and the reaper
   *   will free the item.
   *
   * When the claim carries a `runId` with no `runs` row, the run is created
   * idempotently (INSERT OR IGNORE) so the `claims.run_id` FK never trips a
   * FOREIGN KEY violation on a brand-new run.
   */
  async claim(item: ClaimRequest): Promise<boolean> {
    if (!OWNER_PATTERN.test(item.owner)) {
      throw new Error(
        `invalid claim owner ${JSON.stringify(item.owner)}: expected "<run_id>:<worker_seq>"` +
          " (run id without a colon, digits after the colon)",
      );
    }
    const now = this.isoNow();
    const expiresAt = new Date(new Date(now).getTime() + item.ttlMs).toISOString();
    const parts = parseOwner(item.owner);
    const runId = item.runId ?? parts.runId;
    const allowedPathsJson = JSON.stringify(item.allowedPaths ?? []);
    // `claims.run_id` is FK'd to `runs`; create the run row idempotently so
    // a claim under a brand-new run id never throws FOREIGN KEY.
    if (runId !== null) {
      await this.sql.insertIgnore(
        "INSERT INTO runs (id, pipeline, adapter, model, status, selector, config, created_at) VALUES (?, '', '', '', 'running', '{}', '{}', ?)",
        [runId, now],
      );
    }
    const params: unknown[] = [
      item.workItemId,
      item.owner,
      runId,
      item.workerSeq ?? parts.workerSeq,
      allowedPathsJson,
      item.epoch,
      now,
      expiresAt,
      now,
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.sql.insertIgnore(INSERT_CLAIM_SQL, params)) return true;
      // PK conflict: the item is (or was) held. Re-claim by the same
      // owner+epoch re-arms a LIVE lease; an expired or foreign row is
      // refused (the UPDATE matches nothing), so a re-claim can never
      // resurrect a dead lease or silently return true without extending it.
      const result = await this.sql.execute(
        "UPDATE claims SET expires_at = ?, heartbeat_at = ?, allowed_paths = ? " +
          "WHERE work_item_id = ? AND owner = ? AND epoch = ? AND expires_at > ?",
        [expiresAt, now, allowedPathsJson, item.workItemId, item.owner, item.epoch, now],
      );
      if (result.changes > 0) return true;
      // Released/reaped between the failed insert and this update: retry the
      // insert (bounded).
    }
    return false;
  }

  /**
   * Extend the lease expiry (`expires_at = now + ttlMs`) and bump
   * `heartbeat_at`, but only when the row is still held by the matching
   * owner+epoch. Returns false (no change) otherwise.
   */
  async heartbeat(workItemId: string, owner: string, epoch: string, ttlMs: number): Promise<boolean> {
    const now = this.isoNow();
    const expiresAt = new Date(new Date(now).getTime() + ttlMs).toISOString();
    const result = await this.sql.execute(
      "UPDATE claims SET expires_at = ?, heartbeat_at = ? WHERE work_item_id = ? AND owner = ? AND epoch = ?",
      [expiresAt, now, workItemId, owner, epoch],
    );
    return result.changes > 0;
  }

  /**
   * Delete the claim row, but only when it is still held by the matching
   * owner+epoch (a stale-epoch row from a previous daemon generation is left
   * untouched for the reaper). Returns false if nothing matched.
   */
  async release(workItemId: string, owner: string, epoch: string): Promise<boolean> {
    const result = await this.sql.execute(
      "DELETE FROM claims WHERE work_item_id = ? AND owner = ? AND epoch = ?",
      [workItemId, owner, epoch],
    );
    return result.changes > 0;
  }

  /**
   * Sweep expired leases: delete every row with `expires_at < now`
   * (ISO-8601 UTC, same format as the stored values). Returns the count
   * deleted. Continuously reaped by the daemon, not just at start (SPEC
   * §6.3).
   */
  async reapExpired(now: string): Promise<number> {
    const result = await this.sql.execute("DELETE FROM claims WHERE expires_at < ?", [now]);
    return result.changes;
  }

  /** All claims currently held by `owner` (decoded rows). */
  async findByOwner(owner: string): Promise<ClaimRow[]> {
    const rows = await this.sql.query<ClaimRowRaw>(
      "SELECT * FROM claims WHERE owner = ?",
      [owner],
    );
    return rows.map(decodeClaimRow);
  }

  /** All claims whose `run_id` matches (decoded rows). */
  async findByRunId(runId: string): Promise<ClaimRow[]> {
    const rows = await this.sql.query<ClaimRowRaw>(
      "SELECT * FROM claims WHERE run_id = ?",
      [runId],
    );
    return rows.map(decodeClaimRow);
  }
}
