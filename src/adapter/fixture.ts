/**
 * FixtureAdapter — a `GameAdapter` whose `importWorkItems` loads work items
 * from a JSON file (or an in-memory array) and inserts them through
 * `WorkItemRepo`.
 *
 * File shape: `{ "workItems": [ { id, kind, status, ...WorkItem fields } ] }`
 * (a bare array is accepted too). Missing optional fields are defaulted
 * leniently: `attempts`→0, `exhausted`→false, `ready`→false,
 * `lifecycle`→"pending", `meta`→{}. `id`/`kind`/`status` are required and
 * validated with a clear error.
 */
import { readFileSync } from "node:fs";
import type {
  AdapterCtx,
  GameAdapter,
  LintRule,
  PlaceholderPatterns,
  StatusVocab,
} from "./types.js";
import type { Verdict, WorkItem } from "../types.js";
import { WorkItemRepo } from "../target/work-item.js";

/** Fixture entries: `id`/`kind`/`status` required; everything else may default. */
export type FixtureWorkItem = Partial<WorkItem> & Pick<WorkItem, "id" | "kind" | "status">;

type FixtureSource =
  | { kind: "file"; path: string }
  | { kind: "array"; items: FixtureWorkItem[] };

/** Lenient defaults for optional WorkItem fields (module doc). */
const DEFAULTS = {
  attempts: 0,
  exhausted: false,
  ready: false,
  lifecycle: "pending",
} as const;

function normalizeFixture(raw: FixtureWorkItem): WorkItem {
  return {
    id: raw.id,
    kind: raw.kind,
    lifecycle: raw.lifecycle ?? DEFAULTS.lifecycle,
    status: raw.status,
    unitId: raw.unitId,
    region: raw.region,
    symbol: raw.symbol,
    address: raw.address,
    milestone: raw.milestone,
    requiredLevel: raw.requiredLevel,
    size: raw.size,
    source: raw.source,
    attempts: raw.attempts ?? DEFAULTS.attempts,
    exhausted: raw.exhausted ?? DEFAULTS.exhausted,
    ready: raw.ready ?? DEFAULTS.ready,
    // Fresh object per item: DEFAULTS.meta must never be shared/mutated.
    meta: raw.meta ?? {},
  };
}

function requireString(raw: FixtureWorkItem, index: number, field: "id" | "kind" | "status"): void {
  const value = raw[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `fixture workItems[${index}]: missing or invalid "${field}" (expected a non-empty string)`,
    );
  }
}

export class FixtureAdapter implements GameAdapter {
  readonly id: string;
  private readonly source: FixtureSource;

  /**
   * File-backed fixture: `source` is a path to a JSON file (see module doc
   * for the shape). Pass an array instead to build an in-memory fixture.
   */
  constructor(source: string | readonly FixtureWorkItem[], id = "fixture") {
    this.id = id;
    this.source =
      typeof source === "string"
        ? { kind: "file", path: source }
        : { kind: "array", items: [...source] };
  }

  /** In-memory fixture (tests, generators) — same import semantics as the file form. */
  static fromArray(items: readonly FixtureWorkItem[], id = "fixture"): FixtureAdapter {
    return new FixtureAdapter(items, id);
  }

  /**
   * Insert every fixture work item; returns the normalized inserted items.
   * All inserts share one transaction: if any item fails (e.g. a duplicate
   * id), the whole import rolls back — a partial import is never persisted.
   */
  async importWorkItems(ctx: AdapterCtx): Promise<WorkItem[]> {
    const items: WorkItem[] = this.readEntries().map((entry, index) => {
      requireString(entry, index, "id");
      requireString(entry, index, "kind");
      requireString(entry, index, "status");
      return normalizeFixture(entry);
    });
    await ctx.store.transaction(async (tx) => {
      const repo = new WorkItemRepo(tx);
      for (const item of items) {
        await repo.insert(item);
      }
    });
    return items;
  }

  private readEntries(): FixtureWorkItem[] {
    if (this.source.kind === "array") return this.source.items;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.source.path, "utf8"));
    } catch (err) {
      throw new Error(
        `fixture: cannot read ${this.source.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : (parsed as { workItems?: unknown } | null)?.workItems;
    if (!Array.isArray(entries)) {
      throw new Error(
        `fixture ${this.source.path}: expected { "workItems": [...] } or a bare array`,
      );
    }
    return entries as FixtureWorkItem[];
  }

  // ── SPEC §7 required surface beyond importWorkItems ──────────────────────
  // The fixture adapter is a pure registry-import source: it has no diff
  // engine, no build, no lint surface. These members exist only to satisfy
  // the GameAdapter contract; the meaningful ones (verify) fail loudly, the
  // rest return the empty/neutral value.

  /** No diff engine — verification is unsupported. Loud, not silent. */
  async verify(_ctx: AdapterCtx, _item: WorkItem): Promise<Verdict> {
    throw new Error(
      `fixture adapter ${this.id}: verify() requires a diff engine; use a real game adapter (e.g. xenoblade)`,
    );
  }

  /** No lint rules for fixture imports. */
  lintRules(): LintRule[] {
    return [];
  }

  /** No placeholder detection: every pattern is empty (matches nothing). */
  placeholderPatterns(): PlaceholderPatterns {
    return { function: "", class: "", unknown: "", label: "", data: "" };
  }

  /** No style guide shipped with the fixture adapter. */
  styleGuidePath(): string {
    return "";
  }

  /** Fixture statuses are whatever the imported JSON says — no vocab. */
  statusVocab(): StatusVocab {
    return { accepted: [], rejected: [], pending: [] };
  }

  /** The fixture adapter never builds — no build lock. */
  buildLockPath(_ctx: AdapterCtx): string {
    return "";
  }
}
