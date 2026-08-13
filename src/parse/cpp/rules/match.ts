/**
 * M1a matched-function smell rules (SPEC §13.1) — CST port of
 * `tools/coop/detect_smells.py` (Xenoblade co-op fork), fixture-backed: the
 * rules need work-item status, which M1a reads from a fixture JSON (the real
 * store lands in M2, §19). Three rules:
 *
 *   match.func_placeholder    func_XXXXXXXX / fn_XXXXXXXX placeholder names
 *   match.class_placeholder   UnkClass* / Class_XXXXXXXX placeholder names
 *   match.void_ptr_params     void* parameters in matched function signatures
 *
 * Every rule only fires for ACCEPTED work items (status FULL_MATCH /
 * EQUIVALENT_MATCH — Python detect_smells.py's status filter): a placeholder
 * name that is still NOT_STARTED is not a smell yet. The fixture-backed source
 * is a `byName` map (work-item symbol/function names → item refs) carried in
 * `LintConfig.match`; the factory receives an `acceptedIds` set / status
 * predicate and refuses to fire for any name whose item is not accepted.
 *
 * Python parity notes:
 *  - detect_smells.py is a target-registry scan (one finding per accepted
 *    target whose NAME is a placeholder), cross-referenced against source text;
 *    the CST rules are the source-scan dual: one finding per placeholder
 *    identifier in the TU, deduplicated by name (Python `findall`-set), fired
 *    only when that name is an accepted work-item name.
 *  - `func_` default is Python's `^func_[0-9a-fA-F]{7,8}$`; `fn_` is the
 *    SPEC §13.1 configurable second prefix (default `^fn_[0-9a-fA-F]+$`).
 *  - `class_placeholder` mirrors `has_unkclass`: the declared name contains
 *    `UnkClass` or starts with `Class_` + hex; the item's symbol may also
 *    carry `UnkClass` (Python checks function AND symbol fields).
 *  - `void_ptr_params` fires per function_definition whose name is an accepted
 *    work item and whose parameter list contains a `void*`/`void *`/`void**`
 *    parameter (Python's `"void*" in params` substring check, CST-based).
 */
import type { SyntaxNode } from "tree-sitter";
import { descendants, nodeLoc, nodeText } from "../tree.js";
import type { Finding, SourceRule } from "../types.js";

/** Statuses detect_smells.py treats as accepted (reportable matches). */
export const ACCEPTED_STATUSES: ReadonlySet<string> = new Set([
  "FULL_MATCH",
  "EQUIVALENT_MATCH",
]);

/** A work-item reference the rules need for one function/symbol name. */
export interface MatchWorkItemRef {
  id: string;
  status: string;
  symbol?: string;
  unit?: string;
  source?: string;
}

/**
 * Fixture-backed context threaded through `lintFile` (via `LintConfig.match`).
 * `byName` maps every work-item function/symbol name to its ref; the rules
 * only fire for names whose ref id passes the status predicate.
 */
export interface MatchRuleContext {
  /** Work-item names (function/symbol) → item refs (the fixture-backed source). */
  byName?: ReadonlyMap<string, MatchWorkItemRef>;
  /** Ids of accepted work items; a name fires only when its item is accepted. */
  acceptedIds?: ReadonlySet<string>;
  /** Status predicate override; default: `acceptedIds.has(id)`. */
  isAccepted?: (id: string) => boolean;
  /** `func_` placeholder pattern (default Python `^func_[0-9a-fA-F]{7,8}$`). */
  funcPattern?: RegExp;
  /** `fn_` placeholder pattern (default `^fn_[0-9a-fA-F]+$`). */
  fnPattern?: RegExp;
  /** Class placeholder check (default: `UnkClass` substring or `Class_`+hex prefix). */
  classPattern?: RegExp;
}

/** Default `func_` pattern — Python is_func_placeholder. */
const DEFAULT_FUNC_PATTERN = /^func_[0-9a-fA-F]{7,8}$/;
/** Default `fn_` pattern — SPEC §13.1 configurable second prefix. */
const DEFAULT_FN_PATTERN = /^fn_[0-9a-fA-F]+$/;

/** True when the declared name is a class placeholder (Python has_unkclass). */
function isClassPlaceholderName(name: string): boolean {
  return name.includes("UnkClass") || /^Class_[0-9a-fA-F]+/.test(name);
}

/**
 * Deepest identifier inside a declarator (function names).
 */
function leafIdentifier(node: SyntaxNode, source: string): string | null {
  if (node.type === "identifier" || node.type === "field_identifier") {
    return nodeText(node, source);
  }
  for (const child of node.namedChildren) {
    const id = leafIdentifier(child, source);
    if (id !== null) return id;
  }
  return null;
}

/** Declared function name of a function_definition, or null. */
function functionName(fn: SyntaxNode, source: string): string | null {
  const declarator = fn.namedChildren.find(
    (c) => c.type === "function_declarator" || c.type === "template_function",
  );
  if (declarator === undefined) return null;
  return leafIdentifier(declarator, source);
}

/**
 * The `parameter_list` of a function_definition (inside its function_declarator
 * in tree-sitter-cpp), or null.
 */
function parameterListOf(fn: SyntaxNode): SyntaxNode | null {
  for (const pl of descendants(fn, "parameter_list")) {
    if (pl.parent?.type === "function_declarator" || pl.parent?.type === "template_function") {
      return pl;
    }
  }
  return null;
}

/** `void*`-ish parameter: base type `void` + a pointer declarator. */
function isVoidPtrParam(param: SyntaxNode, source: string): boolean {
  const first = param.namedChildren[0];
  if (first === undefined || nodeText(first, source).trim() !== "void") return false;
  return descendants(param, "pointer_declarator").length > 0;
}

