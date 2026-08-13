/**
 * Workflow completion store (SPEC §5): per-workflow manual/run completion
 * rows over `workflow_completions`, written through the portable
 * `SqlAdapter` (`?` placeholders, ISO-8601 TEXT timestamps, ULID/uuid ids).
 *
 * Row forms (SPEC §5.1):
 *   (wf, U, '')  unit-scoped    — every target of unit U is complete
 *   (wf, '', T)  target-scoped  — target T is complete
 *   (wf, U, T)   precise        — target T of unit U (run-time finalize)
 *
 * `isComplete(wf, target)` = row for the target **or** row for the
 * unit-of-target (SPEC §5.1); `uncomplete` deletes by scope so a target-
 * scoped delete reliably removes the precise row written by finalize.
 */
import { randomUUID } from "node:crypto";
import type { SqlAdapter } from "../core/store/adapter.js";

/** A `workflow_completions` row in camelCase form. `''` unit/target = scoped. */
export interface WorkflowCompletionRow {
  id: string;
  workflowId: string;
  unitId: string; // '' when target-scoped
  targetId: string; // '' when unit-scoped
  completedAt: string;
  actor: string; // token id, "manual", or run_id
  reason: string | null;
}

export interface CompleteParams {
  workflowId: string;
  /** Unit-scoped completion (`(wf, U, '')`) when targetId is absent. */
  unitId?: string;
  /** Target-scoped completion (`(wf, '', T)`) when unitId is absent. */
  targetId?: string;
  actor: string;
  reason?: string;
}

export interface UncompleteParams {
  workflowId: string;
  unitId?: string;
  targetId?: string;
}

const COLUMNS = "id, workflow_id, unit_id, target_id, completed_at, actor, reason";

interface CompletionRow {
  id: string;
  workflow_id: string;
  unit_id: string;
  target_id: string;
  completed_at: string;
  actor: string;
  reason: string | null;
}

function mapRow(row: CompletionRow): WorkflowCompletionRow {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    unitId: row.unit_id,
    targetId: row.target_id,
    completedAt: row.completed_at,
    actor: row.actor,
    reason: row.reason,
  };
}

export class WorkflowCompletionStore {
  constructor(private readonly sql: SqlAdapter) {}

  /**
   * Insert-or-ignore a completion row. Returns `false` when the exact
   * `(workflow_id, unit_id, target_id)` row already exists (idempotent —
   * a manual complete racing a run-time finalize does not double-write).
   */
  async complete({
    workflowId,
    unitId = "",
    targetId = "",
    actor,
    reason,
  }: CompleteParams): Promise<boolean> {
    return this.sql.insertIgnore(
      `INSERT INTO workflow_completions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        workflowId,
        unitId,
        targetId,
        new Date().toISOString(),
        actor,
        reason ?? null,
      ],
    );
  }

  /**
   * Delete matching rows, returning the number removed.
   * - `targetId` given → target-scoped: `workflow_id=? AND target_id=?`
   *   **regardless of unit** (removes both `(wf, '', T)` and `(wf, U, T)`).
   * - else `unitId` given → unit-scoped: `workflow_id=? AND unit_id=?`
   *   (removes both `(wf, U, '')` and `(wf, U, T)`).
   * - neither given → all completion rows for the workflow.
   */
  async uncomplete({ workflowId, unitId, targetId }: UncompleteParams): Promise<number> {
    if (targetId !== undefined) {
      const { changes } = await this.sql.execute(
        "DELETE FROM workflow_completions WHERE workflow_id = ? AND target_id = ?",
        [workflowId, targetId],
      );
      return changes;
    }
    if (unitId !== undefined) {
      const { changes } = await this.sql.execute(
        "DELETE FROM workflow_completions WHERE workflow_id = ? AND unit_id = ?",
        [workflowId, unitId],
      );
      return changes;
    }
    const { changes } = await this.sql.execute(
      "DELETE FROM workflow_completions WHERE workflow_id = ?",
      [workflowId],
    );
    return changes;
  }

  /**
   * True when a row exists for the target **or** for its unit
   * (SPEC §5.1): `(wf, target.id, *)` or `(wf, target.unitId, *)`.
   */
  async isComplete(
    workflowId: string,
    target: { id: string; unitId?: string },
  ): Promise<boolean> {
    const clauses = ["target_id = ?"];
    const params: unknown[] = [workflowId, target.id];
    if (target.unitId !== undefined && target.unitId !== "") {
      clauses.push("unit_id = ?");
      params.push(target.unitId);
    }
    const rows = await this.sql.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM workflow_completions WHERE workflow_id = ? AND (${clauses.join(" OR ")})`,
      params,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** All completion rows for a workflow, oldest first. */
  async list(workflowId: string): Promise<WorkflowCompletionRow[]> {
    const rows = await this.sql.query<CompletionRow>(
      `SELECT ${COLUMNS} FROM workflow_completions WHERE workflow_id = ? ORDER BY completed_at, id`,
      [workflowId],
    );
    return rows.map(mapRow);
  }
}
