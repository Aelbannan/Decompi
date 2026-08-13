/**
 * Registry snapshot export/import (SPEC §6.3, §15): a git-exportable
 * canonical snapshot of durable match state — work items + deps +
 * capabilities in one JSON object (keys `workItems` / `deps` /
 * `capabilities`). Claims are never part of it (they are ephemeral leases).
 *
 * Ids are preserved verbatim: target ids are the join key for deps, ledger
 * counts, and asm data, so the importer must not re-generate them (SPEC
 * §6.4). `exportRegistry` emits deterministic ordering (ids, then edge
 * keys) so a snapshot is byte-stable for git round-trips; `importRegistry`
 * restores work items through `WorkItemRepo`, then deps and capabilities
 * through `DepsStore`, all inside one transaction — a failing item rolls
 * the whole restore back (no partial import is ever persisted).
 */
import type { SqlAdapter } from "../core/store/adapter.js";
import type { WorkItem } from "../types.js";
import { WorkItemRepo, rowToWorkItem } from "./work-item.js";
import { DEP_KINDS, DepsStore, type DepKind } from "./deps.js";
import type { WorkItemRow } from "./selector.js";

/** A dep edge as exported (camelCase, kind restricted to the schema vocab). */
export interface RegistryDep {
  fromId: string;
  toId: string;
  kind: DepKind;
}

/** A capability as exported. */
export interface RegistryCapability {
  workItemId: string;
  capability: string;
}

/** Canonical snapshot shape (§6.3, §15): the whole registry in one object. */
export interface RegistrySnapshot {
  workItems: WorkItem[];
  deps: RegistryDep[];
  capabilities: RegistryCapability[];
}

/**
 * Core-owned lifecycle vocab (SPEC §8: `pending → claimed → active →
 * verified → accepted | rejected`, plus the preserved `revalidation_required`
 * / `blocked` / `not_required` states; schema.sql `work_items.lifecycle`).
 */
