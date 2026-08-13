/**
 * M1a delta-lint gate (SPEC §13.2) — line-oriented, port of
 * `tools/pi_harness/lint.py` from the Xenoblade co-op fork.
 *
 * The gate operates on **added lines only** (difflib-equivalent opcodes in
 * TS, computed explicitly), with cross-line state (`cast_pending`), comment
 * stripping, and C-vs-C++ branching. It deliberately stays
 * line/regex+state-machine oriented: a CST cannot parse added lines in
 * isolation (SPEC §13.2).
 *
 * Rule semantics are a faithful port of lint.py, rule for rule, in the same
 * evaluation order. Each rule is a `DeltaRule`; `lintDelta` drives the shared
 * `deltaRules` registry over added lines in file order.
 *
 * Shared contract (`types.ts`, owned by another agent): `Finding` and
 * `DeltaRule` with `check(line: DeltaLine, ctx: DeltaCtx)`. `DeltaCtx` is a
 * minimal per-file bag (`sourcePath` + a generic `state` map); this module
 * extends it with the delta gate's typed cross-line state (`DeltaContext`).
 * Rules receive `line.text` — the comment-stripped added line — and read the
 * raw (comment-included) line via `ctx.raw`.
 *
 * Notable porting decisions:
 *  - **Diff**: lint.py uses `difflib.SequenceMatcher(autojunk=False)`, whose
 *    recursive longest-match decomposition is *not* globally LCS-optimal (it
 *    can split around one match and never compare a better cross-boundary
 *    match, leaving MORE lines marked added than an optimal diff would). We
 *    use a Myers O(ND) diff, which is globally LCS-optimal; the set of added
 *    lines can therefore differ from difflib on ambiguous inputs, which the
 *    SPEC explicitly allows ("a simple LCS/Myers diff is fine"). Rules are
 *    identical: verified against lint.py with 0 rule mismatches across a
 *    600-case random corpus on the lines both diffs agree are added.
 *  - **non_sjis_char**: Node has no Shift-JIS *encoder*, only a WHATWG
 *    `TextDecoder("shift_jis")`. Python's `shift_jis` codec (JIS X 0208:1997)
 *    and the WHATWG index differ on 8 + 2333 code points; we derive the
 *    WHATWG-decodable set at runtime and apply embedded corrections so the
 *    result matches `ch.encode("shift_jis")` for every BMP code point (see
 *    `PYTHON_ONLY_ADDS` / `NODE_ONLY_EXCLUDES`). Non-BMP code points never
 *    encode and are always flagged. If a Node build lacks the shift_jis ICU
 *    decoder, a documented minimal approximation is used instead.
 *  - **Finding field mapping**: lint.py's `LintViolation.detail` is
 *    `f"{why}: `{line.strip()[:100]}`"`; we split it into `message` (the
 *    `why`) and `snippet` (`line.strip().slice(0, 100)` of the raw added
 *    line). `column` is not set — lint.py computes no column information.
 *  - **Regex dialect**: `\s` follows JS semantics (a superset of Python's),
 *    which can only widen a match on exotic whitespace; anchors `^`/`$` match
 *    lint.py (no multiline flag).
 *
 * `tree.ts` / `types.ts` are owned by other agents.
 */
import type { DeltaCtx, DeltaRule, Finding } from "./types.js";

/* ------------------------------------------------------------------ *
 * Line diff (difflib-equivalent added lines)
 * ------------------------------------------------------------------ */

/** An added line: 1-indexed line number in the NEW text + content. */
export interface AddedLine {
  /** 1-indexed line number in the NEW text. */
  line: number;
  /** The added line's text, without its line terminator. */
  text: string;
}

/**
 * Python `str.splitlines()` equivalent: splits on universal line boundaries
 * (`\n`, `\r\n`, `\r`, `\v`, `\f`, U+001C-U+001E, U+0085, U+2028, U+2029)
 * and does NOT emit a trailing empty element for a final line break.
 * `""` → `[]` (matches Python).
 */
const LINE_BREAK_RE = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/g;

function splitlines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let start = 0;
  LINE_BREAK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINE_BREAK_RE.exec(text)) !== null) {
    lines.push(text.slice(start, m.index));
    start = m.index + m[0].length;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * Myers O(ND) diff over the UNIQUE middle (common prefix/suffix trimmed by
 * `computeAddedLines`) returning the **0-indexed NEW-line indices** covered
 * by `insert`/`replace` opcodes (i.e. new lines not matched to any old line
 * by the LCS). `oldLines.length === 0` ⇒ every new line is added.
 *
 * The trace (`v` per D step) costs O((n+m)²) memory in the worst case, which
 * is exactly why the caller trims the common prefix/suffix first: a large
 * rewrite that only touches the middle never runs Myers over the whole file.
 */
function myersAddedIndices(oldLines: string[], newLines: string[]): number[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return newLines.map((_, i) => i);
  if (m === 0) return [];
  const max = n + m;
  const offset = max + 1;
  const size = 2 * max + 3;
  let v = new Int32Array(size);
  v[offset + 1] = 0; // V[1] = 0: the empty-prefix snake start
  const trace: Int32Array[] = [];
  let foundD = -1;
  forward: for (let d = 0; d <= max; d++) {
    trace.push(v);
    const next = new Int32Array(size);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!; // vertical move (insert)
      } else {
        x = v[offset + k - 1]! + 1; // horizontal move (delete)
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break forward;
      }
    }
    v = next;
  }
  if (foundD < 0) return newLines.map((_, i) => i); // unreachable safety net

  // Backtrack along the recorded V states; equal snakes are skipped, the
  // single non-diagonal move of each step is classified.
  const added: number[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[offset + prevK]!;
    const prevY = prevX - prevK;
    // Start of the diagonal snake after the move.
    const mx = prevK === k + 1 ? prevX : prevX + 1;
    const my = prevK === k + 1 ? prevY + 1 : prevY;
    while (x > mx && y > my) {
      x--;
      y--;
    }
    if (prevK === k + 1) added.push(my - 1); // vertical move inserts new[my-1]
    x = prevX;
    y = prevY;
  }
  added.reverse();
  return added;
}

