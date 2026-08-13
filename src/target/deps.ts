/**
 * Queryable graph edges over `SqlAdapter` (SPEC §6.2): the `work_item_deps`
 * table (kinds `depends_on | calls | unresolved_calls | abi_helper`) and the
 * `work_item_capabilities` table. Both reference `work_items.id` verbatim —
 * ids are the join key for deps, ledger counts, and asm data, so no id is
 * ever regenerated here (SPEC §6.4).
 *
 * `addDep` / `addCapability` are idempotent via `insertIgnore` (the PK is
 * the full edge/capability, so a duplicate add is a no-op, not a throw);
 * `removeDep` reports the number of rows actually deleted.
 */
import type { SqlAdapter } from "../core/store/adapter.js";

/** Edge kinds (`work_item_deps.kind`, SPEC §6.2). */
export const DEP_KINDS = ["depends_on", "calls", "unresolved_calls", "abi_helper"] as const;

export type DepKind = (typeof DEP_KINDS)[number];

/** A `work_item_deps` edge (camelCase). */
export interface DepEdge {
  fromId: string;
  toId: string;
  kind: DepKind;
}

/** A `work_item_capabilities` row. */
export interface Capability {
  workItemId: string;
  capability: string;
}

export class DepsStore {
  constructor(private readonly adapter: SqlAdapter) {}

  /**
   * Add a dep edge. Idempotent: returns false when the edge already exists
   * (PK `(from_id, to_id, kind)`), true when inserted.
   */
  async addDep(fromId: string, toId: string, kind: DepKind): Promise<boolean> {
    return this.adapter.insertIgnore(
      "INSERT INTO work_item_deps (from_id, to_id, kind) VALUES (?, ?, ?)",
      [fromId, toId, kind],
    );
  }

  /** Remove a dep edge; returns the number of rows deleted (0 when absent). */
  async removeDep(fromId: string, toId: string, kind: DepKind): Promise<number> {
    const result = await this.adapter.execute(
      "DELETE FROM work_item_deps WHERE from_id = ? AND to_id = ? AND kind = ?",
      [fromId, toId, kind],
    );
    return result.changes;
  }

  /** All edges leaving `fromId`, ordered deterministically (to_id, kind). */
  async listDeps(fromId: string): Promise<DepEdge[]> {
    const rows = await this.adapter.query<{ from_id: string; to_id: string; kind: string }>(
      "SELECT from_id, to_id, kind FROM work_item_deps WHERE from_id = ? ORDER BY to_id, kind",
      [fromId],
    );
    return rows.map((row) => ({
      fromId: row.from_id,
      toId: row.to_id,
      kind: row.kind as DepKind,
    }));
  }

  /** All edges pointing at `toId`, ordered deterministically (from_id, kind). */
  async listDependents(toId: string): Promise<DepEdge[]> {
    const rows = await this.adapter.query<{ from_id: string; to_id: string; kind: string }>(
      "SELECT from_id, to_id, kind FROM work_item_deps WHERE to_id = ? ORDER BY from_id, kind",
      [toId],
    );
    return rows.map((row) => ({
      fromId: row.from_id,
      toId: row.to_id,
      kind: row.kind as DepKind,
    }));
  }

  /**
   * Add a capability to a work item. Idempotent: returns false when the pair
   * already exists (PK `(work_item_id, capability)`), true when inserted.
   */
  async addCapability(workItemId: string, capability: string): Promise<boolean> {
    return this.adapter.insertIgnore(
      "INSERT INTO work_item_capabilities (work_item_id, capability) VALUES (?, ?)",
      [workItemId, capability],
    );
  }

  /** Capabilities of `workItemId`, sorted alphabetically. */
  async listCapabilities(workItemId: string): Promise<string[]> {
    const rows = await this.adapter.query<{ capability: string }>(
      "SELECT capability FROM work_item_capabilities WHERE work_item_id = ? ORDER BY capability",
      [workItemId],
    );
    return rows.map((row) => row.capability);
  }
}
