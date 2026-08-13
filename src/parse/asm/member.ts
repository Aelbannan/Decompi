/**
 * M1b: member-vs-free classifier (SPEC §13.3).
 *
 * Port of `tools/coop/member_check.py` (Xenoblade co-op fork) — the tiered
 * audit rules verified by independent agents (kimi-k3 / glm-5.2, 2026-08-08)
 * on the CfGameManager mis-annotation set:
 *
 *   N1  any call site passes a NON-ZERO, NON-ADDRESS constant in r3
 *       (li/lis immediate)                -> NOT a non-static member  [sound, decisive]
 *   N2  callee never dereferences r3 and never forwards it in r3
 *       position (only integer ops / r4+ args) -> NOT a non-static member
 *   N3  callee's max r3-relative access offset >= class size (anchor)
 *                                         -> NOT a member of that class  [sound]
 *   P1  (hint) symbol address found as a 4-byte pointer in retail .data
 *                                         -> candidate vtable / function-pointer slot
 *   Tier B  zero instance-anchored call sites + stack-heavy provenance
 *                                         -> flag for review (heuristic)
 *   Tier C  callee derefs r3 in-bounds + ambiguous provenance
 *                                         -> UNDECIDABLE — never auto-claim
 *
 * Deliberately NOT used as evidence (refuted in-repo):
 *   - stack address in r3 (a member can be called on a stack-allocated object)
 *   - this-source clustering (a member can pass `this` to free helpers)
 *
 * The single exported entry point is `classifyMember(input): MemberVerdict`;
 * the internal `SymbolAnalysis` (`analyzeSymbol`) mirrors
 * `member_check.classify_symbol` field-for-field. Verdict chain order matches
 * the reference exactly: N1 -> integer_only -> N2 -> N3 -> vtable_dispatch ->
 * deref tiers -> not-a-member fallback.
 *
 * Reference quirks preserved on purpose (each noted inline):
 *   - `callee_r3_usage` counts r3 by SUBSTRING ("r3" inside "r30" counts),
 *     matching `if "r3" in full` in the reference;
 *   - direct `LOAD_FIELD` provenance requires 3+ operand tokens
 *     (`len(op) >= 3`), so `lwz r3, X(rY)` is classified `LWZ` unless it flows
 *     through an `mr` chain (the `len(o) >= 2` path);
 *   - `N1` ignores signed immediates and label operands — only `0x…`/decimal
 *     constants match, so `li r3, -0x1` and `lis r3, lbl@ha` never fire N1
 *     (parity with `dtk.passesConstInR3` / `member_check._const_imm`);
 *   - a symbol with no body and no call sites falls back to `not_member`
 *     ("r3 never used as object base") — reference behavior;
 *   - `header_drift`'s nested classification passes no class-size anchor and
 *     no data hits (mirrors the reference's `classify_symbol(retail, idx)`);
 *   - r3 provenance back-scans the FILE-GLOBAL instruction list (window
 *     i-1..i-9 can cross into the prior function), true parity with
 *     `member_check.r3_provenance(idx.files[rel], i)`.
 *
 * Deliberate deviations (documented in docs/m1b-parity.md):
 *   - the in-bounds-deref-with-ambiguous-provenance case is reported as
 *     verdict kind `"undecidable"` (SPEC §13.3 `member.tier_c -> undecidable`)
 *     while `verdictString` carries the reference's exact string
 *     ("Tier B: flag for review (derefs r3; no instance-anchored call
 *     sites)") — the reference's own docstring defines Tier C as UNDECIDABLE
 *     even though `classify_symbol` labels that case "Tier B";
 *   - `header_drift`'s confident member/not-member classification is
 *     unaffected because the Tier C string is neither "NOT non-static member"
 *     nor "possible member/virtual".
 *
 * Single deliberate deviation (documented): the in-bounds-deref-with-
 * ambiguous-provenance case is reported as verdict `"undecidable"`
 * (`member.tier_c`). The reference docstring defines Tier C as UNDECIDABLE
 * even though `classify_symbol` labels that case "Tier B" in its verdict
 * string; SPEC §13.3 lists `member.tier_c -> undecidable`. `header_drift`'s
 * confident member/not-member classification is unaffected because the Tier C
 * string is neither "NOT non-static member" nor "possible member/virtual".
 */
import {
  INTEGER_OPS,
  READERS,
  blTarget,
  derefLoadOffset,
  derefStoreOffset,
} from "./dtk.js";
import type { AsmInstruction, ParsedAsm } from "./dtk.js";
import { parseMangled } from "../symbols/table.js";
import type { SymbolTable } from "../symbols/table.js";
import type { DataHit } from "./objscan.js";

