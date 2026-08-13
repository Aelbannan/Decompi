/**
 * Selector → SQL compilation against the `work_items` table (snake_case
 * columns, SPEC §6.2).
 *
 * Promoted filter fields compile to `WHERE`, whitelisted sort fields compile
 * to `ORDER BY`, and `selector.limit` compiles to `LIMIT`. `filter.meta` is an
 * explicit **app-side post-filter** (SPEC §8): it is returned as `metaFilters`
 * and applied by {@link applyMetaFilters} after SQL selection, never pushed
 * into portable SQL (no JSON operators — SPEC §3.2).
 *
 * Over-fetch semantics (SPEC §8): when `filter.meta` and `limit` are combined,
 * `compileSelector` emits `LIMIT limit × OVER_FETCH_FACTOR`; {@link select}
 * additionally paginates (page size = limit × factor) until `limit` matching
 * rows are collected or the table is exhausted, so a matching item is never
 * silently dropped below `limit`.
 */
import type { SqlAdapter } from "../core/store/adapter.js";
import type { MetaOp, Selector } from "../types.js";

/** Compiled output of {@link compileSelector}. */
export interface CompiledSelector {
  /** Parameterized SELECT against `work_items` (`?` placeholders only). */
  sql: string;
  /** Positional parameters for `sql`, in order. */
  params: unknown[];
  /** App-side post-filters (from `selector.filter.meta`), applied after SQL selection. */
  metaFilters: MetaOp[];
}

/**
 * A raw `work_items` row: snake_case keys, `meta` still the raw TEXT column.
 * Consumers (repo mapping, {@link applyMetaFilters}) parse it defensively.
 */
export type WorkItemRow = Record<string, unknown>;

/** Over-fetch multiplier applied to `LIMIT` when meta filters combine with a limit (SPEC §8). */
export const OVER_FETCH_FACTOR = 10;

/** Whitelisted sort fields → snake_case columns (SPEC §8; kimi B-M5). */
const SORT_COLUMNS: Readonly<Record<string, string>> = {
  size: "size",
  attempts: "attempts",
  unit: "unit_id",
  region: "region",
  updated_at: "updated_at",
};

const SORT_DIRS: ReadonlySet<string> = new Set(["asc", "desc"]);

const META_OPS: ReadonlySet<string> = new Set(["eq", "neq", "in", "contains", "regex"]);

/** Filter fields that must be arrays of strings (IN filters). */
const ARRAY_FILTER_FIELDS = [
  "status",
  "lifecycle",
  "kind",
  "unit",
  "region",
  "milestone",
  "requiredLevel",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(path: string, detail: string): never {
  throw new Error(`invalid selector: ${path} ${detail}`);
}

/**
 * Shape-validate an untrusted `Selector` (e.g. parsed CLI JSON) and throw a
 * clear error on anything that would crash the SQL compiler or silently
 * produce wrong results. Rejects:
 * - string/object `filter` list fields instead of arrays of strings;
 * - non-positive / non-integer / NaN `limit` (SQLite treats a negative LIMIT
 *   as "unlimited");
 * - non-whitelisted `sort[].by` or a `dir` other than asc|desc;
 * - `filter.meta[].op` outside eq|neq|in|contains|regex (never silently
 *   filter everything out);
 * - non-number `attempts`/`size` range bounds.
 */
export function validateSelector(input: unknown): Selector {
  if (!isPlainObject(input)) throw new Error("invalid selector: expected a JSON object");
  const sel = input as Record<string, unknown>;

  if (sel.filter !== undefined) {
    if (!isPlainObject(sel.filter)) invalid("filter", "must be an object");
    const filter = sel.filter;
    for (const field of ARRAY_FILTER_FIELDS) {
      const value = filter[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        invalid(`filter.${field}`, `must be an array of strings (got ${typeof value})`);
      }
      for (const element of value) {
        if (typeof element !== "string") {
          invalid(`filter.${field}`, `must be an array of strings (got ${typeof element} element)`);
        }
      }
    }
    for (const field of ["symbol", "address"] as const) {
      const value = filter[field];
      if (value !== undefined && typeof value !== "string") {
        invalid(`filter.${field}`, `must be a string (got ${typeof value})`);
      }
    }
    for (const field of ["ready", "exhausted"] as const) {
      const value = filter[field];
      if (value !== undefined && typeof value !== "boolean") {
        invalid(`filter.${field}`, `must be a boolean (got ${typeof value})`);
      }
    }
    for (const field of ["attempts", "size"] as const) {
      const value = filter[field];
      if (value === undefined) continue;
      if (!isPlainObject(value)) {
        invalid(`filter.${field}`, "must be an object with optional min/max numbers");
      }
      for (const bound of ["min", "max"] as const) {
        const b = value[bound];
        if (b !== undefined && (typeof b !== "number" || !Number.isFinite(b))) {
          invalid(`filter.${field}.${bound}`, `must be a number (got ${String(b)})`);
        }
      }
    }
    if (filter.meta !== undefined) {
      if (!Array.isArray(filter.meta)) invalid("filter.meta", "must be an array of meta ops");
      filter.meta.forEach((op, index) => {
        if (!isPlainObject(op)) invalid(`filter.meta[${index}]`, "must be an object with key/op/value");
        if (typeof op.key !== "string") {
          invalid(`filter.meta[${index}].key`, `must be a string (got ${typeof op.key})`);
        }
        if (typeof op.op !== "string" || !META_OPS.has(op.op)) {
          invalid(
            `filter.meta[${index}].op`,
            `must be one of eq|neq|in|contains|regex (got ${JSON.stringify(op.op)})`,
          );
        }
        if (!("value" in op)) invalid(`filter.meta[${index}].value`, "is required");
      });
    }
  }

  if (sel.sort !== undefined) {
    if (!Array.isArray(sel.sort)) invalid("sort", "must be an array");
    sel.sort.forEach((s, index) => {
      if (!isPlainObject(s)) invalid(`sort[${index}]`, "must be an object with by/dir");
      if (typeof s.by !== "string" || !(s.by in SORT_COLUMNS)) {
        throw new Error(`Invalid sort field: ${String(s.by)}`);
      }
      if (s.dir !== "asc" && s.dir !== "desc") {
        throw new Error(`Invalid sort direction: ${String(s.dir)}`);
      }
    });
  }

  if (sel.limit !== undefined) {
    const limit = sel.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      invalid("limit", `must be a positive integer (got ${String(limit)})`);
    }
  }

  return sel as unknown as Selector;
}