const LIFECYCLE_VOCAB = [
  "pending",
  "claimed",
  "active",
  "verified",
  "accepted",
  "rejected",
  "revalidation_required",
  "blocked",
  "not_required",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotError(detail: string): never {
  throw new Error(`invalid snapshot: ${detail}`);
}

/** Present-and-wrong-type optional fields are rejected, never silently dropped. */
function optionalString(
  raw: Record<string, unknown>,
  field: string,
  context: string,
): string | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    snapshotError(`${context}.${field} must be a string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function optionalNumber(
  raw: Record<string, unknown>,
  field: string,
  context: string,
): number | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    snapshotError(`${context}.${field} must be a number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function requiredString(
  raw: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = optionalString(raw, field, context);
  if (value === undefined || value.length === 0) {
    snapshotError(`${context}.${field} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(
  raw: Record<string, unknown>,
  field: string,
  context: string,
  fallback: boolean,
): boolean {
  const value = raw[field];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    snapshotError(`${context}.${field} must be a boolean (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Shape-validate an untrusted snapshot (CLI JSON) and normalize it into a
 * full `RegistrySnapshot`. Lenient only where the fixture adapter is (an
 * absent `lifecycle` defaults to `pending`, `attempts`→0, `exhausted`/
 * `ready`→false, `meta`→{}); a present-but-wrong-typed value is rejected
 * with a clear error rather than silently dropped.
 */
export function validateRegistrySnapshot(input: unknown): RegistrySnapshot {
  if (!isRecord(input)) {
    snapshotError("expected an object with workItems/deps/capabilities arrays");
  }
  const workItems = input["workItems"];
  const deps = input["deps"];
  const capabilities = input["capabilities"];
  if (!Array.isArray(workItems)) snapshotError("workItems must be an array");
  if (!Array.isArray(deps)) snapshotError("deps must be an array");
  if (!Array.isArray(capabilities)) snapshotError("capabilities must be an array");

  const validated: RegistrySnapshot = {
    workItems: workItems.map((entry, index): WorkItem => {
      if (!isRecord(entry)) snapshotError(`workItems[${index}] must be an object`);
      const ctx = `workItems[${index}]`;
      return {
        id: requiredString(entry, "id", ctx),
        kind: requiredString(entry, "kind", ctx),
        lifecycle: optionalString(entry, "lifecycle", ctx) ?? "pending",
        status: requiredString(entry, "status", ctx),
        unitId: optionalString(entry, "unitId", ctx),
        region: optionalString(entry, "region", ctx),
        symbol: optionalString(entry, "symbol", ctx),
        address: optionalString(entry, "address", ctx),
        milestone: optionalString(entry, "milestone", ctx),
        requiredLevel: optionalString(entry, "requiredLevel", ctx),
        size: optionalNumber(entry, "size", ctx),
        source: optionalString(entry, "source", ctx),
        attempts: optionalNumber(entry, "attempts", ctx) ?? 0,
        exhausted: optionalBoolean(entry, "exhausted", ctx, false),
        ready: optionalBoolean(entry, "ready", ctx, false),
        meta: entry["meta"] === undefined ? {} : isRecord(entry["meta"]) ? entry["meta"] : snapshotError(`${ctx}.meta must be an object`),
      };
    }),
    deps: deps.map((entry, index): RegistryDep => {
      if (!isRecord(entry)) snapshotError(`deps[${index}] must be an object`);
      const ctx = `deps[${index}]`;
      const fromId = requiredString(entry, "fromId", ctx);
      const toId = requiredString(entry, "toId", ctx);
      const kind = requiredString(entry, "kind", ctx);
      if (!(DEP_KINDS as readonly string[]).includes(kind)) {
        snapshotError(`${ctx}.kind must be one of ${DEP_KINDS.join("|")} (got ${JSON.stringify(kind)})`);
      }
      return { fromId, toId, kind: kind as DepKind };
    }),
    capabilities: capabilities.map((entry, index): RegistryCapability => {
      if (!isRecord(entry)) snapshotError(`capabilities[${index}] must be an object`);
      const ctx = `capabilities[${index}]`;
      return {
        workItemId: requiredString(entry, "workItemId", ctx),
        capability: requiredString(entry, "capability", ctx),
      };
    }),
  };

  // Referential integrity (SPEC §6.3/§15): every edge endpoint must name an
  // item in the same snapshot — dangling deps/capabilities would break the
  // call-graph wave, the byte-stable git round-trip, and the id-preservation
  // guarantee. The lifecycle vocab (SPEC §8) is enforced here too, so an
  // untrusted snapshot can never smuggle in a state the engine does not own.
  const ids = new Set(validated.workItems.map((item) => item.id));
  for (let i = 0; i < validated.workItems.length; i++) {
    const lifecycle = validated.workItems[i]!.lifecycle;
    if (!(LIFECYCLE_VOCAB as readonly string[]).includes(lifecycle)) {
      snapshotError(
        `workItems[${i}].lifecycle must be one of ${LIFECYCLE_VOCAB.join("|")} (got ${JSON.stringify(lifecycle)})`,
      );
    }
  }
  for (let i = 0; i < validated.deps.length; i++) {
    const dep = validated.deps[i]!;
    if (!ids.has(dep.fromId)) {
      snapshotError(`deps[${i}].fromId references unknown work item ${JSON.stringify(dep.fromId)}`);
    }
    if (!ids.has(dep.toId)) {
      snapshotError(`deps[${i}].toId references unknown work item ${JSON.stringify(dep.toId)}`);
    }
  }
  for (let i = 0; i < validated.capabilities.length; i++) {
    const capability = validated.capabilities[i]!;
    if (!ids.has(capability.workItemId)) {
      snapshotError(
        `capabilities[${i}].workItemId references unknown work item ${JSON.stringify(capability.workItemId)}`,
      );
    }
  }
  return validated;
}

/** Dump the whole registry (work items + deps + capabilities) as one snapshot. */
export async function exportRegistry(adapter: SqlAdapter): Promise<RegistrySnapshot> {
  const itemRows = await adapter.query<WorkItemRow>("SELECT * FROM work_items ORDER BY id");
  const depRows = await adapter.query<{ from_id: string; to_id: string; kind: string }>(
    "SELECT from_id, to_id, kind FROM work_item_deps ORDER BY from_id, to_id, kind",
  );
  const capabilityRows = await adapter.query<{ work_item_id: string; capability: string }>(
    "SELECT work_item_id, capability FROM work_item_capabilities ORDER BY work_item_id, capability",
  );
  return {
    workItems: itemRows.map(rowToWorkItem),
    deps: depRows.map((row) => ({
      fromId: row.from_id,
      toId: row.to_id,
      kind: row.kind as DepKind,
    })),
    capabilities: capabilityRows.map((row) => ({
      workItemId: row.work_item_id,
      capability: row.capability,
    })),
  };
}

export interface ImportResult {
  /** Number of work items inserted (deps/capabilities are edges, not counted). */
  inserted: number;
}

/**
 * Restore a registry snapshot. Work items go in through `WorkItemRepo`
 * (strict: a duplicate `id` throws, never silently overwrites), then deps
 * and capabilities through `DepsStore` — all inside one transaction, so any
 * failure rolls the whole restore back.
 */
export async function importRegistry(
  adapter: SqlAdapter,
  snapshot: RegistrySnapshot,
): Promise<ImportResult> {
  const validated = validateRegistrySnapshot(snapshot);
  return adapter.transaction(async (tx) => {
    const repo = new WorkItemRepo(tx);
    const deps = new DepsStore(tx);
    for (const item of validated.workItems) {
      await repo.insert(item);
    }
    for (const dep of validated.deps) {
      await deps.addDep(dep.fromId, dep.toId, dep.kind);
    }
    for (const capability of validated.capabilities) {
      await deps.addCapability(capability.workItemId, capability.capability);
    }
    return { inserted: validated.workItems.length };
  });
}