/**
 * 1-indexed NEW-file lines that are inserted or replaced (difflib
 * `insert`/`replace` opcodes). `oldText === null` ⇒ every line is added.
 *
 * The common prefix and suffix are trimmed before the Myers diff: unchanged
 * leading/trailing runs are matched directly, and only the middle is diffed.
 * This keeps the O((n+m)²) trace bounded on large rewrites that touch a small
 * middle (a 50k-line file with a 10-line edit never runs Myers over 50k
 * lines) and is exact — an LCS never uses a changed line outside the middle
 * anyway.
 */
export function computeAddedLines(
  oldText: string | null,
  newText: string,
): AddedLine[] {
  const newLines = splitlines(newText);
  if (oldText === null) {
    return newLines.map((text, i) => ({ line: i + 1, text }));
  }
  const oldLines = splitlines(oldText);
  const n = oldLines.length;
  const m = newLines.length;
  let start = 0;
  while (start < n && start < m && oldLines[start] === newLines[start]) start++;
  let endOld = n;
  let endNew = m;
  while (
    endOld > start &&
    endNew > start &&
    oldLines[endOld - 1] === newLines[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }
  if (start === m) return []; // new text is fully covered by the prefix
  if (start === n) {
    // Everything from `start` on is an insertion into the old file.
    return newLines.slice(start).map((text, i) => ({ line: start + i + 1, text }));
  }
  const mid = myersAddedIndices(oldLines.slice(start, endOld), newLines.slice(start, endNew));
  return mid.map((i) => ({ line: start + i + 1, text: newLines[start + i]! }));
}

/* ------------------------------------------------------------------ *
 * Line preprocessing
 * ------------------------------------------------------------------ */

/** Python `line.split("//", 1)[0]` equivalent (first `//` truncates). */
export function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx < 0 ? line : line.slice(0, idx);
}

/** True for C++ source/header files (mirrors lint.py `is_cpp`). */
export function isCpp(path: string): boolean {
  return /\.(?:cpp|cc|cxx|hpp|hh)$/.test(path);
}

/**
 * True for C source/header files: `.c`/`.h` are C (`extern "C"` is illegal
 * there), mirroring lint.py `is_c = endswith((".c", ".h")) and not is_cpp`.
 */
export function isC(path: string): boolean {
  return /\.(?:c|h)$/.test(path) && !isCpp(path);
}

/* ------------------------------------------------------------------ *
 * Shift-JIS round-trip check (non_sjis_char)
 * ------------------------------------------------------------------ */

/**
 * Python's `shift_jis` codec encodes these 8 BMP code points, but the WHATWG
 * shift_jis index (Node's `TextDecoder`) cannot produce any of them — the
 * JIS X 0208:1983→Unicode mappings that were remapped by the 1997 revision
 * (wave dash U+301C, double vertical line U+2016, overline U+203E, minus
 * U+2212, and the half-width roman ¢£¥¬).
 */
const PYTHON_ONLY_ADDS: ReadonlyArray<number> = [
  0x00a2, 0x00a3, 0x00a5, 0x00ac, 0x2016, 0x203e, 0x2212, 0x301c,
];

/**
 * Code points the WHATWG shift_jis index decodes but Python's `shift_jis`
 * codec rejects (JIS X 0208:1997-removed kanji/symbols — circled numbers
 * ①-⑳, №, ℡, squared unit symbols …, PUA U+E000-U+E757, compatibility
 * ideographs U+F929/U+F9DC/U+FA0E-U+FA2D, and the fullwidth " ' - ~).
 *
 * Table provenance: `nodeDecodable − pythonEncodable` where pythonEncodable
 * is `chr(cp).encode("shift_jis")` under CPython 3.13 and nodeDecodable is
 * every code point produced by `new TextDecoder("shift_jis", { fatal: true })`
 * over all valid single- and double-byte sequences (leads 0x81-0x9F/0xE0-0xFC,
 * trails 0x40-0x7E/0x80-0xFC). Regenerate by diffing those two sets.
 */
