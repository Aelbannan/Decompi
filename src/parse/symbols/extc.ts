/**
 * M1b — extern "C" declaration classifier + member-conversion planner
 * (src/parse/symbols/extc.ts).
 *
 * Port of `tools/coop/extc.py` (`scan` / `plan`, Xenoblade fork) against a
 * loaded {@link SymbolTable} (see SPEC §13.3). The hand-written extern "C"
 * pseudo-import pattern across src/libs is a legacy smell and a drift source;
 * the retail symbol table is the source of truth for what name each retail
 * reloc references.
 *
 * Two INDEPENDENT axes, mirroring extc.py's separate lists:
 *
 *   `classifyExternC(...).category`  — the name-based classification:
 *       exact      — name is exactly a retail symbol
 *       drift      — name matches a retail symbol modulo an embedded
 *                    address / extra-or-missing suffix (incl. JP/region
 *                    suffixes) / shared mangled qualifier tail
 *       invented   — no retail match (cleanable: extern "C" removable)
 *       jp_stale   — name is retail but its embedded address maps to a
 *                    different retail entry (old-layout JP address)
 *       unparsed   — no name could be extracted (scanner front-end)
 *
 *   `classifyExternC(...).memberCandidateHint`  — a heuristic flag,
 *     independent of category: `'__' in name` (is_mangled) OR a self-style
 *     first parameter (`T* self` / `void* self`). No table membership is
 *     required — any self-style param is a candidate (extc.py appends to
 *     `member_candidates` regardless of the name classification).
 *
 * The declaration scanner lives in {@link scanner} (a line-based port of
 * extc.py's extractor) and feeds `classifyExternC` via {@link scanExternC},
 * which makes the `unparsed` category reachable.
 *
 * `planMemberConversion` computes the MWCC member-mangling rename targets for
 * a class — ctor `__ct__<len><Class>Fv`, dtor `__dt__…`, scoped
 * `__Q<count><len><Ns1>…<len><Class>Fv` members — plus the ceremony checklist
 * (rename decl/def, fix call sites, update symbols.txt) and, when source
 * units are supplied, the source-scan hit list (self-cast defs / typed-self
 * defs / declarations referencing the class) with per-hit mangling targets.
 */
import { parseMangled, type SymbolTable } from "./table.js";
import type { RelocMap } from "./reloc-map.js";
import {
  extractEntries,
  externCDefsWithBodies,
  hasSelfStyleParam,
  nameFrom,
  RE_CLASS_CAST,
  type ExtcDef,
  type ExtcEntry,
} from "./scanner.js";

/** Category of an extern "C" declaration, per SPEC §13.3 (`extc.*`). */
export type ExtcCategory = ExtcClass["category"];

/** Classification result for one extern "C" declaration. Every variant
 *  carries the specific `reason`; name/address fields are populated when
 *  known. */
export type ExtcClass =
  | { category: "exact"; name: string; address: number; reason: string }
  | { category: "drift"; name: string; resolved: string; reason: string }
  | { category: "invented"; name: string; reason: string }
  | {
      category: "jp_stale";
      name: string;
      /** the real (table) address of the name */
      address: number;
      /** the old-layout address embedded in the name */
      staleAddress: number;
      /** the retail symbol that now occupies the stale address */
      resolved: string;
      reason: string;
    }
  | { category: "unparsed"; reason: string };

/** Result of classifying one declaration: the name-based {@link ExtcClass}
 *  category plus the independent member-candidate hint axis. */
export interface ClassifyResult {
  category: ExtcClass;
  /**
   * Independent heuristic axis (extc.py `member_candidates`): `'__' in name`
   * (is_mangled) OR a self-style first parameter — regardless of category.
   */
  memberCandidateHint: boolean;
}

/** Input declaration shape for {@link classifyExternC}. `body` (the full
 *  declaration text, `extern "C"` removed) is the primary source for the
 *  self-style check (extc.py searches the whole body); when absent the
 *  self-style check falls back to the first `params` element. */
