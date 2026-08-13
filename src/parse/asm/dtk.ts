/**
 * M1b: dtk retail-asm parser.
 *
 * Parses decomp.me / dtk `.s` dumps (`parseAsmFile`), indexes `bl` edges per
 * function (`buildCallGraph`), and exposes the instruction-level r3 facts that
 * drive the member-vs-free classifier (`member.N1`/`N2`/`N3` in
 * `tools/coop/member_check.py`).
 *
 * Faithfulness contract: the instruction-line regex, mnemonic sets
 * (`READERS`, `INTEGER_OPS`), operand splitting, and the r3-deref offset
 * regexes (`DEREF_LOAD`, `DEREF_STORE`) mirror `member_check.py` exactly, so
 * parity checks against the Python reference stay meaningful. Known
 * reference quirks are preserved on purpose (each noted inline):
 *   - byte hex in instruction lines is matched upper-case only (dtk output);
 *   - `mfspr`/`mftb` are classified as r3-readers, never r3-writers, matching
 *     the `READERS` prefix set used by the provenance back-scan;
 *   - `passesConstInR3` does not match signed immediates (`li r3, -0x1`),
 *     matching `member_check._const_imm`, so N1 parity is byte-for-byte.
 *
 * Documented deviation (docs/m1b-parity.md): instructions OUTSIDE
 * `.fn`/`.endfn` regions are dropped — `member_check._parse_file` keeps every
 * instruction line in the file, whether or not it sits inside a function.
 * Real dtk dumps always wrap code in `.fn`/`.endfn`, so the deviation is
 * theoretical (proven by the out-of-function test in tests/parse-dtk.test.ts).
 */

/** One decoded instruction in a dtk dump. */
export interface AsmInstruction {
  /** Link address of the instruction (first hex field of the comment marker). */
  address: number;
  /** Raw machine-code bytes as emitted by dtk, e.g. `"3C C0 80 57"`. */
  bytes: string;
  /** Lower-case mnemonic, e.g. `"lwz"`. */
  mnemonic: string;
  /** Everything after the mnemonic on the line; `""` when there is none. */
  operands: string;
}

/** One `.fn ... .endfn ...` region of a dump. */
export interface AsmFunction {
  /** Function name as written on the `.fn` line (up to the first comma). */
  name: string;
  /** Instructions inside the function, in file order. */
  instructions: AsmInstruction[];
}

/** Result of `parseAsmFile`: functions in file order. */
export interface ParsedAsm {
  functions: AsmFunction[];
}

/** A `bl`-edge view of a parsed dump. */
export interface CallGraph {
  /** caller function name -> distinct `bl` targets, first-seen order. */
  callers: Record<string, string[]>;
  /** target symbol -> distinct caller function names, first-seen order. */
  callees: Record<string, string[]>;
}

/** Minimal instruction shape accepted by the r3 helpers (parsed or ad-hoc). */
export interface InsnLike {
  mnemonic: string;
  operands: string;
}

/**
 * Mnemonics that READ r3 but do not write it (exact set from
 * `member_check.py`; matched by PREFIX in the classifier, e.g. `cmp` also
 * covers `cmpwi`/`cmpw`, `st` covers `stw`/`stb`/...).
 */
export const READERS = [
  "cmp", "b", "bl", "blr", "bctrl", "st", "mtctr", "mtlr",
  "mfspr", "mftb", "bc", "bcctr",
] as const;

/**
 * Mnemonics that treat r3 as a value (integer arithmetic), never as a base
 * pointer (exact set from `member_check.py`).
 */
export const INTEGER_OPS = [
  "rlwinm", "slwi", "srwi", "srawi", "rlwimi", "or", "orc", "and", "andc",
  "xor", "add", "sub", "subf", "mulli", "mullw", "divw", "neg", "extsb",
  "extsh", "cntlzw", "clrlwi", "clrrwi", "rotlwi",
] as const;

/**
 * Instruction line in a dtk dump, e.g.
 * `/* 8007CA94 00045CD4  3C C0 80 57 *\/\tlis r6, lbl_eu_80571658@ha`.
 * Mirrors `member_check.INS` (byte hex upper-case, exactly four byte-pairs,
 * two spaces before them) plus a capture group for the link address.
 */
