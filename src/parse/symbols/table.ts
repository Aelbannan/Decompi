/**
 * M1b — symbols.txt loader + MWCC mangled-name parser
 * (src/parse/symbols/table.ts).
 *
 * Port of `tools/symbolrecover/lib/parser.py` (`load_symbols` /
 * `parse_symbol_line`) and the `__Q…` qualifier parsing in
 * `tools/coop/member_check.py` (`parse_qualifier_class`), against the real
 * `config/us/symbols.txt` format:
 *
 *   memcpy = .init:0x80004000; // type:function size:0x29C scope:global
 *   @4558  = extab:0x800066E0; // type:object size:0x1C scope:local hidden
 *
 * plus the tolerant `name = 0xADDR; // …` form (section omitted).
 *
 * Mangled-name grammar (MWCC):
 *   `__ct__<len><Class>F<params>`     constructor
 *   `__dt__<len><Class>F<params>`     destructor
 *   `__<len><Name>F<params>`          method (ctor-style encoding)
 *   `__Q<count><len><Ns1>…<len><Class>F<params>`
 *                                     scoped member; `<count>` is the number of
 *                                     qualifier tokens (single digit), each
 *                                     `<len><name>` length-prefixed.
 *
 * Free symbols (`func_XXXXXXXX`, `lbl_…`, `data_…`, plain names,
 * `__start`-style C runtime names, bare `__XXXXXXXX` addresses) yield
 * `isMember: false`.
 *
 * Reference parity notes:
 * - `byName` is FIRST-WINS for duplicate names (Python's `names.setdefault`).
 * - `byAddress` keeps ALL occupants per address, in file order (Python's
 *   `addr_hits` list — `func_X` / `lbl_X` aliases are the common case). This
 *   is what makes `extc.jp_stale` / `extc.drift` address lookups correct
 *   (Python's `any(rn == name)` / `any(rn != name)` tests).
 * - Anonymous-namespace qualifiers (`@unnamed@<file>_cpp@`, a dtk rendering)
 *   are real qualifier TOKENS, so only the known dtk local suffixes
 *   (`@instance`, `@<digits>`) are stripped before qualifier parsing —
 *   `wkUpdate__Q219@unnamed@CGame_cpp@12CGameRestartFv` parses as a scoped
 *   member with className `CGameRestart`.
 */
export interface SymbolTable {
  /** symbol address -> ALL occupant names, in symbols.txt order */
  byAddress: Map<number, string[]>;
  /** symbol name -> symbol address (first occurrence wins) */
  byName: Map<string, number>;
}

export interface MangledName {
  /** final class token of a member (e.g. "MemManager", "CGame"), else null */
  className: string | null;
  /** scope tokens of a `__Q…` member (e.g. ["mtl", "MemManager"]); the
   *  anonymous-namespace token (`@unnamed@CGame_cpp@`) appears as-is */
  namespacePath: string[];
  /** true for `__ct__` names */
  isConstructor: boolean;
  /** true for `__dt__` names */
  isDestructor: boolean;
  /** true for mangled member names, false for free functions / labels / data */
  isMember: boolean;
  /** raw MWCC parameter encoding after the `F` marker (e.g. "v", "Uli",
   *  "PCcP11CWorkThread"), or null when the name carries no parameter list */
  params: string | null;
}

/** `name = [section:]0xADDR[;][ // comment]` — section optional for the
 *  tolerant form. Names never contain `=` in the real symbols.txt. */
const SYMBOL_LINE_RE =
  /^([^=]+?)\s*=\s*(?:(?:[A-Za-z0-9_.]+):)?(0x[0-9A-Fa-f]+)\s*;?\s*(?:\/\/.*)?$/;

/** dtk bucket prefixes (`@12@…`), local suffixes (`…@instance`, `…@<digits>`)
 *  and address prefixes (`func_XXXXXXXX` / `lbl_XXXXXXXX` / `data_XXXXXXXX`)
 *  that wrap the mangled name. The suffix class is DELIBERATELY narrow: the
 *  `@…` inside anonymous-namespace qualifiers (`@unnamed@CGame_cpp@`) is a
 *  qualifier token, not a dtk suffix. */
const BUCKET_PREFIX_RE = /^(?:@[^@]*@)+/;
const LOCAL_SUFFIX_RE = /(?:@instance|@\d+)+$/;
const ADDR_PREFIX_RE = /^(?:func|lbl|data)_[0-9A-Fa-f]{8}/;

/** A `__` that begins a mangled member encoding: `__Q<count>` or
 *  `__<len><letter|@>` (the `@` allows `__<len>@unnamed@…` unqualified
 *  anonymous-namespace class tokens like `GetFreePlayer__24@unnamed@…Fi`). */
const MEMBER_MARKER_RE = /__(?=Q\d|(?:\d+)[A-Za-z_@])/g;

/** Parse the symbols.txt line format. Skips blank lines and `#`/`//` comments;
 *  malformed lines are ignored (matching `parse_symbol_line`). `byAddress`
 *  keeps ALL occupants per address (file order, first occurrence of a name
 *  wins); `byName` is first-wins for duplicate names. */