export interface ExtcDecl {
  name: string;
  returnType?: string;
  params?: string[];
  /** declaration body without the `extern "C"` prefix (scanner output). */
  body?: string;
  line: number;
}

/** One source unit fed to {@link scanExternC} / {@link planMemberConversion}. */
export interface SourceUnit {
  /** repository-relative path, e.g. `src/kyoshin/CExchangeWin.cpp`. */
  path: string;
  text: string;
}

/** One retail member symbol of a planned class (from the symbol table). */
export interface RetailMember {
  /** full retail symbol name, e.g. `OnFileEvent__12CExchangeWinFP10CEventFile` */
  name: string;
  address: number;
  className: string;
  /** scope tokens of a `__Q…` member (e.g. ["cf", "CfObjectPoint"]), else [] */
  namespacePath: string[];
  isConstructor: boolean;
  isDestructor: boolean;
  /** raw MWCC parameter encoding (e.g. "v", "P10CEventFile"), or null when
   *  the name carries no parameter list (sloppy JP names) */
  params: string | null;
  /** canonical MWCC mangled name when the retail entry deviates (sloppy JP
   *  name / wrong length), e.g. `__ct__CExchangeWin` → `__ct__12CExchangeWinFv`;
   *  null when the entry is already canonical */
  canonicalTarget: string | null;
}

/** One step of the member-conversion ceremony checklist. */
export interface CeremonyStep {
  step: "rename-decl" | "rename-def" | "fix-call-sites" | "update-symbols";
  instruction: string;
}

/** One source-scan hit: an extern "C" def/decl referencing the class. */
export interface MemberPlanHit {
  path: string;
  line: number;
  name: string;
  /** `def-selfcast` = body casts `((Class*)self)`; `def-param` = header has a
   *  typed `Class*` first param; `decl` = declaration referencing the token
   *  that is retail-exact or retail-drift (extc.py `plan` parity). */
  kind: "def-selfcast" | "def-param" | "decl";
  /** the def header (for defs) or the raw decl line (for decls). */
  header: string;
}

/** One source-level call site of a planned def name (SPEC §13.3 "call sites").
 *  extc.py leaves call sites to an `rg` instruction; this scan is a TS
 *  value-add (documented in docs/m1b-parity.md). */
export interface MemberPlanCallSite {
  path: string;
  line: number;
  /** the def name being called. */
  name: string;
  /** the full source line (trimmed). */
  snippet: string;
}

/** Per-hit MWCC rename target. */
export interface MemberPlanTarget {
  line: number;
  name: string;
  /**
   * Python-parity target (`member_mangled`): `name__<len>ClassFv` verbatim.
   * NOTE: for `__ct__…` / `__dt__…` declared names this is NOT the canonical
   * MWCC name (documented deviation — see docs/m1b-parity.md).
   */
  mangled: string;
  /** canonical MWCC target (`__ct__<Class>` → `__ct__<len>ClassFv`). */
  canonical: string;
}

/** Member-conversion plan for a class token. */
export interface MemberPlan {
  className: string;
  /** namespace scope discovered from retail members of the class ([] when
   *  unscoped); drives `__Q…` mangling */
  namespacePath: string[];
  /** retail rename target for a no-arg ctor, e.g. `__ct__5CGameFv` */
  ctorTarget: string;
  /** retail rename target for a no-arg dtor, e.g. `__dt__5CGameFv` */
  dtorTarget: string;
  /** `<member>__<scope><len><Class>Fv` — rename target for a no-arg method */
  methodTargetTemplate: string;
  /** retail member symbols of the class already in the table (sorted by name) */
  existingMembers: RetailMember[];
  /** every retail name containing the class token (extc.py `plan`'s
   *  `class_syms`, Python `member_mangled` parity; sorted). */
  retailSymbols: string[];
  /** source-scan hits (defs + decls referencing the class), when sources are
   *  supplied; empty otherwise. */
  hits: MemberPlanHit[];
  /** source-level call sites of the planned defs (lines referencing a def
   *  name, excluding the def/decl lines themselves); empty when no sources. */
  callSites: MemberPlanCallSite[];
  /** per-def-hit mangling targets (Python parity + canonical), sorted by
   *  line; empty when no sources are supplied. */
  targets: MemberPlanTarget[];
  /** ceremony checklist: rename decl/def, fix call sites, update symbols.txt */
  ceremony: CeremonyStep[];
}

