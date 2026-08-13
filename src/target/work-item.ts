/**
 * `WorkItem` persistence over `SqlAdapter`: snake_case DB columns (§6.2) ↔
 * camelCase `WorkItem` (§8). `insert`/`get`/`update` are direct statements;
 * `list` delegates to the compiled selector (SQL push-down + meta post-filter,
 * see `selector.ts`).
 */
import type { SqlAdapter } from "../core/store/adapter.js";
import type { Selector, WorkItem } from "../types.js";
import { select, type WorkItemRow } from "./selector.js";

/** camelCase `WorkItem` field → snake_case `work_items` column. */
const FIELD_COLUMNS: Readonly<Record<string, string>> = {
  id: "id",
  kind: "kind",
  unitId: "unit_id",
  lifecycle: "lifecycle",
  status: "status",
  region: "region",
  symbol: "symbol",
  address: "address",
  milestone: "milestone",
  requiredLevel: "required_level",
  size: "size",
  source: "source",
  attempts: "attempts",
  exhausted: "exhausted",
  ready: "ready",
  meta: "meta",
};

function nowIso(): string {
  return new Date().toISOString();
}

/** undefined → NULL so optional fields bind cleanly on every engine. */
function toParam(value: unknown): unknown {
  return value === undefined ? null : value;
}

function metaToJson(meta: Record<string, unknown> | undefined): string {
  return JSON.stringify(meta ?? {});
}

function itemToRow(item: WorkItem, updatedAt: string): WorkItemRow {
  return {
    id: item.id,
    kind: item.kind,
    unit_id: toParam(item.unitId),
    lifecycle: item.lifecycle,
    status: item.status,
    region: toParam(item.region),
    symbol: toParam(item.symbol),
    address: toParam(item.address),
    milestone: toParam(item.milestone),
    required_level: toParam(item.requiredLevel),
    size: toParam(item.size),
    source: toParam(item.source),
    attempts: item.attempts ?? 0,
    exhausted: item.exhausted ? 1 : 0,
    ready: item.ready ? 1 : 0,
    meta: metaToJson(item.meta),
    updated_at: updatedAt,
  };
}

function parseMeta(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (raw !== null && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

/** Map a raw snake_case `work_items` row → camelCase `WorkItem`. */
export function rowToWorkItem(row: WorkItemRow): WorkItem {
  const str = (v: unknown): string | undefined =>
    v === null || v === undefined ? undefined : String(v);
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined) return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isNaN(n) ? undefined : n;
  };
  return {
    id: str(row["id"]) ?? "",
    kind: str(row["kind"]) ?? "",
    unitId: str(row["unit_id"]),
    lifecycle: str(row["lifecycle"]) ?? "",
    status: str(row["status"]) ?? "",
    region: str(row["region"]),
    symbol: str(row["symbol"]),
    address: str(row["address"]),
    milestone: str(row["milestone"]),
    requiredLevel: str(row["required_level"]),
    size: num(row["size"]),
    source: str(row["source"]),
    attempts: num(row["attempts"]) ?? 0,
    exhausted: Boolean(row["exhausted"]),
    ready: Boolean(row["ready"]),
    meta: parseMeta(row["meta"]),
  };
}

export class WorkItemRepo {
  constructor(private readonly adapter: SqlAdapter) {}

  /** Insert a work item. Throws on duplicate `id` (PK violation). */
  async insert(item: WorkItem): Promise<void> {
    const row = itemToRow(item, nowIso());
    const columns = Object.keys(row);
    const sql = `INSERT INTO work_items (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")})`;
    await this.adapter.execute(sql, columns.map((c) => row[c]));
  }

  /** Fetch a work item by id, or `undefined` when absent. */
  async get(id: string): Promise<WorkItem | undefined> {
    const rows = await this.adapter.query<WorkItemRow>(
      "SELECT * FROM work_items WHERE id = ?",
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToWorkItem(row);
  }

  /** Select work items via a compiled `Selector` (SQL + meta post-filter + limit). */
  async list(selector: Selector): Promise<WorkItem[]> {
    const rows = await select(this.adapter, selector);
    return rows.map(rowToWorkItem);
  }

  /**
   * Update the provided fields of a work item; always bumps `updated_at`.
   * Returns the number of affected rows (0 when `id` is absent).
   */
  async update(id: string, patch: Partial<WorkItem>): Promise<number> {
    if (patch.id !== undefined) {
      throw new Error('cannot update immutable field "id" (primary key)');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [field, column] of Object.entries(FIELD_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      if (field === "meta") params.push(metaToJson(value as Record<string, unknown>));
      else if (field === "exhausted" || field === "ready") params.push(value ? 1 : 0);
      else params.push(toParam(value));
    }
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    const result = await this.adapter.execute(
      `UPDATE work_items SET ${sets.join(", ")} WHERE id = ?`,
      params,
    );
    return result.changes;
  }
}