const NODE_ONLY_EXCLUDES: ReadonlyArray<readonly [number, number]> = [
  [0x2116, 0x2116],
  [0x2121, 0x2121],
  [0x2160, 0x2169],
  [0x2170, 0x2179],
  [0x2211, 0x2211],
  [0x221f, 0x221f],
  [0x2225, 0x2225],
  [0x222e, 0x222e],
  [0x22bf, 0x22bf],
  [0x2460, 0x2473],
  [0x301d, 0x301d],
  [0x301f, 0x301f],
  [0x3231, 0x3232],
  [0x3239, 0x3239],
  [0x32a4, 0x32a8],
  [0x3303, 0x3303],
  [0x330d, 0x330d],
  [0x3314, 0x3314],
  [0x3318, 0x3318],
  [0x3322, 0x3323],
  [0x3326, 0x3327],
  [0x332b, 0x332b],
  [0x3336, 0x3336],
  [0x333b, 0x333b],
  [0x3349, 0x334a],
  [0x334d, 0x334d],
  [0x3351, 0x3351],
  [0x3357, 0x3357],
  [0x337b, 0x337e],
  [0x338e, 0x338f],
  [0x339c, 0x339e],
  [0x33a1, 0x33a1],
  [0x33c4, 0x33c4],
  [0x33cd, 0x33cd],
  [0x4e28, 0x4e28],
  [0x4ee1, 0x4ee1],
  [0x4efc, 0x4efc],
  [0x4f00, 0x4f00],
  [0x4f03, 0x4f03],
  [0x4f39, 0x4f39],
  [0x4f56, 0x4f56],
  [0x4f8a, 0x4f8a],
  [0x4f92, 0x4f92],
  [0x4f94, 0x4f94],
  [0x4f9a, 0x4f9a],
  [0x4fc9, 0x4fc9],
  [0x4fcd, 0x4fcd],
  [0x4fff, 0x4fff],
  [0x501e, 0x501e],
  [0x5022, 0x5022],
  [0x5040, 0x5040],
  [0x5042, 0x5042],
  [0x5046, 0x5046],
  [0x5070, 0x5070],
  [0x5094, 0x5094],
  [0x50d8, 0x50d8],
  [0x50f4, 0x50f4],
  [0x514a, 0x514a],
  [0x5164, 0x5164],
  [0x519d, 0x519d],
  [0x51be, 0x51be],
  [0x51ec, 0x51ec],
  [0x5215, 0x5215],
  [0x529c, 0x529c],
  [0x52a6, 0x52a6],
  [0x52af, 0x52af],
  [0x52c0, 0x52c0],
  [0x52db, 0x52db],
  [0x5300, 0x5300],
  [0x5307, 0x5307],
  [0x5324, 0x5324],
  [0x5372, 0x5372],
  [0x5393, 0x5393],
  [0x53b2, 0x53b2],
  [0x53dd, 0x53dd],
  [0x548a, 0x548a],
  [0x549c, 0x549c],
  [0x54a9, 0x54a9],
  [0x54ff, 0x54ff],
  [0x5586, 0x5586],
  [0x5759, 0x5759],
  [0x5765, 0x5765],
  [0x57ac, 0x57ac],
  [0x57c7, 0x57c8],
  [0x589e, 0x589e],
  [0x58b2, 0x58b2],
  [0x590b, 0x590b],
  [0x5953, 0x5953],
  [0x595b, 0x595b],
  [0x595d, 0x595d],
  [0x5963, 0x5963],
  [0x59a4, 0x59a4],
  [0x59ba, 0x59ba],
  [0x5b56, 0x5b56],
  [0x5bc0, 0x5bc0],
  [0x5bd8, 0x5bd8],
  [0x5bec, 0x5bec],
  [0x5c1e, 0x5c1e],
  [0x5ca6, 0x5ca6],
  [0x5cba, 0x5cba],
  [0x5cf5, 0x5cf5],
  [0x5d27, 0x5d27],
  [0x5d42, 0x5d42],
  [0x5d53, 0x5d53],
  [0x5d6d, 0x5d6d],
  [0x5db8, 0x5db9],
  [0x5dd0, 0x5dd0],
  [0x5f21, 0x5f21],
  [0x5f34, 0x5f34],
  [0x5f45, 0x5f45],
  [0x5f67, 0x5f67],
  [0x5fb7, 0x5fb7],
  [0x5fde, 0x5fde],
  [0x605d, 0x605d],
  [0x6085, 0x6085],
  [0x608a, 0x608a],
  [0x60d5, 0x60d5],
  [0x60de, 0x60de],
  [0x60f2, 0x60f2],
  [0x6111, 0x6111],
  [0x6120, 0x6120],
  [0x6130, 0x6130],
  [0x6137, 0x6137],
  [0x6198, 0x6198],
  [0x6213, 0x6213],
  [0x62a6, 0x62a6],
  [0x63f5, 0x63f5],
  [0x6460, 0x6460],
  [0x649d, 0x649d],
  [0x64ce, 0x64ce],
  [0x654e, 0x654e],
  [0x6600, 0x6600],
  [0x6609, 0x6609],
  [0x6615, 0x6615],
  [0x661e, 0x661e],
  [0x6624, 0x6624],
  [0x662e, 0x662e],
  [0x6631, 0x6631],
  [0x663b, 0x663b],
  [0x6657, 0x6657],
  [0x6659, 0x6659],
  [0x6665, 0x6665],
  [0x6673, 0x6673],
  [0x6699, 0x6699],
  [0x66a0, 0x66a0],
  [0x66b2, 0x66b2],
  [0x66bf, 0x66bf],
  [0x66fa, 0x66fb],
  [0x670e, 0x670e],
  [0x6766, 0x6766],
  [0x67bb, 0x67bb],
  [0x67c0, 0x67c0],
  [0x6801, 0x6801],
  [0x6844, 0x6844],
  [0x6852, 0x6852],
  [0x68c8, 0x68c8],
  [0x68cf, 0x68cf],
  [0x6968, 0x6968],
  [0x6998, 0x6998],
  [0x69e2, 0x69e2],
  [0x6a30, 0x6a30],
  [0x6a46, 0x6a46],
  [0x6a6b, 0x6a6b],
  [0x6a73, 0x6a73],
  [0x6a7e, 0x6a7e],
  [0x6ae2, 0x6ae2],
  [0x6ae4, 0x6ae4],
  [0x6bd6, 0x6bd6],
  [0x6c3f, 0x6c3f],
  [0x6c5c, 0x6c5c],
  [0x6c6f, 0x6c6f],
  [0x6c86, 0x6c86],
  [0x6cda, 0x6cda],
  [0x6d04, 0x6d04],
  [0x6d6f, 0x6d6f],
  [0x6d87, 0x6d87],
  [0x6d96, 0x6d96],
  [0x6dac, 0x6dac],
  [0x6dcf, 0x6dcf],
  [0x6df2, 0x6df2],
  [0x6df8, 0x6df8],
  [0x6dfc, 0x6dfc],
  [0x6e27, 0x6e27],
  [0x6e39, 0x6e39],
  [0x6e3c, 0x6e3c],
  [0x6e5c, 0x6e5c],
  [0x6ebf, 0x6ebf],
  [0x6f88, 0x6f88],
  [0x6fb5, 0x6fb5],
  [0x6ff5, 0x6ff5],
  [0x7005, 0x7005],
  [0x7007, 0x7007],
  [0x7028, 0x7028],
  [0x7085, 0x7085],
  [0x70ab, 0x70ab],
  [0x70bb, 0x70bb],
  [0x7104, 0x7104],
  [0x710f, 0x710f],
  [0x7146, 0x7147],
  [0x715c, 0x715c],
  [0x71c1, 0x71c1],
  [0x71fe, 0x71fe],
  [0x72b1, 0x72b1],
  [0x72be, 0x72be],
  [0x7324, 0x7324],
  [0x7377, 0x7377],
  [0x73bd, 0x73bd],
  [0x73c9, 0x73c9],
  [0x73d2, 0x73d2],
  [0x73d6, 0x73d6],
  [0x73e3, 0x73e3],
  [0x73f5, 0x73f5],
  [0x7407, 0x7407],
  [0x7426, 0x7426],
  [0x7429, 0x742a],
  [0x742e, 0x742e],
  [0x7462, 0x7462],
  [0x7489, 0x7489],
  [0x749f, 0x749f],
  [0x7501, 0x7501],
  [0x752f, 0x752f],
  [0x756f, 0x756f],
  [0x7682, 0x7682],
  [0x769b, 0x769c],
  [0x769e, 0x769e],
  [0x76a6, 0x76a6],
  [0x7746, 0x7746],
  [0x7821, 0x7821],
  [0x784e, 0x784e],
  [0x7864, 0x7864],
  [0x787a, 0x787a],
  [0x7930, 0x7930],
  [0x7994, 0x7994],
  [0x799b, 0x799b],
  [0x7ad1, 0x7ad1],
  [0x7ae7, 0x7ae7],
  [0x7aeb, 0x7aeb],
  [0x7b9e, 0x7b9e],
  [0x7d48, 0x7d48],
  [0x7d5c, 0x7d5c],
  [0x7da0, 0x7da0],
  [0x7db7, 0x7db7],
  [0x7dd6, 0x7dd6],
  [0x7e52, 0x7e52],
  [0x7e8a, 0x7e8a],
  [0x7f47, 0x7f47],
  [0x7fa1, 0x7fa1],
  [0x8301, 0x8301],
  [0x8362, 0x8362],
  [0x837f, 0x837f],
  [0x83c7, 0x83c7],
  [0x83f6, 0x83f6],
  [0x8448, 0x8448],
  [0x84b4, 0x84b4],
  [0x84dc, 0x84dc],
  [0x8553, 0x8553],
  [0x8559, 0x8559],
  [0x856b, 0x856b],
  [0x85b0, 0x85b0],
  [0x8807, 0x8807],
  [0x88f5, 0x88f5],
  [0x891c, 0x891c],
  [0x8a12, 0x8a12],
  [0x8a37, 0x8a37],
  [0x8a79, 0x8a79],
  [0x8aa7, 0x8aa7],
  [0x8abe, 0x8abe],
  [0x8adf, 0x8adf],
  [0x8af6, 0x8af6],
  [0x8b53, 0x8b53],
  [0x8b7f, 0x8b7f],
  [0x8cf0, 0x8cf0],
  [0x8cf4, 0x8cf4],
  [0x8d12, 0x8d12],
  [0x8d76, 0x8d76],
  [0x8ecf, 0x8ecf],
  [0x9067, 0x9067],
  [0x90de, 0x90de],
  [0x9115, 0x9115],
  [0x9127, 0x9127],
  [0x91d7, 0x91d7],
  [0x91da, 0x91da],
  [0x91de, 0x91de],
  [0x91e4, 0x91e5],
  [0x91ed, 0x91ee],
  [0x9206, 0x9206],
  [0x920a, 0x920a],
  [0x9210, 0x9210],
  [0x9239, 0x923a],
  [0x923c, 0x923c],
  [0x9240, 0x9240],
  [0x924e, 0x924e],
  [0x9251, 0x9251],
  [0x9259, 0x9259],
  [0x9267, 0x9267],
  [0x9277, 0x9278],
  [0x9288, 0x9288],
  [0x92a7, 0x92a7],
  [0x92d0, 0x92d0],
  [0x92d3, 0x92d3],
  [0x92d5, 0x92d5],
  [0x92d7, 0x92d7],
  [0x92d9, 0x92d9],
  [0x92e0, 0x92e0],
  [0x92e7, 0x92e7],
  [0x92f9, 0x92f9],
  [0x92fb, 0x92fb],
  [0x92ff, 0x92ff],
  [0x9302, 0x9302],
  [0x931d, 0x931e],
  [0x9321, 0x9321],
  [0x9325, 0x9325],
  [0x9348, 0x9348],
  [0x9357, 0x9357],
  [0x9370, 0x9370],
  [0x93a4, 0x93a4],
  [0x93c6, 0x93c6],
  [0x93de, 0x93de],
  [0x93f8, 0x93f8],
  [0x9431, 0x9431],
  [0x9445, 0x9445],
  [0x9448, 0x9448],
  [0x9592, 0x9592],
  [0x969d, 0x969d],
  [0x96af, 0x96af],
  [0x9733, 0x9733],
  [0x973b, 0x973b],
  [0x9743, 0x9743],
  [0x974d, 0x974d],
  [0x974f, 0x974f],
  [0x9751, 0x9751],
  [0x9755, 0x9755],
  [0x9857, 0x9857],
  [0x9865, 0x9865],
  [0x9927, 0x9927],
  [0x999e, 0x999e],
  [0x9a4e, 0x9a4e],
  [0x9ad9, 0x9ad9],
  [0x9adc, 0x9adc],
  [0x9b72, 0x9b72],
  [0x9b75, 0x9b75],
  [0x9b8f, 0x9b8f],
  [0x9bb1, 0x9bb1],
  [0x9bbb, 0x9bbb],
  [0x9c00, 0x9c00],
  [0x9d6b, 0x9d6b],
  [0x9d70, 0x9d70],
  [0x9e19, 0x9e19],
  [0x9ed1, 0x9ed1],
  [0xe000, 0xe757],
  [0xf929, 0xf929],
  [0xf9dc, 0xf9dc],
  [0xfa0e, 0xfa2d],
  [0xff02, 0xff02],
  [0xff07, 0xff07],
  [0xff0d, 0xff0d],
  [0xff5e, 0xff5e],
  [0xffe0, 0xffe2],
  [0xffe4, 0xffe4],
];

