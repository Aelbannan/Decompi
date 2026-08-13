/**
 * Run scope (SPEC §6): explicit target/unit scoping **intersected** (ANDed)
 * into a `Selector`, plus the scope→selector mapping used for persistence.
 *
 * `targetIds` fold into `filter.ids`, `unitIds` into `filter.unit`; when the
 * selector already restricts the same dimension the scope is set-intersected
 * with it (AND semantics). Both given = unit filter AND id filter.
 */
import type { Selector } from "../types.js";

export interface RunScope {
  targetIds?: string[];
  unitIds?: string[];
}

/** AND two id sets; `existing` absent means "no restriction" (→ scope alone). */
function intersect(existing: string[] | undefined, scope: string[]): string[] {
  if (existing === undefined) return [...scope];
  return existing.filter((id) => scope.includes(id));
}

/**
 * Intersect `scope` into `selector`: the result matches the selector's
 * filters **and** the scope. Returns a new selector; the input is untouched.
 */
export function applyScope(selector: Selector, scope?: RunScope): Selector {
  if (scope === undefined) return selector;
  const filter: NonNullable<Selector["filter"]> = { ...(selector.filter ?? {}) };
  if (scope.targetIds !== undefined) {
    filter.ids = intersect(selector.filter?.ids, scope.targetIds);
  }
  if (scope.unitIds !== undefined) {
    filter.unit = intersect(selector.filter?.unit, scope.unitIds);
  }
  return { ...selector, filter };
}

/**
 * Fold a scope into a bare `Selector` for persistence (SPEC §6): the
 * persisted `runs.selector` carries `filter.ids` / `filter.unit` so a
 * restarted run keeps its scope. Empty scopes are dropped.
 */
export function scopeToSelector(scope: RunScope): Selector {
  const filter: NonNullable<Selector["filter"]> = {};
  if (scope.targetIds !== undefined && scope.targetIds.length > 0) {
    filter.ids = [...scope.targetIds];
  }
  if (scope.unitIds !== undefined && scope.unitIds.length > 0) {
    filter.unit = [...scope.unitIds];
  }
  return { filter };
}