/** `_?<8 hex digits>` at a word boundary — an embedded retail address. The
 *  `\b` (JS == Python semantics) rejects `func_8006EF04__Fi` (underscore is a
 *  word char) while accepting `func_8006EF04` / `lbl_80004200`. */
const ADDR_ANY_RE = /_?([0-9A-Fa-f]{8})\b/g;

/** All 8-hex-digit addresses embedded in a name (may be several). */
function embeddedAddresses(name: string): number[] {
  ADDR_ANY_RE.lastIndex = 0;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = ADDR_ANY_RE.exec(name)) !== null) {
    const h = m[1];
    if (h !== undefined) {
      out.push(Number.parseInt(h, 16));
    }
  }
  return out;
}

/** The first embedded address, or null. */
function embeddedAddress(name: string): number | null {
  return embeddedAddresses(name)[0] ?? null;
}

function hex(addr: number): string {
  return `0x${addr.toString(16).padStart(8, "0")}`;
}

/** Recover the class a retail name encodes. `parseMangled` handles the proper
 *  encodings (with clamped sloppy lengths); names like the real
 *  `__ct__CExchangeWin` (bare identifier, no length/params — a JP-layout
 *  artifact) fall back to the ctor/dtor marker. */
function extractClassInfo(raw: string): ClassInfo | null {
  const m = parseMangled(raw);
  if (!m.isMember) {
    return null;
  }
  if (m.className !== null) {
    return {
      className: m.className,
      namespacePath: m.namespacePath,
      isConstructor: m.isConstructor,
      isDestructor: m.isDestructor,
      params: m.params,
    };
  }
  const sloppy = /__(ct|dt)__([A-Za-z_]\w*)$/.exec(raw);
  const kind = sloppy?.[1];
  const cls = sloppy?.[2];
  if (kind !== undefined && cls !== undefined) {
    return {
      className: cls,
      namespacePath: [],
      isConstructor: kind === "ct",
      isDestructor: kind === "dt",
      params: null,
    };
  }
  return null;
}

interface ClassInfo {
  className: string;
  namespacePath: string[];
  isConstructor: boolean;
  isDestructor: boolean;
  params: string | null;
}

/**
 * Every retail name the classifier knows about, in deterministic order:
 * symbols.txt names first (file order), then reloc-map names. `byName` is
 * first-wins, so the symbol-table name wins over a reloc-map duplicate.
 */
function* mergedNames(
  table: SymbolTable,
  relocMap?: RelocMap
): Iterable<string> {
  yield* table.byName.keys();
  if (relocMap !== undefined) {
    for (const n of relocMap.names) {
      if (!table.byName.has(n)) {
        yield n;
      }
    }
  }
}

/** Is `name` a retail name (symbols.txt or the reloc map)? */
function isRetail(name: string, table: SymbolTable, relocMap?: RelocMap): boolean {
  return table.byName.has(name) || (relocMap?.names.has(name) ?? false);
}

/** Drift rules (extc.py `classify`): embedded address → retail-extension →
 *  declared-extension (JP/region suffix) → shared mangled qualifier tail. */