/**
 * Documented minimal approximation, used ONLY when the running Node build
 * lacks the shift_jis ICU decoder (`new TextDecoder("shift_jis")` throws).
 * Known-good set: Hiragana/Katakana (incl. half-width), CJK ideographs,
 * Japanese punctuation, full-width forms, Greek, Cyrillic, box-drawing, and
 * the common JIS X 0208 row-1 symbols. Over-approximates Python's codec (fewer
 * flags) — with standard full-ICU Node builds this path never runs.
 */
const FALLBACK_SJIS_OK: ReadonlySet<number> = (() => {
  const ok = new Set<number>();
  const add = (lo: number, hi: number): void => {
    for (let cp = lo; cp <= hi; cp++) ok.add(cp);
  };
  add(0x00a2, 0x00a5); // ¢ £ ¤ ¥
  add(0x00ac, 0x00ac); // ¬
  add(0x00b1, 0x00b1); // ±
  add(0x00d7, 0x00d7); // ×
  add(0x00f7, 0x00f7); // ÷
  add(0x0391, 0x03c9); // Greek
  add(0x0401, 0x0451); // Cyrillic (incl. Ё/ё)
  add(0x2015, 0x2016); // ― ‖
  add(0x2018, 0x201d); // ‘ ’ “ ”
  add(0x2020, 0x2026); // † ‡ … etc.
  add(0x2030, 0x2030);
  add(0x2032, 0x2033);
  add(0x203b, 0x203b);
  add(0x203e, 0x203e); // ‾
  add(0x2103, 0x2103); // ℃
  add(0x2116, 0x2116); // №
  add(0x2121, 0x2121); // ℡
  add(0x212b, 0x212b); // Å
  add(0x2160, 0x2169); // Roman numerals Ⅰ-Ⅹ
  add(0x2170, 0x2179); // ⅰ-ⅹ
  add(0x2190, 0x2193); // arrows
  add(0x21d2, 0x21d2); // ⇒
  add(0x21d4, 0x21d4); // ⇔
  add(0x2200, 0x2200); // ∀
  add(0x2202, 0x2203); // ∂ ∃
  add(0x2207, 0x2208); // ∇ ∈
  add(0x220b, 0x220b); // ∋
  add(0x2211, 0x2212); // ∑ −
  add(0x221a, 0x221a); // √
  add(0x221d, 0x221e); // ∝ ∞
  add(0x2220, 0x2220); // ∠
  add(0x2225, 0x2225); // ∥
  add(0x2227, 0x222c); // ∧ ∨ ∩ ∪ ∫
  add(0x222e, 0x222e); // ∮
  add(0x2234, 0x2235); // ∴ ∵
  add(0x223d, 0x223d); // ∽
  add(0x2252, 0x2252); // ≒
  add(0x2260, 0x2261); // ≠ ≡
  add(0x2264, 0x2265); // ≤ ≥
  add(0x226a, 0x226b); // ≪ ≫
  add(0x2282, 0x2283); // ⊂ ⊃
  add(0x2295, 0x2296); // ⊕ ⊖
  add(0x2299, 0x2299); // ⊙
  add(0x22a5, 0x22a5); // ⊥
  add(0x22bf, 0x22bf); // ⊿
  add(0x2312, 0x2312); // ⌒
  add(0x2460, 0x2473); // ①-⑳
  add(0x2500, 0x254b); // box drawing
  add(0x25a0, 0x25a1); // ■ □
  add(0x25b2, 0x25b3); // ▲ △
  add(0x25bc, 0x25bd); // ▼ ▽
  add(0x25c6, 0x25c7); // ◆ ◇
  add(0x25cb, 0x25cb); // ○
  add(0x25ce, 0x25cf); // ◎ ●
  add(0x25ef, 0x25ef); // ◯
  add(0x2605, 0x2606); // ★ ☆
  add(0x2609, 0x2609); // ☉
  add(0x2612, 0x2613); // ☒ ☓
  add(0x2641, 0x2642); // ♁ ♂
  add(0x266a, 0x266f); // ♪ ♫ ♬ ♭ ♮ ♯
  add(0x3000, 0x3015); // ideographic space + JP punctuation
  add(0x301c, 0x301c); // 〜
  add(0x301d, 0x301f); // 〝〞〟
  add(0x3020, 0x303f); // 〠 〡-〿
  add(0x3041, 0x3096); // Hiragana
  add(0x309d, 0x309f); // ゝゞゟ
  add(0x30a1, 0x30ff); // Katakana
  add(0x3231, 0x3232); // ㈱㈲
  add(0x3239, 0x3239); // ㈹
  add(0x32a4, 0x32a8); // ㊤-㊨
  add(0x3303, 0x33cd); // CJK squared units (approx block)
  add(0x4e00, 0x9fa0); // CJK ideographs (over-approximation)
  add(0xff01, 0xff5e); // full-width forms (over-approximation)
  add(0xff61, 0xff9f); // half-width katakana
  add(0xffe0, 0xffe4); // ￠￡￢￣￤
  return ok;
})();

