/**
 * Workflow status store (SPEC §A.2–§A.4): per-workflow status rows over
 * `workflow_status`, written through the portable `SqlAdapter`
 * (`?` placeholders, ISO-8601 TEXT timestamps). Replaces the boolean
 * `WorkflowCompletionStore` (v0) with the status ladder.
 *
 * Row forms (resolve-then-test, SPEC §A.3):
 *   (wf, U, '')  unit-scoped    — every target of unit U carries this status
 *   (wf, '', T)  target-scoped  — target T carries this status
 *   (wf, U, T)   precise        — target T of unit U (run-time finalize)
 *
 * `setStatus` UPSERTs on the UNIQUE (workflow_id, unit_id, target_id) key —
 * re-setting a scope's status replaces the row instead of stacking. Reading
 * is resolve-then-test, never an OR: the most-specific row wins
 * (precise > target-scoped > unit-scoped), so a LINTED unit can never hide a
 * re-broken target (SPEC §A.3).
 */
import type { SqlAdapter } from "../core/store/adapter.js";

/** A `workflow_status` row in camelCase form. `''` unit/target = scoped. */
export interface WorkflowStatusRow {
  workflowId: string;
  unitId: string; // '' when target-scoped
  targetId: string; // '' when unit-scoped
  status: string;
  updatedAt: string;
  actor: string; // token id, "manual", or run_id
  reason: string | null;
}

export interface SetStatusParams {
  workflowId: string;
  /** Unit-scoped status (`(wf, U, '')`) when targetId is absent. */
  unitId?: string;
  /** Target-scoped status (`(wf, '', T)`) when unitId is absent. */
  targetId?: string;
  status: string;
  actor: string;
  reason?: string;
}

export interface UnsetStatusParams {
  workflowId: string;
  unitId?: string;
  targetId?: string;
}

const COLUMNS = "workflow_id, unit_id, target_id, status, updated_at, actor, reason";

interface StatusRow {
  workflow_id: string;
  unit_id: string;
  target_id: string;
  status: string;
  updated_at: string;
  actor: string;
  reason: string | null;
}

function mapRow(row: StatusRow): WorkflowStatusRow {
  return {
    workflowId: row.workflow_id,
    unitId: row.unit_id,
    targetId: row.target_id,
    status: row.status,
    updatedAt: row.updated_at,
    actor: row.actor,
    reason: row.reason,
  };
}

export class WorkflowStatusStore {
  constructor(private readonly sql: SqlAdapter) {}

  /**
   * UPSERT one status row on the UNIQUE (workflow_id, unit_id, target_id)
   * key (SPEC §A.2): insert when absent, overwrite status/actor/reason and
   * bump `updated_at` when present. The insert path goes through the
   * adapter's portable `insertIgnore` (a unique conflict = update, not an
   * error), so the same code runs on any `SqlAdapter`.
   */
  async setStatus({
    workflowId,
    unitId = "",
    targetId = "",
    status,
    actor,
    reason,
  }: SetStatusParams): Promise<void> {
    const ts = new Date().toISOString();
    const inserted = await this.sql.insertIgnore(
      `INSERT INTO workflow_status (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workflowId, unitId, targetId, status, ts, actor, reason ?? null],
    );
    if (inserted) return;
    await this.sql.execute(
      `UPDATE workflow_status
       SET status = ?, updated_at = ?, actor = ?, reason = ?
       WHERE workflow_id = ? AND unit_id = ? AND target_id = ?`,
      [status, ts, actor, reason ?? null, workflowId, unitId, targetId],
    );
  }

  /**
   * Resolve-then-test (SPEC §A.3), never an OR: probe the three exact
   * `(workflow, unit, target)` rows in specificity order —
   *
   *   row (wf, unit=target.unit, target=target.id)   // precise
   *   else row (wf, unit='',          target=target.id) // target-scoped
   *   else row (wf, unit=target.unit, target='')      // unit-scoped
   *
   * — and return the FIRST hit's status, or null when no row applies.
   */
  async resolveStatus(
    workflowId: string,
    target: { id: string; unitId?: string },
  ): Promise<string | null> {
    const unit = target.unitId ?? "";
    const probes: ReadonlyArray<readonly [string, string]> = [
      [unit, target.id],
      ["", target.id],
      [unit, ""],
    ];
    for (const [probeUnit, probeTarget] of probes) {
      const rows = await this.sql.query<{ status: string }>(
        `SELECT status FROM workflow_status
         WHERE workflow_id = ? AND unit_id = ? AND target_id = ?
         LIMIT 1`,
        [workflowId, probeUnit, probeTarget],
      );
      if (rows.length > 0) return rows[0]!.status;
    }
    return null;
  }

  /**
   * True when the target's RESOLVED status is one of `doneStatuses`
   * (SPEC §A.3): `isDone(wf, target) = resolveStatus(wf, target)?.status
   * ∈ doneStatuses`. The plan subtracts these from selection.
   */
  async isDone(
    workflowId: string,
    target: { id: string; unitId?: string },
    doneStatuses: readonly string[],
  ): Promise<boolean> {
    const status = await this.resolveStatus(workflowId, target);
    return status !== null && doneStatuses.includes(status);
  }

  /**
   * Delete matching rows, returning the number removed (the CLI/API
   * "reset/clear" path).
   * - `targetId` given → target-scoped: `workflow_id=? AND target_id=?`
   *   **regardless of unit** (removes both `(wf, '', T)` and `(wf, U, T)`).
   * - else `unitId` given → unit-scoped: `workflow_id=? AND unit_id=?`
   *   (removes both `(wf, U, '')` and `(wf, U, T)`).
   * - neither given → all status rows for the workflow.
   */
  async unsetStatus({ workflowId, unitId, targetId }: UnsetStatusParams): Promise<number> {
    if (targetId !== undefined) {
      const { changes } = await this.sql.execute(
        "DELETE FROM workflow_status WHERE workflow_id = ? AND target_id = ?",
        [workflowId, targetId],
      );
      return changes;
    }
    if (unitId !== undefined) {
      const { changes } = await this.sql.execute(
        "DELETE FROM workflow_status WHERE workflow_id = ? AND unit_id = ?",
        [workflowId, unitId],
      );
      return changes;
    }
    const { changes } = await this.sql.execute(
      "DELETE FROM workflow_status WHERE workflow_id = ?",
      [workflowId],
    );
    return changes;
  }

  /** All status rows for a workflow, oldest-update first. */
  async list(workflowId: string): Promise<WorkflowStatusRow[]> {
    const rows = await this.sql.query<StatusRow>(
      `SELECT ${COLUMNS} FROM workflow_status WHERE workflow_id = ?
       ORDER BY updated_at, workflow_id, unit_id, target_id`,
      [workflowId],
    );
    return rows.map(mapRow);
  }
}
