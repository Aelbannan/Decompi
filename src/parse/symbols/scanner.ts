/**
 * M1b — extern "C" declaration scanner (src/parse/symbols/scanner.ts).
 *
 * Line-based port of the declaration extractor in `tools/coop/extc.py`
 * (`extract_entries` / `extern_c_defs_with_bodies` / `name_from` /
 * `logical_line` / `strip_comment`), which feeds {@link classifyExternC} so
 * the `unparsed` category is reachable (SPEC §13.3).
 *
 * The port is deliberately regex+state-machine oriented, NOT tree-sitter:
 * parity with the Python scanner is defined as entry-for-entry identical
 * output on the same input lines (see docs/m1b-parity.md), including the
 * reference's quirks — notably that a col-0 declaration line directly after a
 * multi-line definition is consumed by the definition's continuation scan and
 * never yields (verified against the frozen CTaskGameEvt.cpp fixture).
 */

/** One extracted extern "C" declaration. `name` is null when no name could be
 *  recovered from the body (`unparsed`); `body` is the declaration text with
 *  the `extern "C"` prefix removed. */
export interface ExtcEntry {
  name: string | null;
  kind: "decl";
  /** 1-based line number of the declaration (first line for multi-line). */
  lineno: number;
  /** the raw source line that started the declaration (trimmed). */
  raw: string;
  /** declaration body without the `extern "C"` prefix, comment-stripped. */
  body: string;
}

/** One extern "C" DEFINITION with a brace-balanced body. */
export interface ExtcDef {
  name: string;
  lineno: number;
  /** everything before the opening `{`, comment-stripped and trimmed. */
  header: string;
  /** the brace-balanced body text (leading `{` excluded, trailing `}` excluded). */
  body: string;
}

/** `extern "C"` marker (extc.py `RE_EXT_C`). */
const RE_EXT_C = /extern\s+"C"/;

/** `__declspec(...)` attribute (extc.py `RE_DECLSPEC`). */
const RE_DECLSPEC = /__declspec\s*\([^)]*\)/;

/** typedef/using prefixes are never decls (extc.py `RE_SKIP_DECL_PREFIX`). */
const RE_SKIP_DECL_PREFIX = /^(?:typedef|using)\b/;

