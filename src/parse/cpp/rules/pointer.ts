/**
 * M1a pointer-arithmetic source rules (SPEC §13.1) — tree-sitter CST port of
 * `tools/coop/detect_pointer_arithmetic.py` (Xenoblade co-op fork). Six rules,
 * one per detector category:
 *
 *   ptr.cast_byte_offset_deref  `*(T*)((byte*)p +/- N)`       [manual field access]
 *   ptr.cast_byte_ptr_arith     `(byte*)p +/- N`              [byte-pointer arithmetic]
 *   ptr.cast_int_arith          `(T*)((int-type)p +/- N)`     [int-cast arithmetic]
 *   ptr.subscript_on_cast       `((T*)p)[N]`                  [subscript on cast ptr]
 *   ptr.ptr_offset_deref        `*(T*)(p +/- N)`              [raw offset deref]
 *   ptr.reinterpret_arith       `reinterpret_cast<T*>(reinterpret_cast<byte*>(p) +/- N)`
 *
 * Base-type classification mirrors the Python `BYTE_T`/`INT_T` alternations
 * exactly (case-insensitive):
 *   byte types  — char, u8, uint8_t, unsigned char, s8, int8_t, byte
 *   integer types — u32, uint32_t, unsigned int, unsigned, uint, size_t,
 *                   uintptr_t, s32, int32_t
 * Byte casts mean explicit byte stepping; integer casts mean arithmetic on
 * the address-as-integer — that distinction decides which category fires.
 *
 * Faithful-port notes (deviations from the line/regex scanner, per the
 * SPEC §13.4 "documented deviation list" policy; CST rewrites are not
 * count-identical to regex scanners):
 *  - **Shared overlap suppression.** `scan` collects all six categories in
 *    the Python evaluation order (cast_byte_offset_deref, cast_byte_ptr_arith,
 *    cast_int_arith, subscript_on_cast, ptr_offset_deref, reinterpret_arith,
 *    nested reinterpret first) and keeps the first match of any overlapping
 *    span, mirroring detect_pointer_arithmetic.py's per-line `seen` set. Each
 *    rule is that aggregate scan filtered to its own id, so `pointerRules`
 *    together reproduce the Python tool's default full-scan output; running a
 *    single rule in isolation applies the same cross-rule suppression (unlike
 *    the Python `--category` flag, which disables cross-category dedupe).
 *  - **Target types are CST-generalized.** Any tree-sitter pointer
 *    `type_descriptor` is accepted for `T*`, including qualified / multi-word
 *    / template targets (`const Foo*`, `unsigned int*`, `A::B*`) and trailing
 *    qualifiers (`int* const`); the Python regex only matches a bare
 *    `identifier*`.
 *  - **ptr_offset_deref base must be a plain identifier node.** The CST
 *    excludes member/call/literal bases (`c->f`, `get()`, `0x…`) that the
 *    regex misfires on (e.g. Python reports `c->field + 4` as variable `c`,
 *    offset `>field + 4`; we deliberately drop that false positive).
 *  - **Field extraction uses full operand text.** Python truncates
 *    base/offset at the first `)`; e.g. `(byte*)(p + 1) + 4` reports base
 *    `(p + 1)` here vs `(p + 1` in Python.
 *  - **The Python regexes' `[^)]+?)\\s*[+\\-]` artifact is not ported.**
 *    The regex separator expects a `)` immediately before the `+`/`-`,
 *    which only exists when the base expression itself contains a closing
 *    paren (function call / nested parens). As a result the Python tool does
 *    NOT fire `cast_byte_offset_deref` / `cast_byte_ptr_arith` for plain
 *    identifier bases (`*(int*)((char*)p + 4)`, `(u8*)p + 4`), contradicting
 *    its own doc labels. We implement the documented semantics (the SPEC
 *    §13.1 labels), so those canonical forms fire here; and conversely we
 *    drop the Python false positive where a member base `c->field + 4` is
 *    reported as `ptr_offset_deref` with variable `c`, offset `>field + 4`.
 *  - **reinterpret_arith outer target accepts any type.** Python's
 *    `[^>]+` matches non-pointer targets too (`reinterpret_cast<u32>(… + 4)`
 *    carries `target_type=u32`); the common `T*` form is just the usual case.
 *  - **Whole-file CST vs per-line regex.** Matches are whole-node and dedupe
 *    is global (Python dedupes per line); multi-line expressions yield single
 *    findings. Identical outcome on single-line code.
 *  - `reinterpret_cast<byte*>(p) +/- N` at the top level maps to
 *    `ptr.reinterpret_arith` without a `target_type` (Python's
 *    REINTERPRET_BYTE_ARITH); the nested `reinterpret_cast<T*>(… + N)` form
 *    carries one.
 */