/** Build the three matched-function smell rules for a fixture context. */
export function matchRules(ctx: MatchRuleContext): SourceRule[] {
  const byName = ctx.byName ?? new Map<string, MatchWorkItemRef>();
  const isAccepted =
    ctx.isAccepted ??
    ((id: string): boolean => ctx.acceptedIds?.has(id) ?? false);
  const funcPattern = ctx.funcPattern ?? DEFAULT_FUNC_PATTERN;
  const fnPattern = ctx.fnPattern ?? DEFAULT_FN_PATTERN;

  /** Accepted ref for `name`, or undefined when untracked / not accepted. */
  const acceptedRef = (name: string): MatchWorkItemRef | undefined => {
    const ref = byName.get(name);
    if (ref === undefined || !isAccepted(ref.id)) return undefined;
    return ref;
  };

  /**
   * Unique placeholder identifiers in the file (dedupe by name, first
   * position — Python's `findall` → set).
   */
  const uniqueNames = (root: SyntaxNode, source: string, match: (name: string) => boolean): Array<{ name: string; node: SyntaxNode }> => {
    const seen = new Set<string>();
    const out: Array<{ name: string; node: SyntaxNode }> = [];
    const visit = (n: SyntaxNode): void => {
      if (n.type === "identifier") {
        const name = nodeText(n, source);
        if (!seen.has(name) && match(name)) {
          seen.add(name);
          out.push({ name, node: n });
        }
      }
      for (const child of n.namedChildren) visit(child);
    };
    visit(root);
    return out;
  };

  const placeholderFindings = (
    root: SyntaxNode,
    source: string,
    rule: string,
    nameMatches: (name: string) => boolean,
    messageOf: (name: string, ref: MatchWorkItemRef) => string,
  ): Finding[] => {
    const out: Finding[] = [];
    for (const { name, node } of uniqueNames(root, source, nameMatches)) {
      const ref = acceptedRef(name);
      if (ref === undefined) continue;
      const loc = nodeLoc(node);
      out.push({
        rule,
        line: loc.line,
        column: loc.column,
        snippet: name,
        message: messageOf(name, ref),
      });
    }
    return out;
  };

  return [
    {
      id: "match.func_placeholder",
      description:
        "func_/fn_ placeholder function name on an accepted work item (configurable patterns)",
      run: (root, source) =>
        placeholderFindings(
          root,
          source,
          "match.func_placeholder",
          (name) => funcPattern.test(name) || fnPattern.test(name),
          (name, ref) =>
            `placeholder function name '${name}' on accepted work item ` +
            `${ref.id} (status ${ref.status}) — rename from the retail symbol`,
        ),
    },
    {
      id: "match.class_placeholder",
      description:
        "UnkClass*/Class_XXXXXXXX placeholder name on an accepted work item",
      run: (root, source) =>
        placeholderFindings(
          root,
          source,
          "match.class_placeholder",
          (name) =>
            isClassPlaceholderName(name) ||
            (byName.get(name)?.symbol?.includes("UnkClass") ?? false),
          (name, ref) =>
            `class placeholder '${name}' on accepted work item ${ref.id} ` +
            `(status ${ref.status}) — use the real class name from the headers`,
        ),
    },
    {
      id: "match.void_ptr_params",
      description:
        "void* parameter in an accepted matched function signature",
      run: (root, source) => {
        const out: Finding[] = [];
        for (const fn of descendants(root, "function_definition")) {
          const name = functionName(fn, source);
          if (name === null) continue;
          const ref = acceptedRef(name);
          if (ref === undefined) continue;
          const pl = parameterListOf(fn);
          if (pl === null) continue;
          for (const pd of pl.namedChildren) {
            if (pd.type !== "parameter_declaration" || !isVoidPtrParam(pd, source)) continue;
            const loc = nodeLoc(pd);
            out.push({
              rule: "match.void_ptr_params",
              line: loc.line,
              column: loc.column,
              snippet: nodeText(pd, source).trim().replace(/\s+/g, " ").slice(0, 100),
              message:
                `void* parameter in accepted function '${name}' (${ref.id}, ` +
                `status ${ref.status}) — type it from the struct/class layout`,
            });
          }
        }
        return out;
      },
    },
  ];
}

/**
 * Build a `MatchRuleContext` from fixture work items (the M1a fixture-backed
 * source; SPEC §19 — the real store lands in M2). Keys `byName` by symbol and
 * any item-level `function` alias in meta, and derives `acceptedIds` from
 * `ACCEPTED_STATUSES`.
 */
export function matchContextFromFixture(
  items: ReadonlyArray<
    {
      id: string;
      status: string;
      symbol?: string;
      unitId?: string;
      source?: string;
      meta?: Record<string, unknown>;
    } & Record<string, unknown>
  >,
): MatchRuleContext {
  const byName = new Map<string, MatchWorkItemRef>();
  const acceptedIds = new Set<string>();
  for (const item of items) {
    const ref: MatchWorkItemRef = {
      id: item.id,
      status: item.status,
      symbol: item.symbol,
      unit: item.unitId,
      source: item.source,
    };
    if (item.symbol !== undefined && item.symbol.length > 0) byName.set(item.symbol, ref);
    const fn = item.meta?.["function"];
    if (typeof fn === "string" && fn.length > 0) byName.set(fn, ref);
    if (ACCEPTED_STATUSES.has(item.status)) acceptedIds.add(item.id);
  }
  return { byName, acceptedIds };
}
