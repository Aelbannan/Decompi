/**
 * Core domain types (SPEC §8): `WorkItem` (camelCase, promoted columns as
 * fields, everything else in `meta`) and `Selector` (declarative filter /
 * sort / limit compiled to SQL by `src/target/selector.ts`).
 */

/** A single app-side meta post-filter (`Selector.filter.meta` entry). */
export interface MetaOp {
  key: string;
  op: "eq" | "neq" | "in" | "contains" | "regex";
  value: unknown;
}

/** A unit of work: a function, object, or label to be matched/cleaned. */
export interface WorkItem {
  id: string;
  kind: string; // function | object | label | adapter vocab
  unitId?: string;
  lifecycle: string; // core-owned (pending|claimed|active|verified|accepted|rejected|…)
  status: string; // adapter status vocab (NOT_STARTED…FULL_MATCH)
  region?: string;
  symbol?: string;
  address?: string;
  milestone?: string;
  requiredLevel?: string;
  size?: number;
  source?: string;
  attempts: number; // materialized (ledger-derived)
  exhausted: boolean; // materialized (1 = dead-end reached)
  ready: boolean; // materialized (call-graph resolved)
  meta: Record<string, unknown>; // unindexed blobs only (TEXT-encoded JSON)
}

/** Declarative selection over promoted `work_items` columns. */
export interface Selector {
  filter?: {
    status?: string[];
    lifecycle?: string[];
    kind?: string[];
    /** Explicit target-id allowlist (SPEC §6 run scope; ANDs with the rest). */
    ids?: string[];
    unit?: string[];
    region?: string[];
    symbol?: string; // promoted column
    address?: string; // promoted column
    milestone?: string[];
    requiredLevel?: string[];
    ready?: boolean;
    exhausted?: boolean;
    attempts?: { min?: number; max?: number };
    size?: { min?: number; max?: number };
    /** App-side post-filters (not pushed into portable SQL). */
    meta?: MetaOp[];
  };
  /** Whitelisted sort fields (SPEC §8): size | attempts | unit | region | updated_at. */
  sort?: { by: "size" | "attempts" | "unit" | "region" | "updated_at"; dir: "asc" | "desc" }[];
  limit?: number;
}

/** Model directory thinking levels (SPEC §14; validated against `models` table / models.json). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Outcome of a verifier run (SPEC §9). `flags` are soft signals, never a reject. */
export interface Verdict {
  accepted: boolean;
  status?: string;
  evidence: Record<string, unknown>;
  flags?: string[];
  feedback?: string;
}

/** A predicate that decides whether a WorkItem is accepted; sets status + evidence (SPEC §9). */
export interface Verifier<Ctx = unknown> {
  id: string;
  verify(item: WorkItem, ctx: Ctx): Promise<Verdict>;
}

/** Per-model cost table (SPEC §14), per million tokens. */
export interface ModelCost {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

/** A named model preset from `models.json` (SPEC §14). */
export interface ModelSpec {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  maxTokens: number;
  rpm: number;
  cost: ModelCost;
}