const INS_RE = /^\/\* ([0-9A-F]+) ([0-9A-F]+)  ([0-9A-F]{2}(?: [0-9A-F]{2}){3}) \*\/\s*(.+)/;

/** `mnemonic` / `operands` split, mirroring `member_check.MNEM`. */
const MNEM_RE = /^([a-z0-9_.]+)(?:\s+(.+))?$/;

/** r3-relative load (from `member_check.DEREF_LOAD`). */
const DEREF_LOAD_RE = /(?:lwz|lbz|lhz|lha|lfs|lfd)\s+r\d+,\s*([0-9A-Fa-fxX]+)\(r3\)/;
/** r3-relative store (from `member_check.DEREF_STORE`). */
const DEREF_STORE_RE = /(?:stw|stb|sth|stfs|stfd)\s+r\d+,\s*([0-9A-Fa-fxX]+)\(r3\)/;

/** `.fn <name>[, flags]` opener. */
const FN_START_RE = /^\.fn\s+(.+)$/;

/**
 * Parse one raw line into an instruction, or `null` when the line is not an
 * instruction. Operand cleanup mirrors `member_check._parse_file`: trailing
 * `//` comments and any double-space annotation are dropped.
 */
function parseInsnLine(line: string): AsmInstruction | null {
  const m = INS_RE.exec(line);
  if (!m) {
    return null;
  }
  const address = parseInt(m[1]!, 16);
  const bytes = m[3]!;
  // m[2] is the object-file offset; dtk dumps it but we do not surface it.
  const rest = m[4]!.replace(/\s+\/\/.*$/, "").split("  ")[0]!.trim();
  const m2 = MNEM_RE.exec(rest);
  if (!m2) {
    return null;
  }
  return { address, bytes, mnemonic: m2[1]!, operands: m2[2] ?? "" };
}

/**
 * Parse a dtk `.s` dump. Every `.fn <name>[, ...]` … `.endfn <name>` region
 * becomes one `AsmFunction`; lines outside any function are ignored (dtk
 * always wraps code in `.fn`/`.endfn`). An unterminated final function is
 * closed at EOF, like `member_check.AsmIndex._index_functions`.
 */
export function parseAsmFile(text: string): ParsedAsm {
  const functions: AsmFunction[] = [];
  let cur: AsmFunction | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const fnStart = FN_START_RE.exec(line);
    if (fnStart) {
      cur = { name: fnStart[1]!.split(",")[0]!.trim(), instructions: [] };
      functions.push(cur);
      continue;
    }
    if (line.startsWith(".endfn")) {
      cur = null;
      continue;
    }
    if (cur) {
      const insn = parseInsnLine(rawLine);
      if (insn) {
        cur.instructions.push(insn);
      }
    }
  }
  return { functions };
}

/**
 * Extract a `bl` target from operands, or `null` for local labels / `@sda21`
 * style pseudo-targets — the same filter as `member_check.AsmIndex` call-site
 * indexing (`bl .L_...` and `bl @...` are not graph edges).
 */
export function blTarget(operands: string): string | null {
  const ops = operands.trim();
  if (!ops || ops.startsWith(".") || ops.startsWith("@")) {
    return null;
  }
  return ops.split(",")[0]!.trim();
}

/**
 * Index `bl` edges per function. `callers[fn]` lists the distinct targets
 * `fn` calls; `callees[target]` lists its callers. Targets that are not
 * themselves functions in this dump (e.g. libc symbols) still appear as
 * keys in `callees`.
 */
export function buildCallGraph(parsed: ParsedAsm): CallGraph {
  const callers: Record<string, string[]> = {};
  const callees: Record<string, string[]> = {};
  const addEdge = (caller: string, target: string): void => {
    let a = callers[caller];
    if (!a) {
      a = [];
      callers[caller] = a;
    }
    if (!a.includes(target)) {
      a.push(target);
    }
    let b = callees[target];
    if (!b) {
      b = [];
      callees[target] = b;
    }
    if (!b.includes(caller)) {
      b.push(caller);
    }
  };
  for (const fn of parsed.functions) {
    for (const insn of fn.instructions) {
      if (insn.mnemonic !== "bl") {
        continue;
      }
      const target = blTarget(insn.operands);
      if (target) {
        addEdge(fn.name, target);
      }
    }
  }
  return { callers, callees };
}

