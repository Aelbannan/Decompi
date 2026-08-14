/**
 * M1a smell-scan source rules (SPEC §13.1) — tree-sitter CST port of
 * `tools/coop/smell_scan.py` (Xenoblade co-op fork). 21 rules, one per SPEC
 * family, exported as `smellRules` in SPEC §13.1 order:
 *
 *   smell.extern_c, smell.self_param, smell.self_access, smell.void_ptr,
 *   smell.void_ptr_cast, smell.ptr_arith, smell.deref_arith, smell.asm_code,
 *   smell.fake_stack, smell.rn_params, smell.goto_count, smell.decomp_macro,
 *   smell.pragma, smell.asm_insn_shim, smell.schedule_pragma,
 *   smell.init_side_effect, smell.if0, smell.class_in_cpp, smell.struct_in_cpp,
 *   smell.fake_array_access, smell.vtable_wrapper.
 *
 * Structural rules (extern_c, self_param, self_access, void_ptr, void_ptr_cast,
 * ptr_arith, deref_arith, asm_code, fake_stack, rn_params, goto_count,
 * class_in_cpp, struct_in_cpp, fake_array_access, vtable_wrapper) run over the
 * tree-sitter CST. Text-only rules (decomp_macro, pragma, asm_insn_shim,
 * schedule_pragma, init_side_effect, if0) use the line-level fallback exactly
 * like smell_scan.py's regexes, including Python's `line.split("//", 1)[0]`
 * comment stripping for single-line rules; init_side_effect runs over the raw
 * text (Python parity — it must cross lines, and its `[^()]*` span cannot
 * cross a nested paren).
 *
 * ---------------------------------------------------------------- *
 * `smell.extern_c` kind scheme (stable, documented):
 *
 *   One rule id, one finding per top-level declaration/definition inside an
 *   `extern "C"` linkage specification, with the split carried in the
 *   message as `kind=lbl|nonlbl-decl|nonlbl-def|other`. The Python scanner's
 *   `extern_c_total` is NOT emitted as a finding: it equals the sum of all
 *   findings for this rule (consumers aggregate by rule id). Empty blocks
 *   emit nothing.
 *
 * ---------------------------------------------------------------- *
 * Faithful-port notes (deviations from smell_scan.py, per SPEC §13.4's
 * "documented deviation list" policy; CST rewrites are not count-identical
 * to the line/regex scanners):
 *
 *  - **extern_c is per-declaration, not per-line.** Python counts every line
 *    inside an `extern "C"` block (multi-line function bodies inflate
 *    `extern_c_total`, the closing brace line is dropped, and a function def
 *    is "def" only on the line with `{`). The CST classifies one finding per
 *    declaration by shape: `function_definition` → nonlbl-def; any node with
 *    a `function_declarator` descendant (decls, function-pointer typedefs) →
 *    nonlbl-decl; other constructs (`int x;`, enums, class bodies — Python
 *    says "def" for any brace-bearing line) → other. Names starting with
 *    `lbl_`/`lbl_eu_` → lbl.
 *  - **self_param excludes rN names.** Python's `RE_PARAM_BY_NAME` also
 *    counts r3..r31 parameters under `self_params` (it overlaps `rn_params`);
 *    the CST keeps `self` in self_param only — rN parameters belong to
 *    `rn_params`.
 *  - **self_param / self_access / rn_params are not line-anchored.** Python's
 *    `^`-anchored regexes only see the first signature-like line; the CST
 *    flags any parameter named `self`/rN in any function (including lambdas
 *    and function-pointer typedefs, which Python misses) and any `self->`
 *    member access anywhere.
 *  - **asm_code dedupes per line.** Python counts one per line. The CST emits
 *    one finding per line from: `gnu_asm_expression` nodes, `register`
 *    storage-class specifiers, and a text fallback for `asm`/`__asm` (MWCC
 *    `asm { }` blocks, `asm void f(...)` declarations and `ASM(...)` macros
 *    are tree-sitter ERROR nodes and cannot be structural).
 *  - **ptr_arith canonical forms only.** Python's unanchored regexes also
 *    fire on `N + (char*)p` layouts and require `+ <digits><terminator>`;
 *    the CST fires when a scalar-base pointer cast (RE_CAST set: char, u8,
 *    u16, u32, s8, s16, s32, int, short, long, float, u64) is the left
 *    operand of a `+`/`-` binary with an integer/hex literal on the right
 *    (Form A: `(char*)p + 4`), or is cast with such a binary as its
 *    parenthesized value (Form B: `(u32*)(p + 0x10)`). `-` offsets fire here
 *    but not in Python (RE_HEX_OFF/RE_DEC_OFF are `+`-only). Python's
 *    RE_DEC_OFF terminator is enforced: a DECIMAL offset must be followed
 *    (after whitespace) by `)`/`,`/`;`/`]` (hex offsets carry no terminator,
 *    mirroring RE_HEX_OFF). Intra-rule overlap suppression keeps one finding
 *    per construct.
 *  - **deref_arith ports Python's RE_DEREF_ARITH exactly:** a deref of a
 *    pointer cast whose value is a `+`-only binary whose leftmost operand is
 *    an inner scalar cast with an enumerated base (char, u8, u16, u32, u64,
 *    int, s8, s16, s32, s64, float, double — with or without a trailing
 *    `*`). No inner scalar cast, a `-` offset, or a non-enumerated base
 *    does not fire (so `*(int*)(p + 4)` and `*(int*)((char*)p - 4)` never
 *    fire, exactly like Python). The outer cast target must be a single-word
 *    pointer (`\w+` in Python).
 *  - **void_ptr counts named declarators only.** `void*` inside `(void*)p`
 *    casts is void_ptr_cast's job; `void** p` counts once here (Python's
 *    `\bvoid\s*\*\s*\w+` misses it). One finding per declarator, so
 *    `void *p, *q;` yields two (Python counts one line).
 *  - **fake_stack is CST-based.** Python's `[^;]` spans can cross newlines;
 *    the CST requires a byte-array declarator (u8/char) that is either
 *    `volatile` or named `sp`/`stack` (with optional digits) — the same two
 *    smell patterns, whole-node.
 *  - **class_in_cpp / struct_in_cpp / fake_array_access / vtable_wrapper are
 *    new rules** with no smell_scan.py equivalent (SPEC §13.1 additions).
 *    They fire on any class/struct *definition* (body present; forward
 *    declarations are excluded); the caller is expected to run the scan on
 *    .cpp TUs (headers are scanned separately, mirroring smell_scan.py's
 *    `--all` mode). Fake-array detection is a same-TU heuristic: a constant
 *    index (number/char literal) on a plain identifier with no
 *    `array_declarator` declaration anywhere in the TU. vtable_wrapper
 *    matches exactly `((Fn**)(*(u32*)obj))[i]` — C-style cast to a
 *    pointer-to-pointer, deref of an integer-pointer cast, subscripted.
 *    The common `(*reinterpret_cast<FontVFn**>(obj))[i]` variant is not
 *    covered (documented limitation).
 *  - **Text rules strip `//` comments like Python** (`line.split("//",1)[0]`,
 *    which also truncates strings containing `//` — mirrored faithfully).
 *    init_side_effect uses raw text (Python parity).
 */