import type { SyntaxNode } from "tree-sitter";
import { descendants, nodeLoc, nodeText } from "../tree.js";
import type { Finding, SourceRule } from "../types.js";

/* ------------------------------------------------------------------ *
 * Byte / integer base-type classification (Python BYTE_T / INT_T)
 * ------------------------------------------------------------------ */

/** Byte base types: casts to these pointers step one byte at a time. */
const BYTE_TYPES: ReadonlySet<string> = new Set([
  "char",
  "u8",
  "uint8_t",
  "unsigned char",
  "s8",
  "int8_t",
  "byte",
]);

/** Integer base types: casts to these treat the address as an integer. */
const INT_TYPES: ReadonlySet<string> = new Set([
  "u32",
  "uint32_t",
  "unsigned int",
  "unsigned",
  "uint",
  "size_t",
  "uintptr_t",
  "s32",
  "int32_t",
]);

/** Normalized classification of a `type_descriptor` text. */
interface TypeInfo {
  /** Type text before the first `*`, trimmed, whitespace-collapsed, lowercased. */
  base: string;
  /** True when the descriptor contains at least one `*`. */
  isPointer: boolean;
}

function typeInfo(typeText: string): TypeInfo {
  const star = typeText.indexOf("*");
  const baseRaw = star >= 0 ? typeText.slice(0, star) : typeText;
  return {
    base: baseRaw.trim().replace(/\s+/g, " ").toLowerCase(),
    isPointer: star >= 0,
  };
}

/** `(byte*)`-style cast target: pointer whose base is a byte type. */
function isBytePointer(typeText: string): boolean {
  const t = typeInfo(typeText);
  return t.isPointer && BYTE_TYPES.has(t.base);
}

/** `(int-type)` scalar cast target (the inner cast of cast_int_arith). */
function isIntScalar(typeText: string): boolean {
  const t = typeInfo(typeText);
  return !t.isPointer && INT_TYPES.has(t.base);
}

/** Any pointer cast target (`T*`). */
function isPointerType(typeText: string): boolean {
  return typeInfo(typeText).isPointer;
}

/* ------------------------------------------------------------------ *
 * Node helpers
 * ------------------------------------------------------------------ */

/** Strip a `parenthesized_expression` wrapper, repeatedly. */
function unwrapParens(node: SyntaxNode): SyntaxNode {
  let cur = node;
  while (cur.type === "parenthesized_expression") {
    const inner = cur.namedChildren[0];
    if (inner === undefined) break;
    cur = inner;
  }
  return cur;
}

/** The `+`/`-` operator of a `binary_expression`, or null for any other op. */
function binaryOperator(bin: SyntaxNode, source: string): "+" | "-" | null {
  for (const child of bin.children) {
    if (child.isNamed) continue;
    const t = nodeText(child, source);
    if (t === "+" || t === "-") return t;
  }
  return null;
}

/** The `type_descriptor` of a C-style cast_expression, if any. */
function castTypeDescriptor(cast: SyntaxNode): SyntaxNode | null {
  const td = cast.namedChildren[0];
  return td !== undefined && td.type === "type_descriptor" ? td : null;
}

/** Target type text of `reinterpret_cast<T*>(...)` or null when not that. */
function reinterpretCastInfo(
  node: SyntaxNode,
  source: string,
): { target: string; isByte: boolean } | null {
  if (node.type !== "call_expression") return null;
  const callee = node.namedChildren[0];
  if (callee === undefined || callee.type !== "template_function") return null;
  const id = callee.namedChildren[0];
  if (
    id === undefined ||
    id.type !== "identifier" ||
    nodeText(id, source) !== "reinterpret_cast"
  ) {
    return null;
  }
  const targs = callee.namedChildren[1];
  if (targs === undefined || targs.type !== "template_argument_list") return null;
  const td = targs.namedChildren[0];
  if (td === undefined || td.type !== "type_descriptor") return null;
  const text = nodeText(td, source);
  return { target: text.trim(), isByte: isBytePointer(text) };
}

/* ------------------------------------------------------------------ *
 * Per-category match collection (in Python evaluation order)
 * ------------------------------------------------------------------ */

/** A candidate finding before overlap suppression. */
interface RawMatch {
  rule: string;
  node: SyntaxNode;
  start: number;
  end: number;
  message: string;
}