/**
 * Does the instruction READ r3? `READERS` mnemonics (stores, compares,
 * branches, `mfspr`/`mftb`, ctrl moves) never write r3, so any r3 mention is
 * a read. For data instructions, r3 counts as read when it appears anywhere
 * but the destination slot (this also covers read-modify-write like
 * `slwi r3, r3, 2`).
 */
export function readsR3(insn: InsnLike): boolean {
  if (!/\br3\b/.test(insn.operands)) {
    return false;
  }
  if (isReaderMnemonic(insn.mnemonic)) {
    return true;
  }
  const tokens = splitOperands(insn.operands);
  return tokens.slice(1).some((t) => /\br3\b/.test(t));
}

/**
 * Does the instruction WRITE r3? `READERS` mnemonics never write r3; other
 * instructions write the destination (first operand) slot, so a write means
 * the destination is r3.
 */
export function writesR3(insn: InsnLike): boolean {
  if (!/\br3\b/.test(insn.operands) || isReaderMnemonic(insn.mnemonic)) {
    return false;
  }
  const tokens = splitOperands(insn.operands);
  return tokens.length > 0 && tokens[0] === "r3";
}

/** Is `mnemonic` in the `INTEGER_OPS` set (r3 used as a value)? */
export function isIntegerOp(insn: InsnLike): boolean {
  return (INTEGER_OPS as readonly string[]).includes(insn.mnemonic);
}

/**
 * r3-relative load offset (`lwz`/`lbz`/`lhz`/`lha`/`lfs`/`lfd` with an `r3`
 * base), or `null` when the instruction is not one. The offset is parsed as
 * hex exactly like `member_check` (`0x10` and `10` both mean 16). Note the
 * reference regex requires an `r\d+` destination, so `lfs`/`lfd` (which
 * always load an FPR like `f1`) never match — kept exact for parity.
 */
export function derefLoadOffset(insn: InsnLike): number | null {
  const m = DEREF_LOAD_RE.exec(fullInsn(insn));
  return m ? parseInt(m[1]!, 16) : null;
}

/**
 * r3-relative store offset (`stw`/`stb`/`sth`/`stfs`/`stfd` with an `r3`
 * base), or `null` when the instruction is not one. Hex parsing as in
 * `member_check`. Note the reference regex requires an `r\d+` source, so
 * `stfs`/`stfd` (which always store an FPR like `f1`) never match — kept
 * exact for parity.
 */
export function derefStoreOffset(insn: InsnLike): number | null {
  const m = DEREF_STORE_RE.exec(fullInsn(insn));
  return m ? parseInt(m[1]!, 16) : null;
}

/**
 * The immediate passed in r3 by `li r3, <imm>` / `lis r3, <imm>` (N1
 * evidence), or `null` when the instruction does not pass a constant in r3.
 * The immediate regex mirrors `member_check._const_imm`: `0x…` or decimal,
 * optional `@ha`/`@l` suffix tolerated (`0x8000@ha` -> 0x8000); label
 * operands and signed immediates do not match (reference-faithful).
 */
export function passesConstInR3(insn: InsnLike): number | null {
  if (insn.mnemonic !== "li" && insn.mnemonic !== "lis") {
    return null;
  }
  const m = /^r3\s*,\s*(0x[0-9A-Fa-f]+|\d+)/.exec(insn.operands);
  if (!m) {
    return null;
  }
  const raw = m[1]!;
  return raw.startsWith("0x") ? parseInt(raw, 16) : parseInt(raw, 10);
}

function isReaderMnemonic(mnemonic: string): boolean {
  return (READERS as readonly string[]).some((r) => mnemonic.startsWith(r));
}

/** `"mnemonic operands"` — the string the DEREF regexes search, like `member_check`. */
function fullInsn(insn: InsnLike): string {
  return insn.operands ? `${insn.mnemonic} ${insn.operands}` : insn.mnemonic;
}

/** Operand tokens with commas stripped, mirroring `member_check`'s split. */
function splitOperands(operands: string): string[] {
  return operands
    .split(/\s+/)
    .map((t) => t.replace(/,$/, ""))
    .filter((t) => t.length > 0);
}