interface Clause {
  sql: string;
  params: unknown[];
}

function inClause(column: string, values: string[]): Clause | null {
  if (values.length === 0) return null; // empty IN () is invalid SQL
  return {
    sql: `${column} IN (${values.map(() => "?").join(", ")})`,
    params: [...values],
  };
}

function eqClause(column: string, value: string): Clause {
  return { sql: `${column} = ?`, params: [value] };
}

function boolClause(column: string, value: boolean): Clause {
  return { sql: `${column} = ?`, params: [value ? 1 : 0] };
}

function rangeClause(column: string, range: { min?: number; max?: number }): Clause | null {
  const parts: string[] = [];
  const params: number[] = [];
  if (range.min !== undefined) {
    parts.push(`${column} >= ?`);
    params.push(range.min);
  }
  if (range.max !== undefined) {
    parts.push(`${column} <= ?`);
    params.push(range.max);
  }
  if (parts.length === 0) return null;
  return { sql: parts.join(" AND "), params };
}
interface SqlOptions {
  limit?: number;
  offset?: number;
}

/** Build the parameterized statement for `selector` with an explicit LIMIT/OFFSET. */
function buildSelectorSql(selector: Selector, opts: SqlOptions = {}): CompiledSelector {
  const where: string[] = [];
  const params: unknown[] = [];
  const metaFilters: MetaOp[] = [];
  const filter = selector.filter;

  if (filter) {
    const inFilters: Array<[string, string[]]> = [
      ["status", filter.status ?? []],
      ["lifecycle", filter.lifecycle ?? []],
      ["kind", filter.kind ?? []],
      ["unit_id", filter.unit ?? []],
      ["region", filter.region ?? []],
      ["milestone", filter.milestone ?? []],
      ["required_level", filter.requiredLevel ?? []],
    ];
    for (const [column, values] of inFilters) {
      const clause = inClause(column, values);
      if (clause) {
        where.push(clause.sql);
        params.push(...clause.params);
      }
    }
    if (filter.symbol !== undefined) {
      const clause = eqClause("symbol", filter.symbol);
      where.push(clause.sql);
      params.push(...clause.params);
    }
    if (filter.address !== undefined) {
      const clause = eqClause("address", filter.address);
      where.push(clause.sql);
      params.push(...clause.params);
    }
    if (filter.ready !== undefined) {
      const clause = boolClause("ready", filter.ready);
      where.push(clause.sql);
      params.push(...clause.params);
    }
    if (filter.exhausted !== undefined) {
      const clause = boolClause("exhausted", filter.exhausted);
      where.push(clause.sql);
      params.push(...clause.params);
    }
    if (filter.attempts !== undefined) {
      const clause = rangeClause("attempts", filter.attempts);
      if (clause) {
        where.push(clause.sql);
        params.push(...clause.params);
      }
    }
    if (filter.size !== undefined) {
      const clause = rangeClause("size", filter.size);
      if (clause) {
        where.push(clause.sql);
        params.push(...clause.params);
      }
    }
    if (filter.meta !== undefined) metaFilters.push(...filter.meta);
  }

  const order: string[] = [];
  for (const sort of selector.sort ?? []) {
    const column = SORT_COLUMNS[sort.by];
    if (column === undefined) throw new Error(`Invalid sort field: ${sort.by}`);
    if (!SORT_DIRS.has(sort.dir)) throw new Error(`Invalid sort direction: ${sort.dir}`);
    order.push(`${column} ${sort.dir.toUpperCase()}`);
  }

  let sql = "SELECT * FROM work_items";
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  // Paging (LIMIT, and OFFSET steps) must have a unique ORDER BY or rows can
  // be dropped/duplicated across pages when sort keys tie. `id` (PK) is the
  // deterministic final tiebreaker whenever a LIMIT is emitted.
  if (opts.limit !== undefined) {
    const fullOrder = order.length > 0 ? [...order, "id ASC"] : ["id ASC"];
    sql += ` ORDER BY ${fullOrder.join(", ")}`;
    sql += " LIMIT ?";
    params.push(opts.limit);
    if (opts.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(opts.offset);
    }
  } else if (order.length > 0) {
    sql += ` ORDER BY ${order.join(", ")}`;
  }
  return { sql, params, metaFilters };
}