/** Text of a cast's value operand (Python's "base_expr"), trimmed. */
function operandText(cast: SyntaxNode, source: string): string {
  const value = cast.namedChildren[1];
  return value === undefined ? "" : nodeText(value, source).trim();
}

/** `*(T*)((byte*)expr +/- N)` — cast to pointer, byte-cast base, deref. */
function collectCastByteOffsetDeref(root: SyntaxNode, source: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const pe of descendants(root, "pointer_expression")) {
    const cast = pe.namedChildren[0];
    if (cast === undefined || cast.type !== "cast_expression") continue;
    const target = castTypeDescriptor(cast);
    if (target === null || !isPointerType(nodeText(target, source))) continue;
    const valueNode = cast.namedChildren[1];
    if (valueNode === undefined) continue;
    const value = unwrapParens(valueNode);
    if (value.type !== "binary_expression" || binaryOperator(value, source) === null) continue;
    const leftNode = value.namedChildren[0];
    const rightNode = value.namedChildren[1];
    if (leftNode === undefined || rightNode === undefined) continue;
    const baseCast = unwrapParens(leftNode);
    if (baseCast.type !== "cast_expression") continue;
    const baseTd = castTypeDescriptor(baseCast);
    if (baseTd === null || !isBytePointer(nodeText(baseTd, source))) continue;
    const targetText = nodeText(target, source).trim();
    const baseText = nodeText(baseTd, source).trim();
    const base = operandText(baseCast, source);
    const offset = nodeText(rightNode, source).trim();
    out.push({
      rule: "ptr.cast_byte_offset_deref",
      node: pe,
      start: pe.startIndex,
      end: pe.endIndex,
      message:
        `pointer cast + byte-offset deref (target ${targetText}, baseCast ${baseText}, ` +
        `base ${base}, offset ${offset}) — manual field access; use struct fields`,
    });
  }
  return out;
}

/** `(byte*)expr +/- N` — byte-pointer arithmetic as a standalone expression. */
function collectCastBytePtrArith(root: SyntaxNode, source: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const bin of descendants(root, "binary_expression")) {
    if (binaryOperator(bin, source) === null) continue;
    const leftNode = bin.namedChildren[0];
    const rightNode = bin.namedChildren[1];
    if (leftNode === undefined || rightNode === undefined) continue;
    const baseCast = unwrapParens(leftNode);
    if (baseCast.type !== "cast_expression") continue;
    const baseTd = castTypeDescriptor(baseCast);
    if (baseTd === null || !isBytePointer(nodeText(baseTd, source))) continue;
    const baseText = nodeText(baseTd, source).trim();
    const base = operandText(baseCast, source);
    const offset = nodeText(rightNode, source).trim();
    out.push({
      rule: "ptr.cast_byte_ptr_arith",
      node: bin,
      start: bin.startIndex,
      end: bin.endIndex,
      message:
        `byte-pointer arithmetic (baseCast ${baseText}, base ${base}, offset ${offset}) — ` +
        `byte-stepping bypasses pointer typing`,
    });
  }
  return out;
}

/** `(T*)((int-type)expr +/- N)` — pointer from integer-cast arithmetic. */
function collectCastIntArith(root: SyntaxNode, source: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const cast of descendants(root, "cast_expression")) {
    const target = castTypeDescriptor(cast);
    if (target === null || !isPointerType(nodeText(target, source))) continue;
    const valueNode = cast.namedChildren[1];
    if (valueNode === undefined) continue;
    const value = unwrapParens(valueNode);
    if (value.type !== "binary_expression" || binaryOperator(value, source) === null) continue;
    const leftNode = value.namedChildren[0];
    const rightNode = value.namedChildren[1];
    if (leftNode === undefined || rightNode === undefined) continue;
    const intCast = unwrapParens(leftNode);
    if (intCast.type !== "cast_expression") continue;
    const intTd = castTypeDescriptor(intCast);
    if (intTd === null || !isIntScalar(nodeText(intTd, source))) continue;
    const targetText = nodeText(target, source).trim();
    const intText = nodeText(intTd, source).trim();
    const base = operandText(intCast, source);
    const offset = nodeText(rightNode, source).trim();
    out.push({
      rule: "ptr.cast_int_arith",
      node: cast,
      start: cast.startIndex,
      end: cast.endIndex,
      message:
        `int-cast pointer arithmetic (target ${targetText}, intCast ${intText}, ` +
        `base ${base}, offset ${offset}) — address-as-integer arithmetic`,
    });
  }
  return out;
}