let sjisSet: ReadonlySet<number> | null = null;

/**
 * The exact set of BMP code points encodable by Python's `shift_jis` codec:
 * `WHATWG-decodable ∪ PYTHON_ONLY_ADDS − NODE_ONLY_EXCLUDES`. Computed lazily
 * on first use (~12k single decode calls, a few ms).
 */
function sjisEncodableSet(): ReadonlySet<number> {
  if (sjisSet !== null) return sjisSet;
  try {
    const dec = new TextDecoder("shift_jis", { fatal: true });
    const decodable = new Set<number>();
    for (let b = 0x00; b <= 0x7f; b++) decodable.add(b);
    for (let b = 0xa1; b <= 0xdf; b++) {
      decodable.add(dec.decode(Uint8Array.of(b)).codePointAt(0)!);
    }
    const trails: number[] = [];
    for (let b = 0x40; b <= 0x7e; b++) trails.push(b);
    for (let b = 0x80; b <= 0xfc; b++) trails.push(b);
    const addTrails = (lead: number): void => {
      for (const trail of trails) {
        try {
          decodable.add(dec.decode(Uint8Array.of(lead, trail)).codePointAt(0)!);
        } catch {
          // invalid trail byte → no character
        }
      }
    };
    for (let lead = 0x81; lead <= 0x9f; lead++) addTrails(lead);
    for (let lead = 0xe0; lead <= 0xfc; lead++) addTrails(lead);
    const encodable = new Set<number>(decodable);
    for (const cp of PYTHON_ONLY_ADDS) encodable.add(cp);
    for (const [lo, hi] of NODE_ONLY_EXCLUDES) {
      for (let cp = lo; cp <= hi; cp++) encodable.delete(cp);
    }
    sjisSet = encodable;
  } catch {
    // No shift_jis decoder (non-standard Node build without full ICU):
    // documented minimal approximation.
    sjisSet = FALLBACK_SJIS_OK;
  }
  return sjisSet;
}