/** Terminal classification of one retail symbol. */
export type VerdictKind =
  | "not_member"
  | "member"
  | "undecidable"
  | "integer_only"
  | "vtable_dispatch"
  | "review";

/**
 * Public verdict: a terminal `verdict` plus the supporting `evidence`
 * (factual observations) and `reasons` (rule triggers) that led there. Both
 * arrays are deterministic (call-site order, sorted provenance kinds, fixed
 * rule order).
 */
export interface MemberVerdict {
  verdict: VerdictKind;
  evidence: string[];
  reasons: string[];
}

/**
 * Inputs for `classifyMember`, built from the M1b adapter data sources:
 * parsed retail asm (`dtk.ts`), symbol table (`table.ts`), `.o` data hits
 * (`objscan.ts`), the target symbol, and its class-size anchor.
 *
 * `headerText` (class header `.hpp`) and `classSourceText` (class TU) are
 * optional source-side inputs for the `header_drift` / `fake_members`
 * evidence streams; when absent those checks are skipped.
 */
export interface ClassifyMemberInput {
  /** Parsed retail asm dump(s): functions + `bl` edges (dtk.ts). */
  asm: ParsedAsm;
  /** Symbol address/name table (table.ts); address lookup drives P1. */
  symbols: SymbolTable;
  /** 4-byte big-endian pointer hits scanned from retail `.o` files (objscan.ts). */
  dataHits: DataHit[];
  /** Target symbol to classify (e.g. `func_8007C0F8__Q22cf13CfGameManagerFv`). */
  targetSymbol: string;
  /** Class-size anchor for the N3 out-of-bounds check (`0` disables N3). */
  classSize: number;
  /** Optional class header text for the `header_drift` scan. */
  headerText?: string;
  /** Optional class translation-unit text for the `fake_members` scan. */
  classSourceText?: string;
}

// ---------------------------------------------------------------------------
// Internal analysis shapes
// ---------------------------------------------------------------------------

/** One `bl` call site of a target symbol within a caller function. */
interface CallSite {
  caller: string;
  index: number;
}

/** Classified last-r3-write before a call site (kind + reference detail). */
interface Provenance {
  kind: string;
  detail: string;
}

/** `callee_r3_usage` port — how the callee uses r3 (member_check names). */
interface CalleeUsage {
  deref: boolean;
  derefMaxOffset: number;
  stores: boolean;
  vtableDispatch: boolean;
  integerOnly: boolean;
  r3Ops: number;
  derefs: number;
}

/** `callee_params` port — consumed GPR/FPR argument classes. */
interface BinaryParams {
  gprs: Array<[string, string]>;
  fprs: string[];
}

/** Function-body + `bl`-edge index built from a `ParsedAsm`. Call-site
 *  indices are FILE-GLOBAL (into {@link AsmIndex.fileInsns}), mirroring
 *  `member_check.AsmIndex.calls` — this is what lets the r3 back-scan cross
 *  into the prior function, like `r3_provenance(idx.files[rel], i)` in the
 *  reference. */
interface AsmIndex {
  /** flat instruction list for the parsed file, in parse order. */
  fileInsns: AsmInstruction[];
  /** function name -> its [start, end) index range in `fileInsns`. */
  fnRanges: Map<string, [number, number]>;
  /** function name -> its instructions (the file-global slice). */
  bodies: Map<string, AsmInstruction[]>;
  /** target symbol -> call sites with FILE-GLOBAL instruction indices. */
  callSites: Map<string, CallSite[]>;
}

/** Full per-symbol analysis — mirror of `member_check.classify_symbol`. */
interface SymbolAnalysis {
  symbol: string;
  sites: CallSite[];
  provenance: Provenance[];
  provenanceCounts: Map<string, number>;
  callee: CalleeUsage;
  params: BinaryParams;
  classSize: number;
  bodyPresent: boolean;
  n1: boolean;
  n2: boolean;
  n3: boolean;
  intOnly: boolean;
  stackHeavy: boolean;
  instanceAnchored: number;
  vtableHints: DataHit[];
  kind: VerdictKind;
  /** the reference's exact verdict string (drives `header_drift` confident
   *  flags); always equals what `member_check.classify_symbol` would emit for
   *  the same facts, even when the TS `kind` deviates (tier_c) */
  verdictString: string;
}

interface HeaderDriftFinding {
  line: number;
  decl: string;
  retail: string;
  drift: string[];
}