/** `((T*)expr)[...]` — subscript on a pointer produced by a cast. */
function collectSubscriptOnCast(root: SyntaxNode, source: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const sub of descendants(root, "subscript_expression")) {
    const baseNode = sub.namedChildren[0];
    if (baseNode === undefined) continue;
    const base = unwrapParens(baseNode);
    let cast: SyntaxNode;
    if (base.type === "cast_expression") {
      cast = base;
    } else if (base.type === "binary_expression") {
      // Python's `[^)]+` base also accepts `((T*)p + N)[M]`.
      if (binaryOperator(base, source) === null) continue;
      const leftNode = base.namedChildren[0];
      if (leftNode === undefined) continue;
      const left = unwrapParens(leftNode);
      if (left.type !== "cast_expression") continue;
      cast = left;
    } else {
      continue;
    }
    const td = castTypeDescriptor(cast);
    if (td === null || !isPointerType(nodeText(td, source))) continue;
    const castText = nodeText(td, source).trim();
    const baseExpr = base.type === "binary_expression" ? nodeText(base, source).trim() : operandText(cast, source);
    out.push({
      rule: "ptr.subscript_on_cast",
      node: sub,
      start: sub.startIndex,
      end: sub.endIndex,
      message:
        `subscript on cast pointer (cast ${castText}, base ${baseExpr}) — ` +
        `array access through a manual pointer cast`,
    });
  }
  return out;
}

/** `*(T*)(expr +/- N)` — deref of a pointer offset from a plain identifier. */
function collectPtrOffsetDeref(root: SyntaxNode, source: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const pe of descendants(root, "pointer_expression")) {
    const cast = pe.namedChildren[0];
    if (cast === undefined || cast.type !== "cast_expression") continue;
    const target = castTypeDescriptor(cast);
    if (target === null || !isPointerType(nodeText(target, source))) continue;
    const valueNode = cast.namedChildren[1];
    if (valueNode === undefined) continue;
    const value = unwrapParens(valueNode);
    if (value.type !== "binary_expression" || binaryOperator(value, source) === null) continue;
    const leftNode = value.namedChildren[0];
    const rightNode = value.namedChildren[1];
    if (leftNode === undefined || rightNode === undefined) continue;
    const variable = unwrapParens(leftNode);
    // Base must be a plain identifier: numbers (incl. 0x…), keywords, NULL,
    // nullptr, true/false, calls, and member access all parse as other node
    // types, so this is exactly the Python exclusion list.
    if (variable.type !== "identifier") continue;
    const targetText = nodeText(target, source).trim();
    const varText = nodeText(variable, source).trim();
    const offset = nodeText(rightNode, source).trim();
    out.push({
      rule: "ptr.ptr_offset_deref",
      node: pe,
      start: pe.startIndex,
      end: pe.endIndex,
      message:
        `raw pointer offset deref (target ${targetText}, variable ${varText}, ` +
        `offset ${offset}) — manual field access; use struct fields`,
    });
  }
  return out;
}