/**
 * Compile a `Selector` into parameterized SQL against `work_items`.
 * When `filter.meta` and `limit` are combined the emitted `LIMIT` is
 * `limit × OVER_FETCH_FACTOR` (over-fetch), per SPEC §8.
 */
export function compileSelector(selector: Selector): CompiledSelector {
  validateSelector(selector);
  const hasMeta = (selector.filter?.meta?.length ?? 0) > 0;
  let limit: number | undefined;
  if (selector.limit !== undefined) {
    limit = hasMeta ? selector.limit * OVER_FETCH_FACTOR : selector.limit;
  }
  return buildSelectorSql(selector, { limit });
}

/** Read the `meta` bag off a row, parsing the raw TEXT column when needed. */
function readMeta(row: WorkItemRow): Record<string, unknown> {
  const raw = row["meta"];
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

/** Resolve a (possibly dotted) meta key. */
function metaValue(bag: Record<string, unknown>, key: string): unknown {
  let current: unknown = bag;
  for (const part of key.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchMetaOp(bag: Record<string, unknown>, op: MetaOp): boolean {
  const actual = metaValue(bag, op.key);
  const expected = op.value;
  switch (op.op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected; // missing key counts as "not equal"
    case "in":
      if (!Array.isArray(expected)) return false;
      return expected.includes(actual);
    case "contains":
      if (actual === undefined) return false;
      if (Array.isArray(actual)) return actual.includes(expected);
      return String(actual).includes(String(expected));
    case "regex":
      if (actual === undefined) return false;
      try {
        return new RegExp(String(expected)).test(String(actual));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** App-side post-filter: keep rows whose `meta` satisfies every op. */
export function applyMetaFilters<T extends WorkItemRow>(rows: T[], metaFilters: MetaOp[]): T[] {
  if (metaFilters.length === 0) return rows;
  return rows.filter((row) => metaFilters.every((op) => matchMetaOp(readMeta(row), op)));
}

/**
 * Run SQL selection + meta post-filter + limit.
 *
 * - No meta filters: SQL `LIMIT` is authoritative; rows are sliced to `limit`.
 * - Meta filters without limit: one query, then post-filter.
 * - Meta filters with limit: `compileSelector` over-fetches, and if the first
 *   page's post-filtered result is short of `limit`, further pages are fetched
 *   (OFFSET stepping) until `limit` matches are collected or rows run out —
 *   `limit` is never undershot while matching rows remain.
 */
export async function select(
  adapter: Pick<SqlAdapter, "query">,
  selector: Selector,
): Promise<WorkItemRow[]> {
  const { sql, params, metaFilters } = compileSelector(selector);
  const limit = selector.limit;

  if (metaFilters.length === 0) {
    const rows = await adapter.query<WorkItemRow>(sql, params);
    return limit === undefined ? rows : rows.slice(0, limit);
  }
  if (limit === undefined) {
    const rows = await adapter.query<WorkItemRow>(sql, params);
    return applyMetaFilters(rows, metaFilters);
  }

  const pageSize = limit * OVER_FETCH_FACTOR;
  const collected: WorkItemRow[] = [];
  let offset = 0;
  for (;;) {
    const page = buildSelectorSql(selector, { limit: pageSize, offset });
    const rows = await adapter.query<WorkItemRow>(page.sql, page.params);
    if (rows.length === 0) break;
    collected.push(...applyMetaFilters(rows, metaFilters));
    if (collected.length >= limit) break;
    offset += pageSize;
  }
  return collected.slice(0, limit);
}