function classifyDrift(
  name: string,
  table: SymbolTable,
  relocMap?: RelocMap
): ExtcClass | null {
  for (const addr of embeddedAddresses(name)) {
    const occupants = table.byAddress.get(addr);
    if (occupants !== undefined && occupants.some((o) => o !== name)) {
      return {
        category: "drift",
        name,
        resolved: occupants[0]!,
        reason: `embedded address ${hex(addr)} is retail symbol ${occupants[0]}`,
      };
    }
  }
  // declared is a strict prefix of a retail name (retail extends declared,
  // e.g. `func_8006EF04` vs `func_8006EF04__Q22cf13CfObjectPointFv`)
  for (const rn of mergedNames(table, relocMap)) {
    if (rn.length > name.length && rn.startsWith(name)) {
      return {
        category: "drift",
        name,
        resolved: rn,
        reason: `retail symbol ${rn} extends the declared name ${name}`,
      };
    }
  }
  // retail is a strict prefix of declared (declared adds a suffix — a
  // JP/region suffix like `_jp` / `_eu` is the common case)
  for (const rn of mergedNames(table, relocMap)) {
    if (name.length > rn.length && name.startsWith(rn)) {
      const suffix = name.slice(rn.length);
      const region = /^_?(eu|jp|us)(?:_|$)/.test(suffix);
      return {
        category: "drift",
        name,
        resolved: rn,
        reason: `declared name ${name} adds ${region ? "region/JP " : ""}suffix '${suffix}' to retail symbol ${rn}`,
      };
    }
  }
  // same class/namespace qualifier tail after the last `__`
  const last = name.lastIndexOf("__");
  if (last >= 0) {
    const tail = name.slice(last + 2);
    for (const rn of mergedNames(table, relocMap)) {
      const i = rn.lastIndexOf("__");
      if (i >= 0 && rn.slice(i + 2) === tail) {
        return {
          category: "drift",
          name,
          resolved: rn,
          reason: `mangled qualifier tail '${tail}' matches retail symbol ${rn}`,
        };
      }
    }
  }
  return null;
}

/** Name is retail-exact, but an embedded address maps to a *different* retail
 *  entry — the name is right, the address is old-layout (JP). Mirrors
 *  extc.py's `any(rn == name)` guard: fires only when the declared name is
 *  NOT among the address's occupants (the common `func_X` / `lbl_X` alias
 *  case must NOT fire). */
function staleAddressFor(
  name: string,
  table: SymbolTable
): [number, string] | null {
  for (const addr of embeddedAddresses(name)) {
    const occupants = table.byAddress.get(addr);
    if (occupants !== undefined && !occupants.includes(name)) {
      return [addr, occupants[0]!];
    }
  }
  return null;
}

/** The self-style-first-param axis: `'__' in name` OR a self-style first
 *  parameter (extc.py: `is_mangled = '__' in name` / `self_style =
 *  bool(RE_SELF_FIRST.search(body))`). Table membership is NOT required. */
function memberCandidateHintOf(decl: ExtcDecl): boolean {
  if (decl.name.includes("__")) {
    return true;
  }
  const body = decl.body ?? `(${(decl.params ?? []).join(", ")})`;
  return hasSelfStyleParam(body);
}

/**
 * Classify one extern "C" declaration against the retail symbol table,
 * returning the name-based {@link ExtcClass} category plus the independent
 * member-candidate hint. `decl.line` is carried for caller records (parity
 * with extc.py's `[rel, lineno, name]` entries) but does not affect the
 * classification. `relocMap` (optional) adds the retail_reloc_map.json
 * ground-truth names, like extc.py's merged name set.
 */
export function classifyExternC(
  decl: ExtcDecl,
  symbolTable: SymbolTable,
  relocMap?: RelocMap
): ClassifyResult {
  const name = decl.name.trim();
  const hint = memberCandidateHintOf(decl);
  if (name === "") {
    return {
      category: { category: "unparsed", reason: "could not extract a declared name" },
      memberCandidateHint: hint,
    };
  }

  const exactAddr = symbolTable.byName.get(name);
  const relocExact = relocMap?.names.has(name) ?? false;
  if (exactAddr !== undefined || relocExact) {
    const stale = staleAddressFor(name, symbolTable);
    if (stale !== null) {
      const [addr, resolved] = stale;
      return {
        category: {
          category: "jp_stale",
          name,
          address: exactAddr ?? 0,
          staleAddress: addr,
          resolved,
          reason: `name is retail at ${hex(exactAddr ?? 0)} but embedded address ${hex(addr)} is now retail symbol ${resolved} (stale JP layout)`,
        },
        memberCandidateHint: hint,
      };
    }
    return {
      category: {
        category: "exact",
        name,
        address: exactAddr ?? 0,
        reason:
          exactAddr !== undefined
            ? `name is a retail symbol at ${hex(exactAddr)}`
            : `name is a retail symbol in the reloc map (no symbols.txt address)`,
      },
      memberCandidateHint: hint,
    };
  }

  const drifted = classifyDrift(name, symbolTable, relocMap);
  if (drifted !== null) {
    return { category: drifted, memberCandidateHint: hint };
  }

  return {
    category: { category: "invented", name, reason: "no retail symbol matches the name" },
    memberCandidateHint: hint,
  };
}