interface FakeMemberFinding {
  line: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Reference-faithful regexes / mnemonic sets
// ---------------------------------------------------------------------------

/** Mnemonics that READ a register in `first_mention_is_read` (exact list). */
const READ_ONLY = [
  "stw", "stb", "sth", "stfs", "stfd", "stwx", "cmpwi", "cmpw",
  "cmplwi", "cmplw", "cmp", "mtctr", "mtlr", "bctrl", "bl", "bc",
];

/**
 * Load mnemonics for `LOAD_FIELD` provenance (exact reference set — note
 * `lha` is absent here even though the DEREF regexes include it).
 */
const LOAD_MNEMONICS = ["lwz", "lbz", "lhz", "lfs", "lfd"];

/** Store mnemonics that mark `stores` in `callee_r3_usage` (exact list). */
const STORE_MNEMONICS = ["stw", "stb", "sth", "stfs", "stfd"];

/** `member_check._const_imm` — matches dtk `passesConstInR3` semantics. */
const CONST_IMM_RE = /(?:li|lis)\s+r3,\s*(0x[0-9A-Fa-f]+|\d+)/;

/** `member_check.header_drift` header decl: `[static] T func_XXXXXXXX(`. */
const HEADER_DECL_RE = /(static\s+)?[\w:<>*&]+\s+(func_[0-9A-Fa-f]{8})\s*\(/;

/** `member_check.TRICK_RE` — this==nullptr / r3==0 register-read trick. */
const TRICK_RE = /this\s*(?:==|!=)\s*(?:nullptr|NULL|0)|(?:r3|r4|r5|r6)\s*==\s*0/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

/** READERS mnemonics match by PREFIX (`cmp` covers `cmpwi`, `st` covers `stw`). */
function isReaderMnemonic(mnemonic: string): boolean {
  return (READERS as readonly string[]).some((r) => mnemonic.startsWith(r));
}

/**
 * Operand tokens with commas stripped — mirror of `member_check`'s
 * `ops.replace("  ", " ").split(" ")` + strip + rstrip(",").
 */
function splitOps(operands: string): string[] {
  return operands
    .replace(/ {2}/g, " ")
    .split(" ")
    .map((t) => t.trim().replace(/,+$/, ""))
    .filter((t) => t.length > 0);
}

/**
 * N1 constant extraction from a CONSTANT provenance detail (e.g.
 * `"li r3, 5"`), mirroring `_const_imm`. Returns `null` for signed
 * immediates, label operands, and anything not matching `li/lis r3, 0x…|N`.
 */
function constImmediate(detail: string): number | null {
  const m = CONST_IMM_RE.exec(detail);
  if (!m) {
    return null;
  }
  const raw = m[1]!;
  return raw.startsWith("0x") ? parseInt(raw, 16) : parseInt(raw, 10);
}

/** N1 predicate: provenance is a CONSTANT with a non-zero immediate. */
function isNonZeroConstant(p: Provenance): boolean {
  if (p.kind !== "CONSTANT") {
    return false;
  }
  const imm = constImmediate(p.detail);
  return imm !== null && imm !== 0;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * Build the function-body and `bl`-call-site index from a parsed dump. One
 * entry per call site (multiple sites from the same caller are kept), like
 * `member_check.AsmIndex.calls`. Local labels / `@sda21`-style targets are
 * filtered by `dtk.blTarget`. The flat per-file instruction list is the
 * concatenation of the parsed functions' instructions in file order — since
 * `parseAsmFile` keeps only `.fn`-wrapped instructions (documented deviation:
 * real dtk always wraps), the flat list is the TS analogue of the reference's
 * per-file instruction list, and call-site indices are file-global so the r3
 * provenance back-scan can cross function boundaries exactly like the
 * reference.
 */
function buildIndex(parsed: ParsedAsm): AsmIndex {
  const fileInsns: AsmInstruction[] = [];
  const fnRanges = new Map<string, [number, number]>();
  const bodies = new Map<string, AsmInstruction[]>();
  const callSites = new Map<string, CallSite[]>();
  for (const fn of parsed.functions) {
    const start = fileInsns.length;
    for (const insn of fn.instructions) {
      fileInsns.push(insn);
    }
    const end = fileInsns.length;
    fnRanges.set(fn.name, [start, end]);
    bodies.set(fn.name, fn.instructions);
    fn.instructions.forEach((insn, index) => {
      if (insn.mnemonic !== "bl") {
        return;
      }
      const target = blTarget(insn.operands);
      if (target === null) {
        return;
      }
      let sites = callSites.get(target);
      if (!sites) {
        sites = [];
        callSites.set(target, sites);
      }
      sites.push({ caller: fn.name, index: start + index });
    });
  }
  return { fileInsns, fnRanges, bodies, callSites };
}

// ---------------------------------------------------------------------------
// r3 provenance (port of `member_check.r3_provenance`)
// ---------------------------------------------------------------------------

/**
 * Classify the last r3 WRITE before instruction index `i`, chasing `mr`
 * chains one level. A `bl` clobbers r3, so the back-scan stops there
 * (`CALL_RESULT`). Window: up to 8 instructions, mirroring
 * `range(i - 1, max(-1, i - 9), -1)`. `insns` is the FILE-GLOBAL instruction
 * list, so the window may cross into the prior function — parity with
 * `member_check.r3_provenance(idx.files[rel], i)`.
 */
function r3Provenance(insns: AsmInstruction[], i: number): Provenance {
  const end = Math.max(-1, i - 9);
  for (let j = i - 1; j > end; j--) {
    const insn = insns[j]!;
    const mnem = insn.mnemonic;
    const ops = insn.operands;
    if (mnem === "bl") {
      return { kind: "CALL_RESULT", detail: ops };
    }
    if (!/\br3\b/.test(ops)) {
      continue;
    }
    if (isReaderMnemonic(mnem)) {
      continue;
    }
    const op = splitOps(ops);
    if (mnem === "li" || mnem === "lis") {
      return { kind: "CONSTANT", detail: `${mnem} ${ops}` };
    }
    if (mnem === "mr" && op.length > 0 && op[0] === "r3") {
      const src = op[1] ?? "?";
      const chainEnd = Math.max(-1, j - 9);
      for (let k = j - 1; k > chainEnd; k--) {
        const c = insns[k]!;
        const m2 = c.mnemonic;
        const o2 = c.operands;
        if (!new RegExp(`\\b${src}\\b`).test(o2)) {
          continue;
        }
        if (isReaderMnemonic(m2)) {
          continue;
        }
        const o = splitOps(o2);
        if (m2 === "li" || m2 === "lis") {
          return { kind: "CONSTANT", detail: `${m2} ${o2}` };
        }
        if ((LOAD_MNEMONICS as readonly string[]).includes(m2) && o.length >= 2) {
          return { kind: "LOAD_FIELD", detail: o2 };
        }
        if (m2 === "addi" && o.length >= 3) {
          if (o2.includes("@l") || o2.includes("@ha")) {
            return { kind: "ADDR_LABEL", detail: o2 };
          }
          if (o[1] === "r1") {
            return { kind: "ADDR_STACK", detail: o2 };
          }
          return { kind: "ADDI", detail: o2 };
        }
        if (m2 === "bl") {
          // Unreachable: `bl` is a READER and was skipped above; kept for
          // structural parity with the reference.
          return { kind: "CALL_RESULT", detail: o2 };
        }
        if (m2 === "mr") {
          return { kind: "COPY", detail: o2 };
        }
        return { kind: m2.toUpperCase(), detail: o2 };
      }
      return { kind: "COPY", detail: ops };
    }
    // Reference quirk: the direct LOAD_FIELD path requires >= 3 tokens, so
    // `lwz r3, X(rY)` classifies as `LWZ` unless reached via an `mr` chain.
    if ((LOAD_MNEMONICS as readonly string[]).includes(mnem) && op.length >= 3 && op[0] === "r3") {
      return { kind: "LOAD_FIELD", detail: ops };
    }
    if (mnem === "addi" && op.length > 0 && op[0] === "r3") {
      if (ops.includes("@l") || ops.includes("@ha")) {
        return { kind: "ADDR_LABEL", detail: ops };
      }
      if (op.length >= 3 && op[1] === "r1") {
        return { kind: "ADDR_STACK", detail: ops };
      }
      return { kind: "ADDI", detail: ops };
    }
    if (mnem === "bl") {
      // Unreachable: the first check returns on `bl`; kept for parity.
      return { kind: "CALL_RESULT", detail: ops };
    }
    return { kind: mnem.toUpperCase(), detail: ops };
  }
  return { kind: "UNKNOWN", detail: "" };
}

// ---------------------------------------------------------------------------
// Callee analysis (ports of `callee_r3_usage` / `callee_params`)
// ---------------------------------------------------------------------------

/**
 * How the callee uses r3 (`member_check.callee_r3_usage`). `r3_ops` counts
 * by SUBSTRING ("r3" inside "r30" counts — reference quirk preserved).
 * `vtableDispatch` = r12 loaded via `(r3)` then `bctrl`; `integerOnly` =
 * r3 used but never deref'd and only as a value (arithmetic, or not
 * forwarded via mr/bl/lwz/stw).
 */
function calleeR3Usage(body: AsmInstruction[]): CalleeUsage {
  let deref = false;
  let derefMaxOffset = 0;
  let stores = false;
  let integerOpSeen = false;
  let r3Ops = 0;
  let derefs = 0;
  let forwardedR3 = false;
  let r12FromR3 = false;
  let hasBctrl = false;
  for (const insn of body) {
    const { mnemonic, operands } = insn;
    const full = operands ? `${mnemonic} ${operands}` : mnemonic;
    if (mnemonic === "lwz" && /\br12\b/.test(operands) && /\(r3\)/.test(operands)) {
      r12FromR3 = true; // method pointer loaded via this's vtable
    }
    if (mnemonic === "bctrl") {
      hasBctrl = true;
    }
    if (!full.includes("r3")) {
      continue;
    }
    r3Ops++;
    const off = derefLoadOffset(insn) ?? derefStoreOffset(insn);
    if (off !== null) {
      derefs++;
      deref = true;
      if (!Number.isNaN(off)) {
        derefMaxOffset = Math.max(derefMaxOffset, off);
      }
      if ((STORE_MNEMONICS as readonly string[]).includes(mnemonic)) {
        stores = true;
      }
      continue;
    }
    if ((INTEGER_OPS as readonly string[]).includes(mnemonic)) {
      integerOpSeen = true;
    }
    // Reference regex is `r3\b` (no leading boundary) — mirrored exactly.
    if (
      (mnemonic === "mr" || mnemonic === "bl" || mnemonic === "lwz" || mnemonic === "stw") &&
      /r3\b/.test(operands)
    ) {
      forwardedR3 = true;
    }
  }
  const vtableDispatch = r12FromR3 && hasBctrl;
  const integerOnly = derefs === 0 && r3Ops > 0 && (integerOpSeen || !forwardedR3);
  return { deref, derefMaxOffset, stores, vtableDispatch, integerOnly, r3Ops, derefs };
}

/** Is the register's first use a READ (i.e. a consumed parameter)? */
function firstMentionIsRead(body: AsmInstruction[], reg: string): boolean | null {
  for (const { mnemonic, operands } of body) {
    if (!new RegExp(`\\b${reg}\\b`).test(operands)) {
      continue;
    }
    if ((READ_ONLY as readonly string[]).includes(mnemonic)) {
      return true; // store/cmp/ctrl: register is read
    }
    const op = splitOps(operands);
    if (op.length > 0 && op[0] === reg) {
      // write to reg — but read-modify-write (`slwi r3, r3, N`) still
      // consumes the input value
      if (op.length > 1 && op.slice(1).includes(reg)) {
        return true;
      }
      return false;
    }
    return true;
  }
  return null;
}

/**
 * Binary param evidence (`member_check.callee_params`): which GPR/FPR
 * arguments the callee consumes. Classes: 'ptr' (deref base), 'int'
 * (arithmetic/cmp), 'bool' (compared only against 0x0/0x1), 'opaque'
 * (only moved/passed on).
 */
function calleeParams(body: AsmInstruction[]): BinaryParams {
  const gprs: Array<[string, string]> = [];
  const fprs: string[] = [];
  if (body.length === 0) {
    return { gprs, fprs };
  }
  for (let n = 3; n <= 10; n++) {
    const reg = `r${n}`;
    if (firstMentionIsRead(body, reg) !== true) {
      continue;
    }
    const isPtr = body.some(({ mnemonic, operands }) =>
      new RegExp(`\\((${reg})\\)`).test(operands ? `${mnemonic} ${operands}` : mnemonic)
    );
    const isInt = body.some(
      ({ mnemonic, operands }) =>
        (INTEGER_OPS as readonly string[]).includes(mnemonic) ||
        (mnemonic.startsWith("cmp") && new RegExp(`\\b${reg}\\b`).test(operands))
    );
    const cmps = body
      .filter(
        ({ mnemonic, operands }) =>
          mnemonic.startsWith("cmp") && new RegExp(`\\b${reg}\\b`).test(operands)
      )
      .map(({ operands }) => operands);
    let cls: string;
    if (isPtr) {
      cls = "ptr";
    } else if (cmps.length > 0 && cmps.every((o) => /0x[01]$/.test(o))) {
      cls = "bool";
    } else if (isInt) {
      cls = "int";
    } else {
      cls = "opaque";
    }
    gprs.push([reg, cls]);
  }
  for (let n = 1; n <= 4; n++) {
    const reg = `f${n}`;
    if (firstMentionIsRead(body, reg) === true) {
      fprs.push(reg);
    }
  }
  return { gprs, fprs };
}

// ---------------------------------------------------------------------------
// Per-symbol classification (port of `member_check.classify_symbol`)
// ---------------------------------------------------------------------------

/**
 * Tiered verdict for one retail symbol. Verdict chain order matches the
 * reference exactly: N1 -> integer_only -> N2 -> N3 -> vtable_dispatch ->
 * deref tiers (tier_b / member / tier_c) -> not-a-member fallback.
 */
function analyzeSymbol(
  idx: AsmIndex,
  symbol: string,
  classSize: number,
  addr: number | undefined,
  dataHits: DataHit[]
): SymbolAnalysis {
  const sites = idx.callSites.get(symbol) ?? [];
  const provenance = sites.map((s) => r3Provenance(idx.fileInsns, s.index));
  const provenanceCounts = new Map<string, number>();
  for (const p of provenance) {
    provenanceCounts.set(p.kind, (provenanceCounts.get(p.kind) ?? 0) + 1);
  }

  const body = idx.bodies.get(symbol);
  const callee: CalleeUsage =
    body !== undefined
      ? calleeR3Usage(body)
      : { deref: false, derefMaxOffset: 0, stores: false, vtableDispatch: false, integerOnly: false, r3Ops: 0, derefs: 0 };
  const params: BinaryParams =
    body !== undefined ? calleeParams(body) : { gprs: [], fprs: [] };

  // N1: any call site passes a NON-ZERO, NON-ADDRESS constant in r3 —
  // zero is ambiguous (null-this UB vs null pointer arg) and excluded.
  const n1 = provenance.some(isNonZeroConstant);
  // N2: callee never derefs r3 (and uses it at all).
  const n2 = body !== undefined && !callee.deref && callee.r3Ops > 0;
  // N3: max r3-relative offset >= class size.
  const n3 = classSize > 0 && callee.derefMaxOffset >= classSize;
  // integer-only: r3 used solely as an integer (never deref'd).
  const intOnly = callee.integerOnly;

  const stackHeavy = (provenanceCounts.get("ADDR_STACK") ?? 0) === sites.length && sites.length > 0;
  const instanceAnchored = (provenanceCounts.get("ADDR_LABEL") ?? 0) + (provenanceCounts.get("LOAD_FIELD") ?? 0);
  // P1 (hint only — never changes the verdict): address stored as a 4-byte
  // big-endian .data pointer -> vtable / function-pointer candidate.
  const vtableHints = addr !== undefined ? dataHits.filter((h) => h.address === addr) : [];

  let kind: VerdictKind;
  let verdictString: string;
  if (n1) {
    kind = "not_member";
    verdictString = "NOT non-static member (N1: constant r3 at call site)";
  } else if (intOnly) {
    kind = "integer_only";
    verdictString = "NOT non-static member (r3 used as integer, never deref'd)";
  } else if (n2) {
    kind = "not_member";
    verdictString = "NOT non-static member (N2: r3 never deref'd/forwarded)";
  } else if (n3) {
    kind = "not_member";
    verdictString = `NOT member of class (N3: r3 offset ${hex(callee.derefMaxOffset)} >= size ${hex(classSize)})`;
  } else if (callee.vtableDispatch) {
    kind = "vtable_dispatch";
    verdictString = "possible virtual member (vtable dispatch via r3; confirm vtable membership)";
  } else if (callee.deref) {
    if (stackHeavy) {
      // Tier B: zero instance-anchored call sites + stack-heavy provenance.
      kind = "review";
      verdictString = "Tier B: flag for review (derefs r3 but all-stack provenance)";
    } else if (instanceAnchored > 0) {
      kind = "member";
      verdictString = "possible member (instance-anchored r3 calls; not exclusive)";
    } else {
      // Tier C in the SPEC sense (UNDECIDABLE — never auto-claim). The
      // reference classifies this case as "Tier B" in its verdict string but
      // its docstring / SPEC §13.3 define it as UNDECIDABLE; the KIND follows
      // the SPEC while verdictString carries the reference's exact string.
      kind = "undecidable";
      verdictString = "Tier B: flag for review (derefs r3; no instance-anchored call sites)";
    }
  } else {
    kind = "not_member";
    verdictString = "NOT non-static member (r3 never used as object base)";
  }

  return {
    symbol,
    sites,
    provenance,
    provenanceCounts,
    callee,
    params,
    classSize,
    bodyPresent: body !== undefined,
    n1,
    n2,
    n3,
    intOnly,
    stackHeavy,
    instanceAnchored,
    vtableHints,
    kind,
    verdictString,
  };
}

// ---------------------------------------------------------------------------
// Source-side evidence streams (ports of `header_drift` / `fake_members`)
// ---------------------------------------------------------------------------

/**
 * Header declarations contradicted by binary evidence (header-as-error-
 * surface). For each `func_XXXXXXXX(` decl in the header text, the retail
 * symbol is classified from the dump and drift is reported where the binary
 * disagrees with the header's declared static-ness or param count.
 *
 * Nested classification mirrors the reference: no class-size anchor and no
 * data hits are passed to `classify_symbol(retail, idx)`.
 */
function headerDrift(headerText: string, symbols: SymbolTable, idx: AsmIndex): HeaderDriftFinding[] {
  const out: HeaderDriftFinding[] = [];
  const lines = headerText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = HEADER_DECL_RE.exec(line);
    if (m === null) {
      continue;
    }
    const isStatic = m[1] !== undefined;
    const base = m[2]!;
    const pOpen = line.indexOf("(");
    const pClose = line.lastIndexOf(")");
    const paramsHdr = pOpen >= 0 && pClose > pOpen ? line.slice(pOpen + 1, pClose) : "";
    const nparamsHdr = paramsHdr.trim() === "" ? 0 : paramsHdr.split(",").length;
    // retail symbol lookup: first table name starting with the base
    // (mirrors the symbols.txt line-prefix scan in the reference)
    let retail: string | undefined;
    for (const name of symbols.byName.keys()) {
      if (name.startsWith(base)) {
        retail = name;
        break;
      }
    }
    if (retail === undefined) {
      continue;
    }
    const r = analyzeSymbol(idx, retail, 0, undefined, []);
    const nparamsBin = r.params.gprs.length + r.params.fprs.length;
    const confidentNotMember = r.verdictString.startsWith("NOT non-static member");
    const confidentMember =
      r.verdictString.includes("possible member") || r.verdictString.includes("possible virtual");
    const drift: string[] = [];
    if (isStatic && confidentMember) {
      drift.push("header declares static but binary shows this-taking");
    }
    if (!isStatic && confidentNotMember) {
      drift.push("header declares member but binary proves no-this");
    }
    if (nparamsBin > 0 && nparamsBin !== nparamsHdr) {
      drift.push(`header ${nparamsHdr} params, binary ${nparamsBin}`);
    }
    if (drift.length > 0) {
      out.push({ line: i + 1, decl: line.trim(), retail, drift });
    }
  }
  return out;
}

/**
 * `fake_members` port: member definitions using the "this == nullptr"
 * register-read trick (a recovered-as-member function that actually takes
 * args in r3..). Lines that match the trick but are not themselves a
 * `ClassName::` declaration are reported.
 */
function fakeMembers(sourceText: string, className: string): FakeMemberFinding[] {
  const hits: FakeMemberFinding[] = [];
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(`${escaped}::\\w+\\s*\\(`);
  const lines = sourceText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (TRICK_RE.test(line) && !declRe.test(line)) {
      hits.push({ line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Public verdict assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the public `MemberVerdict`: `evidence` = deterministic factual
 * observations (call sites + provenance, callee usage, binary params, P1
 * hits, header drift, fake members); `reasons` = rule triggers in the
 * reference's evaluation order, ending with the final verdict.
 */
function buildVerdict(
  a: SymbolAnalysis,
  addr: number | undefined,
  drift: HeaderDriftFinding[],
  fakes: FakeMemberFinding[]
): MemberVerdict {
  const evidence: string[] = [];
  evidence.push(`symbol: ${a.symbol}`);
  if (addr !== undefined) {
    evidence.push(`symbol address: ${hex(addr)}`);
  }
  evidence.push(`class size anchor: ${hex(a.classSize)}`);
  if (a.sites.length === 0) {
    evidence.push("no call sites in dump");
  } else {
    a.sites.forEach((s, i) => {
      const p = a.provenance[i]!;
      evidence.push(`call site ${i + 1}: ${s.caller}@${s.index} → r3 = ${p.kind}${p.detail ? ` (${p.detail})` : ""}`);
    });
  }
  const counts = [...a.provenanceCounts.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  evidence.push(`r3 provenance: ${counts.map(([k, n]) => `${k}x${n}`).join(", ") || "(none)"}`);
  evidence.push(
    `callee r3 usage: deref=${a.callee.deref} max_offset=${hex(a.callee.derefMaxOffset)} ` +
      `stores=${a.callee.stores} vtable_dispatch=${a.callee.vtableDispatch} ` +
      `integer_only=${a.callee.integerOnly} r3_ops=${a.callee.r3Ops} derefs=${a.callee.derefs}`
  );
  const gprStr = a.params.gprs.map(([reg, cls]) => `${reg}=${cls}`).join(", ");
  const fprStr = a.params.fprs.join(", ");
  evidence.push(`binary params: gprs=[${gprStr}] fprs=[${fprStr}]`);
  evidence.push(`body present: ${a.bodyPresent}`);
  for (const h of a.vtableHints) {
    evidence.push(`P1 data hit: ${h.objectFile}@0x${h.offset.toString(16)} → ${hex(h.address)} (${h.symbol})`);
  }
  for (const f of drift) {
    evidence.push(`header drift: line ${f.line} '${f.decl}' — ${f.drift.join("; ")}`);
  }
  for (const f of fakes) {
    evidence.push(`fake member: line ${f.line} '${f.text}'`);
  }

  // Primary rule reason follows the reference's exclusive verdict chain
  // (N1 -> integer_only -> N2 -> N3 -> vtable_dispatch -> deref tiers), so
  // only the rule that actually decided the verdict is reported.
  const reasons: string[] = [];
  if (a.n1) {
    reasons.push("N1: call site passes a NON-ZERO, NON-ADDRESS constant in r3 → not a non-static member [sound, decisive]");
  } else if (a.intOnly) {
    reasons.push("integer_only: r3 used solely as an integer (arithmetic/cmp), never deref'd or used as object base");
  } else if (a.n2) {
    reasons.push("N2: callee never derefs r3 and never forwards it in r3 position → not a non-static member");
  } else if (a.n3) {
    reasons.push(`N3: callee's max r3-relative access offset ${hex(a.callee.derefMaxOffset)} >= class size ${hex(a.classSize)} → not a member of that class [sound]`);
  } else if (a.callee.vtableDispatch) {
    reasons.push("vtable_dispatch: r12 loaded via (r3) then bctrl — possible virtual member, confirm vtable membership");
  } else if (a.callee.deref) {
    if (a.stackHeavy) {
      reasons.push("tier_b: zero instance-anchored call sites + stack-heavy provenance → flag for review [heuristic]");
    } else if (a.instanceAnchored > 0) {
      reasons.push(`instance-anchored: ${a.instanceAnchored} call site(s) with ADDR_LABEL/LOAD_FIELD provenance — possible member (not exclusive)`);
    } else {
      reasons.push("tier_c: in-bounds r3 deref + ambiguous provenance → undecidable, never auto-claim");
    }
  }
  // Hints are independent evidence streams, reported regardless of verdict
  // (P1 / header_drift / fake_members never change the terminal verdict).
  if (a.vtableHints.length > 0) {
    reasons.push(`P1: symbol address ${hex(a.vtableHints[0]!.address)} found as 4-byte .data pointer (${a.vtableHints.length} hit(s)) → vtable/function-pointer candidate`);
  }
  for (const f of drift) {
    reasons.push(`header_drift: line ${f.line} '${f.decl}' — ${f.drift.join("; ")}`);
  }
  for (const f of fakes) {
    reasons.push(`fake_members: line ${f.line} — this==nullptr register-read trick (${f.text})`);
  }
  reasons.push(`verdict: ${a.kind} — ${a.verdictString}`);

  return { verdict: a.kind, evidence, reasons };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify one retail symbol as member vs free. Runs the full tiered audit:
 * N1/N2/N3/P1, tier_b/tier_c, `integer_only`/`vtable_dispatch`, plus the
 * optional source-side `header_drift` / `fake_members` scans (when
 * `headerText` / `classSourceText` are supplied).
 */
export function classifyMember(input: ClassifyMemberInput): MemberVerdict {
  const idx = buildIndex(input.asm);
  const addr = input.symbols.byName.get(input.targetSymbol);
  const targetHits = addr !== undefined ? input.dataHits.filter((h) => h.address === addr) : [];
  const analysis = analyzeSymbol(idx, input.targetSymbol, input.classSize, addr, targetHits);
  const className = parseMangled(input.targetSymbol).className;
  const drift =
    input.headerText !== undefined && className !== null
      ? headerDrift(input.headerText, input.symbols, idx)
      : [];
  const fakes =
    input.classSourceText !== undefined && className !== null
      ? fakeMembers(input.classSourceText, className)
      : [];
  return buildVerdict(analysis, addr, drift, fakes);
}