/**
 * Characters in `text` (> U+007F) that have no Shift-JIS encoding, deduplicated
 * and in first-appearance order — mirrors lint.py `_sjis_unsafe_chars`.
 */
function sjisUnsafeChars(text: string): string[] {
  const encodable = sjisEncodableSet();
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x7f && !encodable.has(cp) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Rule regexes (ported verbatim from lint.py)
 * ------------------------------------------------------------------ */

const ANGLE_INCLUDE_WHITELIST = new Set([
  "macros.h",
  "types.h",
  "decomp.h",
  "string.h",
  "stddef.h",
  "stdarg.h",
  "math.h",
  "float.h",
  "limits.h",
  "ctype.h",
  "stdlib.h",
  "stdio.h",
  "new",
]);

const RE_ASM = /\basm\b|__asm/;
const RE_S_INCLUDE = /#\s*include\s*[<"][^>"]+\.s[>"]/;
const RE_REGISTER_KW = /\bregister\b|asm\s*\(\s*"r/;
const RE_DECL_LIKE =
  /^\s*(?:u8|u16|u32|u64|s8|s16|s32|s64|f32|f64|int|char|short|long|float|double|bool|void|unsigned|signed|const|static|struct|class|[A-Z]\w*(?:\s*[*&])?)\s/;
const RE_REG_NAME = /\br(?:3[01]|[12][0-9]|[0-9])\b/;
const RE_EXTERN_C = /extern\s+"C"/;
const RE_VOID_PTR = /\(\s*void\s*\*\s*\)|void\s*\*\s*\w+/;
const RE_VOLATILE_ARR =
  /\bvolatile\b[^;]*\b(?:char|u8)\b[^;]*\[|\b(?:u8|char)\s+(?:sp|stack)\d*\s*\[\s*(?:0x[0-9A-Fa-f]+|\d+)/;
const RE_CAST = /\(\s*\w+\s*\*\s*\)/;
const RE_HEX_OFF = /\+\s*0x[0-9A-Fa-f]+/;
const RE_CODEGEN = /DECOMP_PPC_|DECOMP_FORCELITERAL|DECOMP_FORCEACTIVE/;
/** Unknown-name placeholders: offset-style `unkN` locals/fields. */
export const DEFAULT_UNK_NAME_PATTERN = /\bunk[0-9A-Fa-f]+\b/;
/**
 * Generated unknown types/members (`UnkClass_8045F564`, `UnkVirtualFunc3`,
 * `CActorParam_UnkStruct2` …). UN-ANCHORED on purpose: it may appear as a
 * member/prefix inside a longer identifier, so any word-boundary start with
 * optional prior identifier chars must match (lint.py substring semantics).
 */
export const DEFAULT_UNK_GENERATED_PATTERN =
  /Unk(?:Class_[0-9A-Fa-f]+|VirtualFunc[0-9]+|Struct[0-9A-Fa-f]+)/;
const RE_BINPATCH =
  /insn_patches|insert_insns|reloc_offset_moves|postprocess_reloc_names/;
const RE_ASM_INSN_MARKER = /\bDECOMP_ASM_INSN_(?:BEGIN|END)\b/;
const RE_INIT_CAST_ONE_LINE = /(?:reinterpret_cast|static_cast)\s*<[^>]+>\s*\([^()]*\w\s*=(?!=)/;
const RE_INIT_CAST_OPEN = /(?:reinterpret_cast|static_cast)\s*<[^>]+>\s*\(\s*$/;
const RE_ASSIGN_OP = /\w\s*=(?!=)/;
const RE_PRAGMA = /^\s*#\s*pragma\b/;
const RE_IF0 = /^\s*#\s*if\s+0\b/;
const RE_SECTION = /__declspec\s*\(\s*section|__attribute__\s*\(\s*\(\s*section/;
const RE_ANGLE_INC = /^\s*#\s*include\s*<([^>]+)>/;
const RE_SELF_PARAM = /\*\s*self\s*(?:[,)]|$)/;
const RE_CTOR_DTOR = /__[cd]t__/;

/* ------------------------------------------------------------------ *
 * Delta rule registry
 * ------------------------------------------------------------------ */

/** The per-line argument the shared contract passes to every delta rule. */
export interface DeltaLine {
  /** 1-indexed line number of the added line in the NEW file. */
  line: number;
  /** The comment-stripped added line (raw text lives in `ctx.raw`). */
  text: string;
}

/**
 * Delta-gate extension of the shared `DeltaCtx` (`types.ts`): the typed
 * cross-line state and per-file facts this gate's rules need. `sourcePath` and
 * the generic `state` bag come from `DeltaCtx`; adapter-specific rules may use
 * `state` for their own cross-line state. Rules receive the shared base type
 * (`DeltaCtx`) per the contract and narrow to this at the top of `check`.
 */
export interface DeltaContext extends DeltaCtx {
  /** 1-indexed line number of the current added line in the NEW text. */
  lineNo: number;
  /** The added line as-is, including comments. */
  raw: string;
  /** The added line with the `//` comment stripped. */
  code: string;
  /** `.c`/`.h` file (`extern "C"` illegal). */
  isC: boolean;
  /** `.cpp`/`.cc`/`.cxx`/`.hpp`/`.hh` file. */
  isCpp: boolean;
  /** Cross-line state: a cast was opened on a previous added line. */
  castPending: boolean;
  /** Regex for the `no_unk_name` placeholder rule. */
  unkNamePattern: RegExp;
  /** Regex for the `no_unk_generated` rule. */
  unkGeneratedPattern: RegExp;
  /** Angle-include whitelist for `no_angle_include`. */
  angleIncludeWhitelist: ReadonlySet<string>;
}

/** Optional `lintDelta` configuration (rule pattern overrides). */
export interface DeltaLintOptions {
  /** `no_unk_name` placeholder pattern (default `DEFAULT_UNK_NAME_PATTERN`). */
  unkNamePattern?: RegExp;
  /** `no_unk_generated` pattern (default `DEFAULT_UNK_GENERATED_PATTERN`). */
  unkGeneratedPattern?: RegExp;
  /** `no_angle_include` whitelist (default `ANGLE_INCLUDE_WHITELIST`). */
  angleIncludeWhitelist?: string[];
}

/** Build a `Finding` from a context; mirrors lint.py's `add()` helper. */
function findingFor(rule: string, ctx: DeltaContext, message: string): Finding {
  return {
    rule,
    line: ctx.lineNo,
    snippet: ctx.raw.trim().slice(0, 100),
    message,
  };
}

/**
 * The delta-lint rule registry, ordered exactly as lint.py evaluates its
 * rules (SPEC §13.2 parity). Two ids appear twice on purpose, mirroring
 * lint.py's independent checks that share an id but sit at different points
 * of the evaluation order:
 *   - `no_asm`: the `.s`-include check (raw) and the `asm` keyword check
 *     (comment-stripped) — lint.py has both.
 *   - `no_init_side_effect`: rule A (one-line cast-assign + cast-open
 *     detection) and rule B (pending-state assign + close), which together
 *     reproduce lint.py's exact `cast_pending` state machine and can emit
 *     two findings on one line (one-line + pending on the same line).
 *
 * `check` receives the shared base `DeltaCtx`; `lintDelta` always passes a
 * full `DeltaContext` (this gate's extension), so the narrowing cast at the
 * top of each check is a runtime-safe downcast.
 */
export const deltaRules: DeltaRule[] = [
  {
    id: "non_sjis_char",
    description:
      "character with no Shift-JIS encoding (would fail the sjiswrap/mwcceppc build)",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      const bad = sjisUnsafeChars(c.raw);
      if (bad.length === 0) return undefined;
      return findingFor(
        "non_sjis_char",
        c,
        `character(s) with no Shift-JIS encoding (will fail the build): ${bad.join("")} — replace with ASCII or valid SJIS`,
      );
    },
  },
  {
    id: "extern_c_in_c",
    description: '`extern "C"` is C++-only syntax — illegal in C files',
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (c.isC && RE_EXTERN_C.test(line.text)) {
        return findingFor(
          "extern_c_in_c",
          c,
          '`extern "C"` is C++-only syntax and does not compile in C files — remove it',
        );
      }
      return undefined;
    },
  },
  {
    id: "no_pragmas",
    description: "new preprocessor pragmas are forbidden (codegen steering)",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_PRAGMA.test(c.raw)) {
        return findingFor(
          "no_pragmas",
          c,
          "new preprocessor pragmas are forbidden (codegen steering)",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_if0",
    description: "#if 0 wrapping is forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_IF0.test(c.raw)) {
        return findingFor(
          "no_if0",
          c,
          "#if 0 wrapping is forbidden (can hide symbols from diffs)",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_section_attr",
    description: "section attributes are forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_SECTION.test(c.raw)) {
        return findingFor("no_section_attr", c, "section attributes are forbidden");
      }
      return undefined;
    },
  },
  {
    id: "no_codegen_macros",
    description: "DECOMP_* codegen-steering macros are forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_CODEGEN.test(c.raw)) {
        return findingFor(
          "no_codegen_macros",
          c,
          "DECOMP_* codegen-steering macros are forbidden",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_binary_patching",
    description:
      "binary-patching escapes (insn_patches / insert_insns / reloc_offset_moves / postprocess_reloc_names) are forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_BINPATCH.test(c.raw)) {
        return findingFor(
          "no_binary_patching",
          c,
          "binary-patching escapes (insn_patches / insert_insns / reloc_offset_moves / postprocess_reloc_names) are forbidden — chase EQUIVALENT_MATCH, not byte-identity patches",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_extern_c",
    description: 'extern "C" is only allowed for lbl_* reloc names',
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_EXTERN_C.test(c.raw) && !c.raw.includes("lbl_")) {
        return findingFor(
          "no_extern_c",
          c,
          'extern "C" is only allowed for lbl_* reloc names',
        );
      }
      return undefined;
    },
  },
  {
    id: "cpp_free_ctor",
    description:
      "constructor/destructor written as a C-style free function taking `* self` (must be Class::Class / Class::~Class)",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (
        c.isCpp &&
        RE_CTOR_DTOR.test(line.text) &&
        !line.text.includes("::") &&
        RE_SELF_PARAM.test(line.text)
      ) {
        return findingFor(
          "cpp_free_ctor",
          c,
          "constructor/destructor written as a C-style free function taking `* self` — use a member constructor/destructor (Class::Class / Class::~Class) instead",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_angle_include",
    description: "angle includes are limited to a whitelist",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      const m = RE_ANGLE_INC.exec(c.raw);
      if (m !== null && !c.angleIncludeWhitelist.has(m[1]!)) {
        return findingFor(
          "no_angle_include",
          c,
          `angle include <${m[1]}> is not whitelisted`,
        );
      }
      return undefined;
    },
  },
  {
    // lint.py's `.s`-include check: applies to the RAW line, before the
    // pure-comment `continue` (see the second `no_asm` entry below for the
    // `asm`-keyword check).
    id: "no_asm",
    description: ".s includes are forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_S_INCLUDE.test(c.raw)) {
        return findingFor("no_asm", c, ".s includes are forbidden");
      }
      return undefined;
    },
  },
  {
    id: "no_volatile_fake_stack",
    description: "volatile/fake stack buffers are forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_VOLATILE_ARR.test(c.raw)) {
        return findingFor(
          "no_volatile_fake_stack",
          c,
          "volatile/fake stack buffers are forbidden",
        );
      }
      return undefined;
    },
  },
  {
    // lint.py's `asm`-keyword check: comment-stripped, after the pure-comment
    // `continue` (a pure comment line can never match this — `text` is empty).
    id: "no_asm",
    description: "assembly is forbidden, including single-instruction asm",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_ASM.test(line.text)) {
        return findingFor(
          "no_asm",
          c,
          "assembly is forbidden, including single-instruction asm",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_asm_insn_shim",
    description: "DECOMP_ASM_INSN single-instruction asm shims are forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_ASM_INSN_MARKER.test(line.text)) {
        return findingFor(
          "no_asm_insn_shim",
          c,
          "DECOMP_ASM_INSN single-instruction asm shims are forbidden in new code — write high-level C++ and chase a natural match",
        );
      }
      return undefined;
    },
  },
  {
    // Rule A of the cast_pending state machine: the one-line init-cast check
    // plus cast-open detection. lint.py evaluates one-line first, then opens
    // the pending state — a line cannot match both (`\s*$` vs `\w\s*=` after
    // the opening paren), so order is preserved exactly.
    id: "no_init_side_effect",
    description:
      "assignment inside a cast (init-list store-ordering trick) is forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      let hit: Finding | undefined;
      if (RE_INIT_CAST_ONE_LINE.test(line.text)) {
        hit = findingFor(
          "no_init_side_effect",
          c,
          "assignment inside a cast (init-list store-ordering trick) is forbidden — write the plain value",
        );
      }
      if (!c.castPending && RE_INIT_CAST_OPEN.test(line.text)) {
        c.castPending = true;
      }
      return hit;
    },
  },
  {
    // Rule B of the cast_pending state machine: while a cast is pending, an
    // assignment flags; a `)` closes the pending state — checked in that
    // order, exactly as lint.py does on the same line.
    id: "no_init_side_effect",
    description:
      "assignment inside a multi-line cast / member-initializer is forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (!c.castPending) return undefined;
      let hit: Finding | undefined;
      if (RE_ASSIGN_OP.test(line.text)) {
        hit = findingFor(
          "no_init_side_effect",
          c,
          "assignment inside a multi-line cast / member-initializer is forbidden — write the plain value",
        );
      }
      if (line.text.includes(")")) c.castPending = false;
      return hit;
    },
  },
  {
    id: "no_register_keyword",
    description: "register keyword / register bindings are forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_REGISTER_KW.test(line.text)) {
        return findingFor(
          "no_register_keyword",
          c,
          "register keyword / register bindings are forbidden",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_register_names",
    description: "identifiers named after GPRs (r0-r31) are forbidden",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_REG_NAME.test(line.text) && RE_DECL_LIKE.test(line.text)) {
        return findingFor(
          "no_register_names",
          c,
          "identifiers named after GPRs (r0-r31) are forbidden",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_void_ptr",
    description: "void* is forbidden; use a proper struct/class type",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_VOID_PTR.test(line.text)) {
        return findingFor(
          "no_void_ptr",
          c,
          "void* is forbidden; use a proper struct/class type",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_unk_name",
    description:
      "unknown-name placeholder `unkN` is forbidden in new code (configurable pattern)",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (c.unkNamePattern.test(line.text)) {
        return findingFor(
          "no_unk_name",
          c,
          "unknown-name placeholder `unkN` is forbidden in new code; name the variable/field from the retail symbol or struct layout",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_unk_generated",
    description:
      "generated unknown type/member (`UnkClass_*`, `UnkVirtualFunc*`, `UnkStruct*`) is forbidden in new code (configurable pattern)",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (c.unkGeneratedPattern.test(line.text)) {
        return findingFor(
          "no_unk_generated",
          c,
          "generated unknown type/member (`UnkClass_*`, `UnkVirtualFunc*`, `UnkStruct*`) is forbidden in new code; use a real struct/class name from the headers or declare it properly",
        );
      }
      return undefined;
    },
  },
  {
    id: "no_offset_arithmetic",
    description: "raw pointer offset arithmetic is forbidden; use struct fields",
    check: (line: DeltaLine, ctx: DeltaCtx): Finding | undefined => {
      const c = ctx as DeltaContext;
      if (RE_CAST.test(line.text) && RE_HEX_OFF.test(line.text)) {
        return findingFor(
          "no_offset_arithmetic",
          c,
          "raw pointer offset arithmetic is forbidden; use struct fields",
        );
      }
      return undefined;
    },
  },
];

/* ------------------------------------------------------------------ *
 * Gate driver
 * ------------------------------------------------------------------ */

/**
 * Run the delta-lint gate over the added lines of `oldText → newText`.
 * `oldText === null` treats the whole `newText` as added. Returns findings
 * ordered by (file line, rule evaluation order) — mirroring lint.py.
 *
 * @param path    file path (drives C-vs-C++ branching via extension)
 * @param oldText previous file contents, or null for a brand-new file
 * @param newText new file contents
 * @param options optional rule-pattern overrides (e.g. `no_unk_name`)
 */
export function lintDelta(
  path: string,
  oldText: string | null,
  newText: string,
  options: DeltaLintOptions = {},
): Finding[] {
  const findings: Finding[] = [];
  const ctx: DeltaContext = {
    sourcePath: path,
    state: {},
    lineNo: 0,
    raw: "",
    code: "",
    isC: isC(path),
    isCpp: isCpp(path),
    castPending: false,
    unkNamePattern: options.unkNamePattern ?? DEFAULT_UNK_NAME_PATTERN,
    unkGeneratedPattern:
      options.unkGeneratedPattern ?? DEFAULT_UNK_GENERATED_PATTERN,
    angleIncludeWhitelist:
      options.angleIncludeWhitelist !== undefined
        ? new Set(options.angleIncludeWhitelist)
        : ANGLE_INCLUDE_WHITELIST,
  };
  for (const { line, text } of computeAddedLines(oldText, newText)) {
    ctx.lineNo = line;
    ctx.raw = text;
    ctx.code = stripLineComment(text);
    for (const rule of deltaRules) {
      const hit = rule.check({ line: ctx.lineNo, text: ctx.code }, ctx);
      if (hit !== undefined) findings.push(hit);
    }
  }
  return findings;
}