/**
 * Scan source units for extern "C" declarations and classify each against the
 * table (extc.py `scan` parity). Every declaration whose name could not be
 * extracted classifies as `unparsed` — the scanner front-end is what makes
 * that category reachable.
 */
export function scanExternC(
  sources: SourceUnit[],
  symbolTable: SymbolTable,
  relocMap?: RelocMap
): Array<{ path: string; entry: ExtcEntry; classification: ClassifyResult }> {
  const out: Array<{ path: string; entry: ExtcEntry; classification: ClassifyResult }> = [];
  for (const src of sources) {
    const lines = src.text.split(/\r?\n/);
    for (const entry of extractEntries(lines)) {
      out.push({
        path: src.path,
        entry,
        classification: classifyExternC(
          {
            name: entry.name ?? "",
            body: entry.body,
            line: entry.lineno,
          },
          symbolTable,
          relocMap
        ),
      });
    }
  }
  return out;
}

// ── MWCC member mangling (extc.py `member_mangled`, plus ctor/dtor/Q forms) ─

/** The `<len><Class>` (unscoped) or `Q<count><len><Ns1>…<len><Class>` (scoped)
 *  class encoding. The `__Q` form encodes the full scope INCLUDING the class
 *  as its last token, so no separate class append follows it. */
function classEncoding(className: string, namespacePath: string[]): string {
  if (namespacePath.length === 0) {
    return `${className.length}${className}`;
  }
  const path =
    namespacePath[namespacePath.length - 1] === className
      ? namespacePath
      : [...namespacePath, className];
  return `Q${path.length}${path.map((t) => `${t.length}${t}`).join("")}`;
}

/** `name__<class-encoding>F<params>` — a no-arg method by default ("v"). */
export function mangleMember(
  className: string,
  memberName: string,
  params = "v",
  namespacePath: string[] = []
): string {
  return `${memberName}__${classEncoding(className, namespacePath)}F${params}`;
}

/** `__ct__<class-encoding>F<params>` — constructor. */
export function mangleCtor(
  className: string,
  params = "v",
  namespacePath: string[] = []
): string {
  return `__ct__${classEncoding(className, namespacePath)}F${params}`;
}

/** `__dt__<class-encoding>F<params>` — destructor. */
export function mangleDtor(
  className: string,
  params = "v",
  namespacePath: string[] = []
): string {
  return `__dt__${classEncoding(className, namespacePath)}F${params}`;
}

/** The retail rename target for converting `memberName` into a member of
 *  `className`: the ctor form when the name is the class itself, the dtor
 *  form for `~Class`, otherwise the method form. */
export function memberRenameTarget(
  className: string,
  memberName: string,
  params = "v",
  namespacePath: string[] = []
): string {
  if (memberName === className) {
    return mangleCtor(className, params, namespacePath);
  }
  if (memberName === `~${className}`) {
    return mangleDtor(className, params, namespacePath);
  }
  return mangleMember(className, memberName, params, namespacePath);
}

/** Python-parity naive target: `name__<len>ClassFv` (extc.py `member_mangled`). */
function memberMangled(classToken: string, memberName: string): string {
  return `${memberName}__${classToken.length}${classToken}Fv`;
}

/** Canonical MWCC rename target for a DEFINITION name: `__ct__` / `__dt__`
 *  declared names become the ctor/dtor form, anything else the method form.
 *  (Documented deviation from Python's naive `member_mangled`.) */