/** `reinterpret_cast<T*>(reinterpret_cast<byte*>(p) +/- N)` and the top-level byte variant. */
function collectReinterpretArith(root: SyntaxNode, source: string): RawMatch[] {
  const out: RawMatch[] = [];
  // Nested form (Python REINTERPRET_ARITH), collected first in source order.
  for (const call of descendants(root, "call_expression")) {
    const info = reinterpretCastInfo(call, source);
    // Outer target is any type (Python `[^>]+`): `reinterpret_cast<T*>(…)`
    // is the common case, but `reinterpret_cast<u32>(… + N)` fires too.
    if (info === null) continue;
    const args = call.namedChildren[1];
    if (args === undefined || args.type !== "argument_list") continue;
    const argNode = args.namedChildren[0];
    if (argNode === undefined) continue;
    const arg = unwrapParens(argNode);
    if (arg.type !== "binary_expression" || binaryOperator(arg, source) === null) continue;
    const leftNode = arg.namedChildren[0];
    const rightNode = arg.namedChildren[1];
    if (leftNode === undefined || rightNode === undefined) continue;
    const inner = unwrapParens(leftNode);
    const innerInfo = reinterpretCastInfo(inner, source);
    if (innerInfo === null || !innerInfo.isByte) continue;
    const innerArgs = inner.namedChildren[1];
    if (innerArgs === undefined || innerArgs.type !== "argument_list") continue;
    const innerArgNode = innerArgs.namedChildren[0];
    if (innerArgNode === undefined) continue;
    const base = nodeText(innerArgNode, source).trim();
    const offset = nodeText(rightNode, source).trim();
    out.push({
      rule: "ptr.reinterpret_arith",
      node: call,
      start: call.startIndex,
      end: call.endIndex,
      message:
        `reinterpret_cast byte offset (target ${info.target}, baseCast ${innerInfo.target}, ` +
        `base ${base}, offset ${offset}) — manual byte stepping`,
    });
  }
  // Top-level byte variant (Python REINTERPRET_BYTE_ARITH): `reinterpret_cast<byte*>(p) +/- N`.
  for (const bin of descendants(root, "binary_expression")) {
    if (binaryOperator(bin, source) === null) continue;
    const leftNode = bin.namedChildren[0];
    const rightNode = bin.namedChildren[1];
    if (leftNode === undefined || rightNode === undefined) continue;
    const inner = unwrapParens(leftNode);
    const info = reinterpretCastInfo(inner, source);
    if (info === null || !info.isByte) continue;
    const innerArgs = inner.namedChildren[1];
    if (innerArgs === undefined || innerArgs.type !== "argument_list") continue;
    const argNode = innerArgs.namedChildren[0];
    if (argNode === undefined) continue;
    const base = nodeText(argNode, source).trim();
    const offset = nodeText(rightNode, source).trim();
    out.push({
      rule: "ptr.reinterpret_arith",
      node: bin,
      start: bin.startIndex,
      end: bin.endIndex,
      message:
        `reinterpret_cast byte stepping (baseCast ${info.target}, base ${base}, ` +
        `offset ${offset}) — manual byte stepping`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Aggregate scan + overlap suppression (Python per-line `seen` set)
 * ------------------------------------------------------------------ */

/**
 * All category matches in Python evaluation order (cast_byte_offset_deref,
 * cast_byte_ptr_arith, cast_int_arith, subscript_on_cast, ptr_offset_deref,
 * reinterpret_arith nested-then-top-level), then keep only matches whose span
 * does not overlap any earlier-kept match — detect_pointer_arithmetic.py's
 * `add()` dedupe, generalized from per-line to the whole file.
 */
function scan(root: SyntaxNode, source: string): RawMatch[] {
  const matches: RawMatch[] = [
    ...collectCastByteOffsetDeref(root, source),
    ...collectCastBytePtrArith(root, source),
    ...collectCastIntArith(root, source),
    ...collectSubscriptOnCast(root, source),
    ...collectPtrOffsetDeref(root, source),
    ...collectReinterpretArith(root, source),
  ];
  const kept: RawMatch[] = [];
  for (const m of matches) {
    let overlaps = false;
    for (const k of kept) {
      if (m.start < k.end && k.start < m.end) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(m);
  }
  return kept;
}

/** Convert a kept raw match into a `Finding` (1-indexed line/column). */
function toFinding(m: RawMatch, source: string): Finding {
  const loc = nodeLoc(m.node);
  const snippet = nodeText(m.node, source).trim().replace(/\s+/g, " ").slice(0, 100);
  return { rule: m.rule, line: loc.line, column: loc.column, snippet, message: m.message };
}

/** Build the per-id rule from the shared aggregate scan. */
function ruleFor(id: string, description: string): SourceRule {
  return {
    id,
    description,
    run: (root, source) =>
      scan(root, source)
        .filter((m) => m.rule === id)
        .map((m) => toFinding(m, source)),
  };
}

/** The six pointer-arithmetic source rules (SPEC §13.1). */
export const pointerRules: SourceRule[] = [
  ruleFor(
    "ptr.cast_byte_offset_deref",
    "*(T*)((byte*)p +/- N)  [manual field access]",
  ),
  ruleFor(
    "ptr.cast_byte_ptr_arith",
    "(byte*)p +/- N  [byte-pointer arithmetic]",
  ),
  ruleFor(
    "ptr.cast_int_arith",
    "(T*)((int-type)p +/- N)  [int-cast arithmetic]",
  ),
  ruleFor(
    "ptr.subscript_on_cast",
    "((T*)p)[N]  [subscript on cast ptr]",
  ),
  ruleFor(
    "ptr.ptr_offset_deref",
    "*(T*)(p +/- N)  [raw offset deref]",
  ),
  ruleFor(
    "ptr.reinterpret_arith",
    "reinterpret_cast<T*>(reinterpret_cast<byte*>(p) +/- N)",
  ),
];