export function loadSymbols(text: string): SymbolTable {
  const byAddress = new Map<number, string[]>();
  const byName = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || stripped.startsWith("//")) {
      continue;
    }
    const m = SYMBOL_LINE_RE.exec(stripped);
    const name = m?.[1];
    const addressHex = m?.[2];
    if (name === undefined || addressHex === undefined || name.trim() === "") {
      continue;
    }
    const address = Number.parseInt(addressHex, 16);
    if (Number.isNaN(address)) {
      continue;
    }
    const trimmed = name.trim();
    let occupants = byAddress.get(address);
    if (occupants === undefined) {
      occupants = [];
      byAddress.set(address, occupants);
    }
    occupants.push(trimmed);
    if (!byName.has(trimmed)) {
      byName.set(trimmed, address); // first occurrence wins (setdefault parity)
    }
  }
  return { byAddress, byName };
}

interface ParsedCore {
  className: string | null;
  namespacePath: string[];
  params: string | null;
}

/** One `<len><name>` token. The declared length must be exact; when it overruns
 *  the remaining text (sloppy length digits, e.g. `__ct__11CGameFv`), the token
 *  is clamped to the signature `F`. Real MWCC name lengths are at most a couple
 *  of dozen chars, so an overrun with a 3+ digit declared length is a bare
 *  address (`__800B0AF4` — digits `800` + hex tail) rather than a member; when
 *  no `F` is present the tail is likewise not a member. Token names may contain
 *  `@` (anonymous-namespace qualifier tokens). */
function readToken(s: string, i: number): { name: string; next: number } | null {
  const dm = /^(\d+)/.exec(s.slice(i));
  const digits = dm?.[1];
  if (digits === undefined) {
    return null;
  }
  const len = Number(digits);
  if (!Number.isFinite(len) || len <= 0) {
    return null;
  }
  const start = i + digits.length;
  let n = len;
  if (start + len > s.length) {
    if (len > 99) {
      return null;
    }
    const f = s.indexOf("F", start);
    if (f < 0) {
      return null;
    }
    n = Math.min(len, f - start);
  }
  if (n <= 0) {
    return null;
  }
  return { name: s.slice(start, start + n), next: start + n };
}

/** `Q<count><len><Ns1>…<len><Class>` — count is a single digit. */
function parseQualified(body: string): ParsedCore | null {
  const c = body.charCodeAt(0);
  if (c < 0x31 || c > 0x39) {
    return null;
  }
  const count = c - 0x30;
  const tokens: string[] = [];
  let i = 1;
  for (let t = 0; t < count; t++) {
    const tok = readToken(body, i);
    if (tok === null) {
      return null;
    }
    tokens.push(tok.name);
    i = tok.next;
  }
  return {
    className: tokens[tokens.length - 1] ?? null,
    namespacePath: tokens,
    params: body[i] === "F" ? body.slice(i + 1) : null,
  };
}

/** `<len><Name>` — plain (unscoped) member encoding. */
function parseUnqualified(body: string): ParsedCore | null {
  const tok = readToken(body, 0);
  if (tok === null) {
    return null;
  }
  return {
    className: tok.name,
    namespacePath: [],
    params: body[tok.next] === "F" ? body.slice(tok.next + 1) : null,
  };
}

function parseCore(body: string): ParsedCore | null {
  if (body.startsWith("Q")) {
    return parseQualified(body.slice(1));
  }
  return parseUnqualified(body);
}

/** Classify an MWCC symbol name as a member (ctor/dtor/scoped method) or free. */
export function parseMangled(name: string): MangledName {
  const out: MangledName = {
    className: null,
    namespacePath: [],
    isConstructor: false,
    isDestructor: false,
    isMember: false,
    params: null,
  };
  if (!name) {
    return out;
  }

  // Strip only the dtk bucket PREFIX and the known dtk local SUFFIXES
  // (`@instance`, `@<digits>`). Anonymous-namespace qualifier tokens
  // (`@unnamed@<file>_cpp@`) are NOT stripped — they are parsed as qualifier
  // tokens below.
  const cleaned = name
    .replace(BUCKET_PREFIX_RE, "")
    .replace(LOCAL_SUFFIX_RE, "")
    .replace(ADDR_PREFIX_RE, "");

  const ctorIdx = cleaned.lastIndexOf("__ct__");
  const dtorIdx = cleaned.lastIndexOf("__dt__");
  if (ctorIdx >= 0 || dtorIdx >= 0) {
    const isCtor = ctorIdx >= dtorIdx;
    out.isMember = true;
    out.isConstructor = isCtor;
    out.isDestructor = !isCtor;
    const core = parseCore(cleaned.slice((isCtor ? ctorIdx : dtorIdx) + 6));
    if (core !== null) {
      out.className = core.className;
      out.namespacePath = core.namespacePath;
      out.params = core.params;
    }
    return out;
  }

  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = MEMBER_MARKER_RE.exec(cleaned)) !== null) {
    lastIdx = m.index;
  }
  if (lastIdx < 0) {
    return out;
  }
  const core = parseCore(cleaned.slice(lastIdx + 2));
  if (core === null) {
    return out;
  }
  out.isMember = true;
  out.className = core.className;
  out.namespacePath = core.namespacePath;
  out.params = core.params;
  return out;
}