function defRenameTarget(
  className: string,
  memberName: string,
  namespacePath: string[]
): string {
  if (memberName.startsWith("__ct__")) {
    return mangleCtor(className, "v", namespacePath);
  }
  if (memberName.startsWith("__dt__")) {
    return mangleDtor(className, "v", namespacePath);
  }
  return mangleMember(className, memberName, "v", namespacePath);
}

/** Member-function part of a retail name: the text before the last member
 *  marker (`__Q…` / `__<len>Name`). */
function memberNameOf(name: string): string {
  const re = /__(?=Q\d|(?:\d+)[A-Za-z_@])/g;
  let idx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) {
    idx = m.index;
  }
  return idx < 0 ? name : name.slice(0, idx);
}

/** Canonical MWCC mangled name for a retail member, or null when the entry is
 *  already canonical. Conservative: dtk bucket/local artifacts (`@…`) and
 *  param forms other than `Fv` are left untouched. */
function canonicalTargetFor(name: string, ci: ClassInfo): string | null {
  if (name.includes("@")) {
    return null;
  }
  if (!ci.isConstructor && !ci.isDestructor && !name.includes("Fv")) {
    return null;
  }
  const params = ci.params ?? "v";
  const canonical = ci.isConstructor
    ? mangleCtor(ci.className, params, ci.namespacePath)
    : ci.isDestructor
      ? mangleDtor(ci.className, params, ci.namespacePath)
      : mangleMember(ci.className, memberNameOf(name), params, ci.namespacePath);
  return canonical === name ? null : canonical;
}

/**
 * Source-level call sites of the planned def names: every line that mentions
 * a def name as a whole word, excluding the def/decl lines themselves
 * (SPEC §13.3 requires "call sites" — extc.py only emits an `rg` instruction
 * for them; this is the TS source-scan equivalent, documented as a deviation
 * in docs/m1b-parity.md).
 */