/** function-name scan: `<name>(` (extc.py `RE_FUNC_NAME`). */
const RE_FUNC_NAME = /([A-Za-z_]\w*)\s*\(/;

/** pointer-to-function / pointer-to-member variable: the FIRST `(` carries
 *  `[Class::]* [cv] name )` (extc.py's inline regex in `name_from`). */
const RE_PTR_DECL =
  /^[^(\n]*\(\s*(?:[A-Za-z_]\w*\s*::\s*)?\*\s*(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)\s*\)/;

/** trailing attribute macro (`attr(...)` style), e.g. `noinline` macros. */
const RE_TRAILING_ATTR = /\s+[A-Z_][A-Z0-9_]*$/;

/** GCC `__attribute__((...))`. */
const RE_GCC_ATTR = /__attribute__\s*\(\([^)]*\)\)/;

/** trailing plain name (`<name>[ [N] ]` at end of body). */
const RE_TRAILING_NAME = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/;

/** self-style first parameter (extc.py `RE_SELF_FIRST`): `(T|void) * self`
 *  / `_this` / `p`. Shared with extc.ts via {@link hasSelfStyleParam}. */
export const RE_SELF_FIRST =
  /\(\s*(?:[A-Za-z_:<>]+|void)\s*\*\s*(?:self|_this|p)\b|\(\s*void\s*\*\s*self/;

/** `((Class* )self)` — the self-cast marker inside a definition body
 *  (extc.py `RE_CLASS_CAST`). */
export const RE_CLASS_CAST = /\(\(\s*([A-Za-z_]\w*)\s*\*+\s*\)\s*(?:self|_this)\s*\)/;

/** Strip `/* */` and `//` comments (extc.py `strip_comment`). */
export function stripComment(line: string): string {
  const noBlock = line.replace(/\/\*.*?\*\//g, " ");
  const i = noBlock.indexOf("//");
  return i >= 0 ? noBlock.slice(0, i) : noBlock;
}

function countBraces(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === "{") n++;
    else if (ch === "}") n--;
  }
  return n;
}

/**
 * Extract the declared symbol name from a decl body (no `extern "C"` prefix).
 * Port of extc.py `name_from`: pointer-to-function / pointer-to-member first,
 * then a trailing function-call `name(`, then a trailing plain name.
 */
export function nameFrom(body: string): string | null {
  let b = body.replace(RE_DECLSPEC, "").trim().replace(/;$/, "").trim();
  b = b.replace(RE_TRAILING_ATTR, "").trim();
  b = b.replace(RE_GCC_ATTR, "").trim();
  const pm = RE_PTR_DECL.exec(b);
  if (pm !== null) {
    return pm[1]!;
  }
  if (b.endsWith(")")) {
    const m = RE_FUNC_NAME.exec(b);
    return m !== null ? m[1]! : null;
  }
  const m = RE_TRAILING_NAME.exec(b);
  return m !== null ? m[1]! : null;
}

/** Does the declaration body use a self-style first parameter (`T* self` /
 *  `void* self` / `_this` / `p`)? Port of extc.py `RE_SELF_FIRST` search. */
export function hasSelfStyleParam(body: string): boolean {
  return RE_SELF_FIRST.test(body);
}

/**
 * Join continuation lines starting at index `i`. Returns the joined text, the
 * last consumed index, and whether the statement is a definition (`{` seen).
 * Port of extc.py `logical_line` — including the col-0 break rule: a line
 * that starts at column 0 and is not a backslash/comma continuation ends the
 * statement, and is NOT consumed by this scan.
 */
function logicalLine(
  lines: string[],
  i: number
): { text: string; end: number; isDef: boolean } {
  const parts: string[] = [stripComment(lines[i]!).trim()];
  let depth = countBraces(parts[0]!);
  let j = i;
  while (
    !parts[parts.length - 1]!.trimEnd().endsWith(";") &&
    depth <= 0 &&
    j - i < 8
  ) {
    j += 1;
    if (j >= lines.length) {
      break;
    }
    const raw = lines[j]!;
    const ln = stripComment(raw).trim();
    if (!ln || ln.startsWith("#")) {
      continue;
    }
    const last = parts[parts.length - 1]!.trimEnd();
    if (!raw.startsWith(" ") && !raw.startsWith("\t") && !/(\\|,)$/.test(last)) {
      break; // col-0 line is a fresh statement, not a continuation
    }
    parts.push(ln);
    depth += countBraces(ln);
  }
  const text = parts.join(" ");
  return { text, end: j, isDef: text.includes("{") };
}

/**
 * Extract (name, lineno, raw, body) for every extern "C" declaration. Port of
 * extc.py `extract_entries` — the single-line path, the continuation path
 * (`logical_line`) and the true `extern "C" { … }` block path all mirror the
 * reference, including its quirks (col-0 line after a definition is consumed
 * and lost; block bodies are depth-tracked). Entries are yielded in source
 * order; `name` may be null (unparsed).
 */
export function extractEntries(lines: string[]): ExtcEntry[] {
  const out: ExtcEntry[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = stripComment(lines[i]!).trim();
    if (!line) {
      i += 1;
      continue;
    }
    const hasExt = RE_EXT_C.test(line);
    const rest0 = line.replace(RE_EXT_C, "").trim();
    if (hasExt && rest0 === "{") {
      // true `extern "C" {` block opener
      let depth = 0;
      let j = i;
      let first = true;
      let pending: string[] = [];
      let pendingLn = 0;
      let pendingRaw = "";
      while (j < n) {
        const lnRaw = lines[j]!;
        const ln = stripComment(lnRaw);
        const core = ln.replace(RE_EXT_C, "").trim();
        if (!first) {
          depth += countBraces(ln);
        }
        first = false;
        if (depth < 0) {
          break; // block close
        }
        if (depth !== 0) {
          j += 1;
          continue; // inside a definition body
        }
        if (pending.length > 0) {
          pending.push(core);
          if (pending[pending.length - 1]!.trimEnd().endsWith(";")) {
            const text = pending.join(" ");
            out.push({
              name: nameFrom(text),
              kind: "decl",
              lineno: pendingLn,
              raw: pendingRaw,
              body: text,
            });
            pending = [];
          }
          j += 1;
          continue;
        }
        if (core === "" || core.startsWith("}") || core.startsWith("#")) {
          j += 1;
          continue;
        }
        if (
          core.endsWith(";") &&
          !core.includes("{") &&
          !core.includes("=") &&
          !RE_SKIP_DECL_PREFIX.test(core)
        ) {
          out.push({
            name: nameFrom(core),
            kind: "decl",
            lineno: j + 1,
            raw: lnRaw.trim(),
            body: core,
          });
        } else if (
          !core.includes("{") &&
          !core.includes("=") &&
          !RE_SKIP_DECL_PREFIX.test(core)
        ) {
          pending = [core];
          pendingLn = j + 1;
          pendingRaw = lnRaw.trim();
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (!hasExt) {
      i += 1;
      continue;
    }
    const { text, end: j, isDef } = logicalLine(lines, i);
    if (isDef || !text.trimEnd().endsWith(";")) {
      i = j + 1;
      continue;
    }
    const body = text.replace(RE_EXT_C, "").trim();
    out.push({
      name: nameFrom(body),
      kind: "decl",
      lineno: i + 1,
      raw: lines[i]!.trim(),
      body,
    });
    i = j + 1;
  }
  return out;
}

/**
 * Extract extern "C" DEFINITIONS (with brace-balanced bodies) so the member-
 * conversion planner can inspect self-casts and params. Port of extc.py
 * `extern_c_defs_with_bodies`.
 */
export function externCDefsWithBodies(lines: string[]): ExtcDef[] {
  const out: ExtcDef[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = stripComment(lines[i]!).trim();
    if (!line || !RE_EXT_C.test(line)) {
      i += 1;
      continue;
    }
    const rest = line.replace(RE_EXT_C, "").trim();
    if (rest === "{" || !rest.includes("{")) {
      i += 1;
      continue;
    }
    const braceAt = rest.indexOf("{");
    const before = rest.slice(0, braceAt);
    const after = rest.slice(braceAt + 1);
    let depth = 1 + countBraces(after);
    const body: string[] = [after];
    let j = i;
    while (depth > 0 && j + 1 < n) {
      j += 1;
      const ln = stripComment(lines[j]!);
      depth += countBraces(ln);
      if (depth > 0) {
        body.push(ln);
      } else {
        const idx = ln.indexOf("}");
        body.push(idx >= 0 ? ln.slice(0, idx) : ln);
      }
    }
    const name = nameFrom(before.trim());
    if (name !== null) {
      out.push({
        name,
        lineno: i + 1,
        header: before.trim(),
        body: body.join(" "),
      });
    }
    i = j + 1;
  }
  return out;
}