import type { SyntaxNode } from "tree-sitter";
import { descendants, nodeLoc, nodeText } from "../tree.js";
import type { Finding, SourceRule } from "../types.js";

/* ------------------------------------------------------------------ *
 * Small node / text helpers
 * ------------------------------------------------------------------ */

/** Strip `parenthesized_expression` wrappers, repeatedly. */
function unwrapParens(node: SyntaxNode): SyntaxNode {
  let cur = node;
  while (cur.type === "parenthesized_expression") {
    const inner = cur.namedChildren[0];
    if (inner === undefined) break;
    cur = inner;
  }
  return cur;
}

/**
 * Python RE_DEC_OFF terminator: a DECIMAL offset must be followed (after
 * whitespace) by `)`/`,`/`;`/`]`. Hex offsets (RE_HEX_OFF) need no
 * terminator. Applied to both `+` and `-` offsets (the CST's `-` support is a
 * documented superset of Python, but keeps the same terminator rule so
 * `(char*)p - 4` mid-expression never fires anywhere).
 */
const DEC_TERMINATORS: ReadonlySet<string> = new Set([")", ",", ";", "]"]);
function decimalOffsetHasTerminator(node: SyntaxNode, source: string): boolean {
  const text = nodeText(node, source).trim();
  if (/^0[xX]/.test(text)) return true; // RE_HEX_OFF: un-terminated
  let i = node.endIndex;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  return i < source.length && DEC_TERMINATORS.has(source[i]!);
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

/** The `type_descriptor` of a C-style `cast_expression`, if any. */
function castTypeDescriptor(cast: SyntaxNode): SyntaxNode | null {
  const td = cast.namedChildren[0];
  return td !== undefined && td.type === "type_descriptor" ? td : null;
}

/**
 * Deepest name inside a declarator, in child order. Accepts plain
 * `identifier` plus `field_identifier` (member function/field names in class
 * bodies). Safe for declarators: the name sits in the type-name position,
 * and for `function_declarator` the parameter list is never reached first.
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

/** Node types that can own a declarator (locals, params, fields, typedefs, returns). */
const DECL_CONTEXTS: ReadonlySet<string> = new Set([
  "declaration",
  "parameter_declaration",
  "field_declaration",
  "type_definition",
  "function_definition",
]);

/** Node types that contribute to a declaration's base type text. */
const TYPE_NODE_TYPES: ReadonlySet<string> = new Set([
  "primitive_type",
  "type_identifier",
  "qualified_identifier",
  "type_qualifier",
  "sized_type_specifier",
  "struct_specifier",
  "class_specifier",
  "union_specifier",
  "enum_specifier",
  "template_type",
  "placeholder_type_specifier",
]);

/**
 * Nearest declaration-ish ancestor of a declarator node, or null. Skips
 * wrapper nodes (`init_declarator`, `parenthesized_declarator`).
 */
function declContext(node: SyntaxNode): SyntaxNode | null {
  let cur = node.parent;
  while (cur !== null) {
    if (DECL_CONTEXTS.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Base-type text of `node`'s declaration: the type tokens before the child
 * that contains `node` in its declaration context, whitespace-collapsed.
 * E.g. `void** q = p;` → `"void"`, `volatile u8 sp[0x100];` → `"volatile u8"`.
 */
function typeTextBefore(node: SyntaxNode, source: string): string {
  const ctx = declContext(node);
  if (ctx === null) return "";
  const parts: string[] = [];
  for (const child of ctx.namedChildren) {
    if (child.startIndex <= node.startIndex && node.endIndex <= child.endIndex) break;
    if (TYPE_NODE_TYPES.has(child.type)) parts.push(nodeText(child, source));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Leading storage/qualifier keywords stripped, whitespace collapsed. */
const LEADING_QUALIFIER_RE = /^(?:const|volatile|register|static|extern|inline|mutable|signed|unsigned)\b\s*/;
function normalizedBase(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  let prev: string;
  do {
    prev = t;
    t = t.replace(LEADING_QUALIFIER_RE, "");
  } while (t !== prev);
  return t;
}

/** Declarator text of a declaration/definition (function name, variable…). */
function declaratorText(node: SyntaxNode, source: string): string {
  const DECLARATOR_TYPES: ReadonlySet<string> = new Set([
    "function_declarator",
    "function_pointer",
    "identifier",
    "init_declarator",
    "pointer_declarator",
    "array_declarator",
    "reference_declarator",
    "parenthesized_declarator",
    "template_function",
  ]);
  for (const child of node.namedChildren) {
    if (DECLARATOR_TYPES.has(child.type)) return nodeText(child, source);
  }
  return nodeText(node, source);
}

/** Base text of a type descriptor before its first `*`, whitespace-collapsed. */
function baseOfType(typeText: string): string {
  const star = typeText.indexOf("*");
  return (star >= 0 ? typeText.slice(0, star) : typeText).replace(/\s+/g, " ").trim();
}

/** True when a type-descriptor text is a pointer (`T*`). */
function isPointerText(typeText: string): boolean {
  return typeText.includes("*");
}

/** True for integer/hex number literals (`4`, `0x10`); excludes floats/char. */
function isIntNumber(node: SyntaxNode, source: string): boolean {
  return (
    node.type === "number_literal" &&
    /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(nodeText(node, source).trim())
  );
}

/** Snip a node's source text into a single-line snippet (pointer.ts style). */
function snippetOf(node: SyntaxNode, source: string): string {
  return nodeText(node, source).trim().replace(/\s+/g, " ").slice(0, 100);
}

/** Build a Finding for a node with the given rule id and message. */
function findingOf(node: SyntaxNode, source: string, rule: string, message: string): Finding {
  const loc = nodeLoc(node);
  return {
    rule,
    line: loc.line,
    column: loc.column,
    snippet: snippetOf(node, source),
    message,
  };
}

/* ------------------------------------------------------------------ *
 * Line-level fallback (text rules; mirrors smell_scan.py regexes)
 * ------------------------------------------------------------------ */

/** A text-level hit: 1-indexed line/column plus the matched line. */
interface LineHit {
  line: number;
  column: number;
  text: string;
}

/** Split like Python `str.splitlines()` for practical purposes. */
function splitlines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/**
 * One hit per line where `re` matches the comment-stripped line (Python's
 * `raw.split("//", 1)[0]`). `re` must be non-global.
 */
function lineRegexHits(source: string, re: RegExp): LineHit[] {
  const hits: LineHit[] = [];
  splitlines(source).forEach((raw, i) => {
    const text = raw.split("//")[0] ?? raw;
    const m = re.exec(text);
    if (m !== null && m[0].length > 0) {
      hits.push({ line: i + 1, column: m.index + 1, text: text.trim() });
    }
  });
  return hits;
}

/**
 * Hits of a global regex over the raw source text (no comment stripping,
 * may cross lines) — used by init_side_effect, Python parity.
 */
function rawTextHits(source: string, re: RegExp): LineHit[] {
  const hits: LineHit[] = [];
  for (const m of source.matchAll(re)) {
    const prefix = source.slice(0, m.index);
    const line = prefix.split(/\r\n|\n|\r/).length;
    const lastNl = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
    hits.push({ line, column: m.index - lastNl, text: m[0].trim() });
  }
  return hits;
}

/** Convert a LineHit into a Finding. */
function hitFinding(hit: LineHit, rule: string, message: string): Finding {
  return {
    rule,
    line: hit.line,
    column: hit.column,
    snippet: hit.text.slice(0, 100),
    message,
  };
}

/* ------------------------------------------------------------------ *
 * smell.extern_c — extern "C" block split (lbl/nonlbl-decl/nonlbl-def/other)
 * ------------------------------------------------------------------ */

type ExternCKind = "lbl" | "nonlbl-decl" | "nonlbl-def" | "other";

/**
 * Declared name contains a `lbl_`-prefixed token (decomp label, legitimately
 * C-linkage). UN-ANCHORED on purpose: Python's RE_LBL (`\blbl_eu_\w+|(?:^|\s)lbl_…`)
 * matches anywhere in the line, and the anchored form misses function-pointer
 * declarators like `void (*lbl_fp)(void)`, whose declarator text is
 * `(*lbl_fp)(void)`.
 */
const LBL_NAME_RE = /\blbl_[A-Za-z0-9_]+/;

const EXTERN_C_KIND_HINTS: Record<ExternCKind, string> = {
  lbl: "lbl_* symbol — expected (decomp label needs C linkage)",
  "nonlbl-decl": "non-label declaration inside extern \"C\" — prefer C++ linkage",
  "nonlbl-def": "non-label definition inside extern \"C\" — should not be C-linkage",
  other: "other construct inside extern \"C\" — review",
};

/** Declarations a linkage specification can contain. */
const EXTERN_C_DECL_TYPES: ReadonlySet<string> = new Set([
  "declaration",
  "function_definition",
  "type_definition",
  "template_declaration",
]);

/** `extern "C" { … }` / `extern "C" void f(void);` — per-declaration split. */
function collectExternC(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const spec of descendants(root, "linkage_specification")) {
    const str = spec.namedChildren.find((c) => c.type === "string_literal");
    if (str === undefined || nodeText(str, source) !== '"C"') continue;
    let decls: SyntaxNode[] = [];
    for (const child of spec.namedChildren) {
      if (child.type === "declaration_list") decls = child.namedChildren;
    }
    if (decls.length === 0) {
      decls = spec.namedChildren.filter((c) => EXTERN_C_DECL_TYPES.has(c.type));
    }
    for (const decl of decls) {
      if (!EXTERN_C_DECL_TYPES.has(decl.type)) continue;
      const dtext = declaratorText(decl, source);
      let kind: ExternCKind;
      if (LBL_NAME_RE.test(dtext)) {
        kind = "lbl";
      } else if (decl.type === "function_definition" || descendants(decl, "function_definition").length > 0) {
        kind = "nonlbl-def";
      } else if (descendants(decl, "function_declarator").length > 0) {
        kind = "nonlbl-decl";
      } else {
        kind = "other";
      }
      out.push(
        findingOf(
          decl,
          source,
          "smell.extern_c",
          `extern "C" ${kind} '${dtext.trim().replace(/\s+/g, " ").slice(0, 80)}' ` +
            `(kind=${kind}) — ${EXTERN_C_KIND_HINTS[kind]}`,
        ),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * smell.self_param / smell.rn_params — params named self / r3..r31
 * ------------------------------------------------------------------ */

/** Declarator-ish children of a parameter declaration (last one is the name). */
const PARAM_DECLARATOR_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "init_declarator",
  "pointer_declarator",
  "array_declarator",
  "reference_declarator",
  "parenthesized_declarator",
]);

/** The parameter's declared name, or null. */
function parameterName(param: SyntaxNode, source: string): string | null {
  for (let i = param.namedChildren.length - 1; i >= 0; i--) {
    const child = param.namedChildren[i]!;
    if (PARAM_DECLARATOR_TYPES.has(child.type)) {
      return leafIdentifier(child, source);
    }
  }
  return null;
}

/** r3..r31 (register-named params — fake ABI registers). */
const RN_NAMES: ReadonlySet<string> = new Set(
  Array.from({ length: 29 }, (_, i) => `r${i + 3}`),
);

function collectSelfParam(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const param of descendants(root, "parameter_declaration")) {
    if (parameterName(param, source) !== "self") continue;
    out.push(
      findingOf(
        param,
        source,
        "smell.self_param",
        "parameter 'self' (fake-this) — free function should be a member function",
      ),
    );
  }
  return out;
}

function collectRnParams(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const param of descendants(root, "parameter_declaration")) {
    const name = parameterName(param, source);
    if (name === null || !RN_NAMES.has(name)) continue;
    out.push(
      findingOf(
        param,
        source,
        "smell.rn_params",
        `parameter '${name}' — register-named parameter (fake ABI register)`,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * smell.self_access — `self->` member-style access on a free function
 * ------------------------------------------------------------------ */

function collectSelfAccess(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const fe of descendants(root, "field_expression")) {
    const base = fe.namedChildren[0];
    if (base === undefined || base.type !== "identifier" || nodeText(base, source) !== "self") {
      continue;
    }
    let arrow = false;
    for (const child of fe.children) {
      if (!child.isNamed && nodeText(child, source) === "->") {
        arrow = true;
        break;
      }
    }
    if (!arrow) continue;
    out.push(
      findingOf(
        fe,
        source,
        "smell.self_access",
        `'${snippetOf(fe, source)}' member-style access on self — should be a member function`,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * smell.void_ptr / smell.void_ptr_cast
 * ------------------------------------------------------------------ */

/** Innermost named `T*` declarator whose base type is `void`. */
function collectVoidPtr(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const pd of descendants(root, "pointer_declarator")) {
    if (pd.namedChildren.some((c) => c.type === "pointer_declarator")) continue; // not innermost
    if (normalizedBase(typeTextBefore(pd, source)) !== "void") continue;
    const leaf = leafIdentifier(pd, source) ?? snippetOf(pd, source);
    out.push(
      findingOf(
        pd,
        source,
        "smell.void_ptr",
        `void* declarator '${leaf}' — untyped pointer; prefer a typed pointer`,
      ),
    );
  }
  return out;
}

/** C-style cast to `void*` (not static_cast / reinterpret_cast). */
function collectVoidPtrCast(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const cast of descendants(root, "cast_expression")) {
    const td = castTypeDescriptor(cast);
    if (td === null) continue;
    const text = nodeText(td, source).trim();
    if (!/^void\s*\*/.test(text)) continue;
    out.push(
      findingOf(cast, source, "smell.void_ptr_cast", `cast to '${text}' — discards pointer typing`),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * smell.ptr_arith — scalar-pointer cast + `+`/`-` + integer/hex literal
 * ------------------------------------------------------------------ */

/** Python RE_CAST scalar base types (case-sensitive, exact). */
const SCALAR_BASES: ReadonlySet<string> = new Set([
  "char",
  "u8",
  "u16",
  "u32",
  "s8",
  "s16",
  "s32",
  "int",
  "short",
  "long",
  "float",
  "u64",
]);

/** Cast target is a pointer whose base is a Python RE_CAST scalar type. */
function scalarPointerCastText(cast: SyntaxNode, source: string): string | null {
  const td = castTypeDescriptor(cast);
  if (td === null) return null;
  const text = nodeText(td, source).trim();
  if (!isPointerText(text)) return null;
  return SCALAR_BASES.has(baseOfType(text)) ? text : null;
}

/** A candidate ptr_arith finding before intra-rule overlap suppression. */
interface ArithMatch {
  node: SyntaxNode;
  offset: string;
  target: string;
}

/**
 * `(char*)p + 4` / `(u32*)(p + 0x10)` — scalar-pointer cast arithmetic.
 * Form A (binary with cast on the left, literal on the right) is collected
 * first; Form B (cast whose parenthesized value is such a binary) is kept
 * only when it does not overlap an already-kept match, so one construct
 * yields one finding (Python counts one per line).
 */
function collectPtrArith(root: SyntaxNode, source: string): Finding[] {
  const kept: ArithMatch[] = [];
  // Form A.
  for (const bin of descendants(root, "binary_expression")) {
    if (binaryOperator(bin, source) === null) continue;
    const left = unwrapParens(bin.namedChildren[0]!);
    const target = scalarPointerCastText(left, source);
    if (target === null) continue;
    const right = unwrapParens(bin.namedChildren[1]!);
    if (!isIntNumber(right, source)) continue;
    if (!decimalOffsetHasTerminator(right, source)) continue;
    kept.push({ node: bin, offset: nodeText(right, source).trim(), target });
  }
  // Form B.
  for (const cast of descendants(root, "cast_expression")) {
    const target = scalarPointerCastText(cast, source);
    if (target === null) continue;
    const value = unwrapParens(cast.namedChildren[1]!);
    if (value.type !== "binary_expression" || binaryOperator(value, source) === null) continue;
    const l = unwrapParens(value.namedChildren[0]!);
    const r = unwrapParens(value.namedChildren[1]!);
    const lit = isIntNumber(l, source) ? l : isIntNumber(r, source) ? r : null;
    if (lit === null) continue;
    if (!decimalOffsetHasTerminator(lit, source)) continue;
    const overlaps = kept.some(
      (k) => cast.startIndex < k.node.endIndex && k.node.startIndex < cast.endIndex,
    );
    if (overlaps) continue;
    kept.push({ node: cast, offset: nodeText(lit, source).trim(), target });
  }
  return kept.map((m) =>
    findingOf(
      m.node,
      source,
      "smell.ptr_arith",
      `pointer arithmetic via scalar cast (target ${m.target}, offset ${m.offset}) — ` +
        `manual field access; use struct fields`,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * smell.deref_arith — `*(T*)((scalar-cast)… + …)` deref of a pointer cast
 * whose value is `+`-arithmetic over an inner scalar cast (Python
 * RE_DEREF_ARITH semantics).
 * ------------------------------------------------------------------ */

/** Cast target is a single-word-base pointer (Python `\w+\s*\*`). */
function singleWordPointerCastText(cast: SyntaxNode, source: string): string | null {
  const td = castTypeDescriptor(cast);
  if (td === null) return null;
  const text = nodeText(td, source).trim();
  if (!isPointerText(text)) return null;
  return /^[A-Za-z_]\w*$/.test(baseOfType(text)) ? text : null;
}

/**
 * Python RE_DEREF_ARITH enumerated inner-cast bases (exact, case-sensitive,
 * with or without a trailing `*`).
 */
const DEREF_SCALAR_BASES: ReadonlySet<string> = new Set([
  "char",
  "u8",
  "u16",
  "u32",
  "u64",
  "int",
  "s8",
  "s16",
  "s32",
  "s64",
  "float",
  "double",
]);

/**
 * Cast target is a scalar cast with a DEREF_SCALAR_BASES base (with or
 * without a trailing `*`), mirroring Python's `\(?\s*<scalar>\s*\*?\s*\)?`.
 */
function scalarCastText(cast: SyntaxNode, source: string): string | null {
  const td = castTypeDescriptor(cast);
  if (td === null) return null;
  const text = nodeText(td, source).trim();
  const star = text.indexOf("*");
  const base = (star >= 0 ? text.slice(0, star) : text).replace(/\s+/g, " ").trim();
  return DEREF_SCALAR_BASES.has(base) ? text : null;
}

/**
 * Leftmost operand of a binary chain, unwrapping parens — the region Python's
 * `[^)]*` allows between the outer `(` and the `+`. Returns the cast when the
 * left side (possibly nested `+` chains) bottoms out in one, else null.
 */
function leftmostCast(node: SyntaxNode): SyntaxNode | null {
  let cur = unwrapParens(node);
  for (let depth = 0; depth < 4; depth++) {
    if (cur.type === "cast_expression") return cur;
    if (cur.type !== "binary_expression") return null;
    const left = cur.namedChildren[0];
    if (left === undefined) return null;
    cur = unwrapParens(left);
  }
  return null;
}

/**
 * `*(u32*)((char*)p + 0x10)` — deref of a pointer cast whose value is a
 * `+`-only binary with an inner scalar cast. Ports Python's RE_DEREF_ARITH:
 * the inner scalar cast is REQUIRED, its base must be in the enumerated set,
 * and only `+` fires (`-` offsets and bare bases never fire).
 */
function collectDerefArith(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const pe of descendants(root, "pointer_expression")) {
    const cast = pe.namedChildren[0];
    if (cast === undefined || cast.type !== "cast_expression") continue;
    const target = singleWordPointerCastText(cast, source);
    if (target === null) continue;
    const value = unwrapParens(cast.namedChildren[1]!);
    if (value.type !== "binary_expression") continue;
    if (binaryOperator(value, source) !== "+") continue; // `+`-only (Python)
    const inner = leftmostCast(value.namedChildren[0]!);
    const innerText = inner === null ? null : scalarCastText(inner, source);
    if (inner === null || innerText === null) continue;
    out.push(
      findingOf(
        pe,
        source,
        "smell.deref_arith",
        `deref of pointer cast with scalar-cast offset arithmetic ` +
          `(target ${target}, scalar ${innerText}) — manual field access; use struct fields`,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * smell.asm_code — inline asm / register keyword (one finding per line)
 * ------------------------------------------------------------------ */

const ASM_FALLBACK_RE = /\b(?:__asm|asm)\b|\bregister\b/;

function collectAsmCode(root: SyntaxNode, source: string): Finding[] {
  const byLine = new Map<number, LineHit>();
  const addNode = (node: SyntaxNode): void => {
    const loc = nodeLoc(node);
    if (!byLine.has(loc.line)) {
      byLine.set(loc.line, {
        line: loc.line,
        column: loc.column,
        text: snippetOf(node, source),
      });
    }
  };
  for (const g of descendants(root, "gnu_asm_expression")) addNode(g);
  for (const sc of descendants(root, "storage_class_specifier")) {
    if (nodeText(sc, source) === "register") addNode(sc);
  }
  // Text fallback: MWCC `asm { }`, `asm void f(…)` and `ASM(…)` bodies are
  // tree-sitter ERROR nodes; Python counts the line via `\basm\b|__asm|\bregister\b`.
  for (const hit of lineRegexHits(source, ASM_FALLBACK_RE)) {
    if (!byLine.has(hit.line)) byLine.set(hit.line, hit);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, hit]) =>
      hitFinding(hit, "smell.asm_code", "inline asm or register binding (asm_code)"),
    );
}

/* ------------------------------------------------------------------ *
 * smell.fake_stack — volatile byte arrays / sp/stack arrays
 * ------------------------------------------------------------------ */

const FAKE_STACK_NAME_RE = /^(?:sp|stack)\d*$/;

function collectFakeStack(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const ad of descendants(root, "array_declarator")) {
    const name = leafIdentifier(ad, source);
    const typeText = typeTextBefore(ad, source);
    const base = normalizedBase(typeText);
    if (base !== "u8" && base !== "char") continue;
    const isVolatile = /\bvolatile\b/.test(typeText);
    const isSpStack = name !== null && FAKE_STACK_NAME_RE.test(name);
    if (!isVolatile && !isSpStack) continue;
    out.push(
      findingOf(
        ad,
        source,
        "smell.fake_stack",
        `fake stack array '${name ?? "?"}' (${base}${isVolatile ? ", volatile" : ""}) — ` +
          `manual stack frame; use a real stack allocation`,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * smell.goto_count
 * ------------------------------------------------------------------ */

function collectGotoCount(root: SyntaxNode, source: string): Finding[] {
  return descendants(root, "goto_statement").map((g) =>
    findingOf(g, source, "smell.goto_count", "goto statement — control-flow smell"),
  );
}

/* ------------------------------------------------------------------ *
 * smell.class_in_cpp / smell.struct_in_cpp — definitions with bodies
 * ------------------------------------------------------------------ */

/** Class/struct *definition* (body present) inside a .cpp TU. */
function collectSpecifiers(
  root: SyntaxNode,
  source: string,
  specType: "class_specifier" | "struct_specifier",
  rule: string,
  keyword: string,
): Finding[] {
  const out: Finding[] = [];
  for (const spec of descendants(root, specType)) {
    if (!spec.namedChildren.some((c) => c.type === "field_declaration_list")) continue;
    const nameNode = spec.namedChildren.find((c) => c.type === "type_identifier");
    const name = nameNode === undefined ? "(anonymous)" : nodeText(nameNode, source);
    out.push(
      findingOf(
        spec,
        source,
        rule,
        `${keyword} '${name}' defined with a body in a .cpp TU — move to a header`,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * smell.fake_array_access — constant index on a non-array identifier
 * ------------------------------------------------------------------ */

/**
 * Same-TU heuristic: a subscript with a constant index (number/char literal)
 * on a plain identifier that is never declared via an `array_declarator`
 * anywhere in the TU. Member bases (`obj->arr[i]`) and deref bases cannot be
 * resolved without type info and are skipped.
 */
function collectFakeArrayAccess(root: SyntaxNode, source: string): Finding[] {
  const arrayDeclared = new Set<string>();
  for (const ad of descendants(root, "array_declarator")) {
    const id = leafIdentifier(ad, source);
    if (id !== null) arrayDeclared.add(id);
  }
  const out: Finding[] = [];
  for (const sub of descendants(root, "subscript_expression")) {
    const argList = sub.namedChildren[1];
    if (argList === undefined || argList.type !== "subscript_argument_list") continue;
    const idx = argList.namedChildren[0];
    if (idx === undefined || (idx.type !== "number_literal" && idx.type !== "char_literal")) {
      continue;
    }
    const base = unwrapParens(sub.namedChildren[0]!);
    if (base.type !== "identifier") continue;
    const name = nodeText(base, source);
    if (arrayDeclared.has(name)) continue;
    out.push(
      findingOf(
        sub,
        source,
        "smell.fake_array_access",
        `constant index on non-array '${name}' — fake array access`,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * smell.vtable_wrapper — ((Fn**)(*(u32*)obj))[i]
 * ------------------------------------------------------------------ */

/** Integer-ish pointer bases for the inner vtable deref cast. */
const VTABLE_INT_BASES: ReadonlySet<string> = new Set([
  "u32",
  "s32",
  "int",
  "uint",
  "unsigned int",
  "uintptr_t",
]);

/**
 * `((Fn**)(*(u32*)obj))[i]` — C-style cast to a pointer-to-pointer, deref of
 * an integer-pointer cast, subscripted. Matches the SPEC §13.1 pattern; the
 * `(*reinterpret_cast<T**>(obj))[i]` variant is not covered (documented).
 */
function collectVtableWrapper(root: SyntaxNode, source: string): Finding[] {
  const out: Finding[] = [];
  for (const sub of descendants(root, "subscript_expression")) {
    const base = unwrapParens(sub.namedChildren[0]!);
    if (base.type !== "cast_expression") continue;
    const outerTd = castTypeDescriptor(base);
    if (outerTd === null) continue;
    const outerText = nodeText(outerTd, source).replace(/\s+/g, "");
    if (!outerText.includes("**")) continue;
    const value = unwrapParens(base.namedChildren[1]!);
    if (value.type !== "pointer_expression") continue;
    const innerCast = unwrapParens(value.namedChildren[0]!);
    if (innerCast.type !== "cast_expression") continue;
    const innerTd = castTypeDescriptor(innerCast);
    if (innerTd === null) continue;
    const innerText = nodeText(innerTd, source).trim();
    if (!isPointerText(innerText)) continue;
    if (!VTABLE_INT_BASES.has(baseOfType(innerText).toLowerCase())) continue;
    out.push(
      findingOf(
        sub,
        source,
        "smell.vtable_wrapper",
        `vtable-wrapper pattern ((T**)(*(int*)obj))[i] — manual vtable dispatch`,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Text-only rules (line-level fallback)
 * ------------------------------------------------------------------ */

const DECOMP_MACRO_RE = /DECOMP_(?:PPC|FORCELITERAL|FORCEACTIVE)/;
const PRAGMA_RE = /^\s*#\s*pragma/;
const ASM_INSN_SHIM_RE = /\bDECOMP_ASM_INSN_BEGIN\b/;
const SCHEDULE_PRAGMA_RE = /^\s*#\s*pragma\s+schedule\b/;
const IF0_RE = /^\s*#\s*if\s+0/;
const INIT_SIDE_EFFECT_RE = /(?:reinterpret_cast|static_cast)\s*<[^>]+>\s*\([^()]*\w\s*=(?!=)/g;

function textRule(
  id: string,
  description: string,
  re: RegExp,
  message: string,
  raw = false,
): SourceRule {
  return {
    id,
    description,
    run: (_root, source) =>
      (raw ? rawTextHits(source, re) : lineRegexHits(source, re)).map((hit) =>
        hitFinding(hit, id, message),
      ),
  };
}

/* ------------------------------------------------------------------ *
 * smell.define_rename_alias — retail placeholder renamed via #define
 * ------------------------------------------------------------------ */

/**
 * Configurable placeholder families used to recognize retail symbol names
 * (SPEC §B). Empty-source patterns (e.g. an adapter declaring `label: ""`)
 * are treated as absent — `new RegExp("")` would otherwise match every
 * name (its source is `(?:)`).
 */
function activePlaceholderPatterns(patterns: {
  function?: RegExp;
  label?: RegExp;
  data?: RegExp;
}): RegExp[] {
  return [patterns.function, patterns.label, patterns.data].filter(
    (p): p is RegExp => p !== undefined && p.source !== "(?:)",
  );
}

/** True when `name` matches at least one of the active placeholder patterns. */
function matchesPlaceholder(name: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    p.lastIndex = 0; // defensive: a global pattern must not skip matches
    if (p.test(name)) return true;
  }
  return false;
}

/**
 * Normalize a `preproc_arg` replacement body to a plain C identifier, or
 * null when it is not one. Trailing `//` and block comments are stripped
 * (tree-sitter includes them in `preproc_arg` text); casts
 * (`(u32*)0x80000000`), numbers (`42`), and empty bodies are rejected.
 */
function replacementIdentifier(arg: SyntaxNode, source: string): string | null {
  const stripped = nodeText(arg, source)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/g, " ")
    .trim();
  return /^[A-Za-z_]\w*$/.test(stripped) ? stripped : null;
}

/**
 * Names `#undef`-ed anywhere in the file. There is no dedicated
 * `preproc_undef` node in this grammar — `#undef` is a `preproc_call`
 * whose `preproc_directive` text is `#undef`.
 */
function undefNames(root: SyntaxNode, source: string): Set<string> {
  const names = new Set<string>();
  for (const call of descendants(root, "preproc_call")) {
    const directive = call.namedChildren.find((c) => c.type === "preproc_directive");
    if (directive === undefined || nodeText(directive, source).trim() !== "#undef") continue;
    const arg = call.namedChildren.find((c) => c.type === "preproc_arg");
    if (arg === undefined) continue;
    const name = nodeText(arg, source)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/g, " ")
      .trim();
    if (name.length > 0) names.add(name);
  }
  return names;
}

/**
 * SPEC §B: one finding per `preproc_def` whose name matches a placeholder
 * family (function/label/data) and whose replacement is a plain
 * non-placeholder identifier — the retail symbol was renamed via a
 * `#define` alias instead of in the source/symbols. The message is
 * annotated ` (alias block)` when a matching `#undef` for the same name
 * exists anywhere in the file. Placeholder→placeholder aliases (incl.
 * cross-family) and plain `#define`s with no placeholder name are
 * non-goals. Config-dependent, so it is a factory, not a static entry in
 * `smellRules`; `lintFile` injects the compiled placeholder patterns.
 */
export function makeDefineRenameAliasRule(patterns: {
  function?: RegExp;
  label?: RegExp;
  data?: RegExp;
}): SourceRule {
  return {
    id: "smell.define_rename_alias",
    description:
      "retail placeholder (function/label/data) renamed via #define alias",
    run: (root, source) => {
      const active = activePlaceholderPatterns(patterns);
      if (active.length === 0) return [];
      const undef = undefNames(root, source);
      const out: Finding[] = [];
      for (const def of descendants(root, "preproc_def")) {
        const nameNode = def.namedChildren.find((c) => c.type === "identifier");
        if (nameNode === undefined) continue;
        const name = nodeText(nameNode, source);
        if (!matchesPlaceholder(name, active)) continue;
        const arg = def.namedChildren.find((c) => c.type === "preproc_arg");
        if (arg === undefined) continue; // no replacement body
        const body = replacementIdentifier(arg, source);
        if (body === null) continue;
        if (matchesPlaceholder(body, active)) continue; // placeholder→placeholder
        out.push(
          findingOf(
            def,
            source,
            "smell.define_rename_alias",
            `retail symbol '${name}' renamed via #define alias — rename it in the source/symbols instead` +
              (undef.has(name) ? " (alias block)" : ""),
          ),
        );
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Registry — SPEC §13.1 order, ids stable.
 * ------------------------------------------------------------------ */

/**
 * The 21 smell-scan source rules (SPEC §13.1), port of
 * `tools/coop/smell_scan.py` + the SPEC additions. `smell.extern_c` carries
 * its lbl/nonlbl-decl/nonlbl-def/other split in the message as `kind=…`
 * (documented above); all other ids fire once per construct/line.
 */
export const smellRules: SourceRule[] = [
  {
    id: "smell.extern_c",
    description:
      "extern \"C\" declarations/definitions, split by kind " +
      "(kind=lbl|nonlbl-decl|nonlbl-def|other in the message)",
    run: collectExternC,
  },
  {
    id: "smell.self_param",
    description: "parameter named `self` (fake-this member style)",
    run: collectSelfParam,
  },
  {
    id: "smell.self_access",
    description: "`self->` member-style access",
    run: collectSelfAccess,
  },
  {
    id: "smell.void_ptr",
    description: "`void*` named declarator — untyped pointer",
    run: collectVoidPtr,
  },
  {
    id: "smell.void_ptr_cast",
    description: "C-style cast to `void*`",
    run: collectVoidPtrCast,
  },
  {
    id: "smell.ptr_arith",
    description: "scalar-pointer cast with numeric offset arithmetic",
    run: collectPtrArith,
  },
  {
    id: "smell.deref_arith",
    description: "deref of a pointer cast with an inner scalar cast and `+` arithmetic (Python RE_DEREF_ARITH)",
    run: collectDerefArith,
  },
  {
    id: "smell.asm_code",
    description: "inline asm / `register` keyword (one finding per line)",
    run: collectAsmCode,
  },
  {
    id: "smell.fake_stack",
    description: "volatile byte-array fake stack / sp|stack array",
    run: collectFakeStack,
  },
  {
    id: "smell.rn_params",
    description: "register-named parameter r3..r31 (fake ABI registers)",
    run: collectRnParams,
  },
  {
    id: "smell.goto_count",
    description: "goto statement",
    run: collectGotoCount,
  },
  textRule(
    "smell.decomp_macro",
    "DECOMP_* macro (PPC/FORCELITERAL/FORCEACTIVE)",
    DECOMP_MACRO_RE,
    "DECOMP_* macro usage",
  ),
  textRule("smell.pragma", "#pragma directive", PRAGMA_RE, "#pragma directive"),
  textRule(
    "smell.asm_insn_shim",
    "DECOMP_ASM_INSN_BEGIN single-instruction asm shim",
    ASM_INSN_SHIM_RE,
    "DECOMP_ASM_INSN_BEGIN — single-instruction asm shim",
  ),
  textRule(
    "smell.schedule_pragma",
    "#pragma schedule (MWCC scheduling knob)",
    SCHEDULE_PRAGMA_RE,
    "#pragma schedule — MWCC scheduling knob",
  ),
  textRule(
    "smell.init_side_effect",
    "assignment inside a reinterpret_cast/static_cast used as a value (may cross lines)",
    INIT_SIDE_EFFECT_RE,
    "assignment inside a cast used as a value — init-list choreography",
    true,
  ),
  textRule("smell.if0", "#if 0 block", IF0_RE, "#if 0 block"),
  {
    id: "smell.class_in_cpp",
    description: "class definition with a body in a .cpp TU",
    run: (root, source) =>
      collectSpecifiers(root, source, "class_specifier", "smell.class_in_cpp", "class"),
  },
  {
    id: "smell.struct_in_cpp",
    description: "struct definition with a body in a .cpp TU",
    run: (root, source) =>
      collectSpecifiers(root, source, "struct_specifier", "smell.struct_in_cpp", "struct"),
  },
  {
    id: "smell.fake_array_access",
    description: "constant index on a non-array identifier (same-TU heuristic)",
    run: collectFakeArrayAccess,
  },
  {
    id: "smell.vtable_wrapper",
    description: "manual vtable dispatch ((T**)(*(int*)obj))[i]",
    run: collectVtableWrapper,
  },
];