function scanCallSites(
  sources: SourceUnit[],
  defNames: string[],
  hitLines: Set<string>
): MemberPlanCallSite[] {
  const out: MemberPlanCallSite[] = [];
  const patterns = defNames.map((n) => ({
    name: n,
    re: new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
  }));
  for (const src of sources) {
    const lines = src.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const key = `${src.path}:${i + 1}`;
      if (hitLines.has(key)) {
        continue; // the def/decl line itself is not a call site
      }
      for (const p of patterns) {
        if (p.re.test(line)) {
          out.push({ path: src.path, line: i + 1, name: p.name, snippet: line.trim() });
          break;
        }
      }
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
  return out;
}

/**
 * Source-scan hit list for a class token (extc.py `cmd_plan`): extern "C"
 * definitions whose body self-casts `((Class*)self)`, definitions whose
 * header carries a typed `Class*` param, and declarations referencing the
 * token that are retail-exact or retail-drift.
 */
function scanPlanHits(
  token: string,
  sources: SourceUnit[],
  table: SymbolTable,
  relocMap?: RelocMap
): MemberPlanHit[] {
  const hits: MemberPlanHit[] = [];
  const paramRe = new RegExp(`\\(\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*`);
  for (const src of sources) {
    if (!src.text.includes(token)) {
      continue;
    }
    const lines = src.text.split(/\r?\n/);
    for (const def of externCDefsWithBodies(lines)) {
      const cast = RE_CLASS_CAST.exec(def.body);
      if (cast !== null && cast[1] === token) {
        hits.push({
          path: src.path,
          line: def.lineno,
          name: def.name,
          kind: "def-selfcast",
          header: def.header,
        });
      } else if (paramRe.test(def.header)) {
        hits.push({
          path: src.path,
          line: def.lineno,
          name: def.name,
          kind: "def-param",
          header: def.header,
        });
      }
    }
    for (const entry of extractEntries(lines)) {
      if (entry.name === null) {
        continue;
      }
      if (
        entry.name.includes(token) &&
        (isRetail(entry.name, table, relocMap) ||
          classifyExternC(
            { name: entry.name, body: entry.body, line: entry.lineno },
            table,
            relocMap
          ).category.category !== "invented")
      ) {
        hits.push({
          path: src.path,
          line: entry.lineno,
          name: entry.name,
          kind: "decl",
          header: entry.raw,
        });
      }
    }
  }
  hits.sort((a, b) => (a.line - b.line) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return hits;
}

/**
 * Member-conversion plan for a class token: the MWCC member-mangling rename
 * targets (ctor/dtor/scoped forms), every retail member of the class already
 * in the table, every retail name containing the token, and — when `sources`
 * are supplied — the source-scan hit list (self-cast defs / typed-self defs /
 * declarations) with per-hit mangling targets, plus the ceremony checklist
 * (rename decl/def, fix call sites, update symbols.txt) — the extc.py `plan`
 * recipe.
 */
export function planMemberConversion(
  className: string,
  symbolTable: SymbolTable,
  sources?: SourceUnit[],
  relocMap?: RelocMap
): MemberPlan {
  const members: RetailMember[] = [];
  let namespacePath: string[] = [];
  for (const name of symbolTable.byName.keys()) {
    const ci = extractClassInfo(name);
    if (ci === null || ci.className !== className) {
      continue;
    }
    if (namespacePath.length === 0 && ci.namespacePath.length > 0) {
      namespacePath = ci.namespacePath;
    }
    members.push({
      name,
      address: symbolTable.byName.get(name) ?? 0,
      className: ci.className,
      namespacePath: ci.namespacePath,
      isConstructor: ci.isConstructor,
      isDestructor: ci.isDestructor,
      params: ci.params,
      canonicalTarget: canonicalTargetFor(name, ci),
    });
  }
  members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const retailSymbols = [...mergedNames(symbolTable, relocMap)]
    .filter((n) => n.includes(className))
    .sort();

  const hits = sources !== undefined ? scanPlanHits(className, sources, symbolTable, relocMap) : [];
  const hitLines = new Set(hits.map((h) => `${h.path}:${h.line}`));
  const callSites =
    sources !== undefined
      ? scanCallSites(sources, hits.filter((h) => h.kind.startsWith("def")).map((h) => h.name), hitLines)
      : [];
  const targets: MemberPlanTarget[] = hits
    .filter((h) => h.kind.startsWith("def"))
    .map((h) => ({
      line: h.line,
      name: h.name,
      mangled: memberMangled(className, h.name),
      canonical: defRenameTarget(className, h.name, namespacePath),
    }));

  const ctorTarget = mangleCtor(className, "v", namespacePath);
  const dtorTarget = mangleDtor(className, "v", namespacePath);
  const renames = members.filter((m) => m.canonicalTarget !== null);
  const ceremony: CeremonyStep[] = [
    {
      step: "rename-decl",
      instruction: `convert the extern "C" declaration into a member declaration in class ${className} (header)`,
    },
    {
      step: "rename-def",
      instruction: `define it as ${className}::<member>() { ... } so MWCC emits the mangled target (ctor: ${ctorTarget})`,
    },
    {
      step: "fix-call-sites",
      instruction:
        callSites.length > 0
          ? `update ${callSites.length} source call site(s) to ${className}::<member>() — see plan.callSites`
          : hits.length > 0
            ? `update call sites to ${className}::<member>() — ${hits.length} extern "C" def(s)/decl(s) reference the class (see hits)`
            : `update call sites to ${className}::<member>() — find them with: rg -l "\\b<old-name>\\b" src libs`,
    },
    {
      step: "update-symbols",
      instruction:
        renames.length > 0
          ? `rename symbols.txt entries (all regions): ${renames.map((m) => `${m.name} -> ${m.canonicalTarget}`).join(", ")}`
          : `no deviant symbols.txt entries for ${className}; verify each retail member's name matches what MWCC emits`,
    },
  ];

  return {
    className,
    namespacePath,
    ctorTarget,
    dtorTarget,
    methodTargetTemplate: mangleMember(className, "<member>", "v", namespacePath),
    existingMembers: members,
    retailSymbols,
    hits,
    callSites,
    targets,
    ceremony,
  };
}

// Re-export the scanner entry-point used by callers that want the raw name
// extraction without classification (extc.py `name_from` parity).
export { nameFrom };
