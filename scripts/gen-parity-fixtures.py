#!/usr/bin/env python3
"""Generate the M1b parity fixtures for tests/parse-parity.test.ts.

Freezes REAL outputs from the Xenoblade co-op fork Python tools
(tools/coop/extc.py + tools/coop/member_check.py) on real symbols / real
source files, so the TS port can be asserted against recorded ground truth
without invoking Python from the test suite.

Usage:
  python3 scripts/gen-parity-fixtures.py [XENOBLADE_ROOT]   # default: ../xenoblade

Writes (into this repo):
  tests/fixtures/parity-symbols.txt   — frozen subset of config/us/symbols.txt
                                       (self-validated: classify() on the subset
                                       reproduces the full-table verdict for
                                       every recorded name)
  tests/fixtures/parity-extc-scan.json — classify() verdicts for recorded real
                                       names + the extract_entries() scan of the
                                       frozen CTaskGameEvt.cpp source
  tests/fixtures/parity-extc-plan.json — cmd_plan-style output for token
                                       CExchangeWin over the frozen
                                       CExchangeWin.cpp source
  tests/fixtures/parity-member.json    — classify_symbol() verdicts for two real
                                       CfGameManager symbols called from
                                       kyoshin/plugin/ocCfp.s
  tests/fixtures/parity-member-asm.s   — frozen asm (ocCfp.s + the two
                                       1-instruction stub bodies)

Re-run whenever the recorded cases change; commit the fixtures.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
XENO = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT.parent / "xenoblade"
sys.path.insert(0, str(XENO))

from tools.coop.extc import (  # noqa: E402
    RE_ADDR_ANY,
    RE_CLASS_CAST,
    _retail_tables,
    classify,
    embedded_addr,
    extern_c_defs_with_bodies,
    extract_entries,
    member_mangled,
)
from tools.symbolrecover.lib.parser import load_symbols  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
FIXTURES.mkdir(parents=True, exist_ok=True)

US_TABLE = XENO / "config" / "us" / "symbols.txt"
ENTRIES = list(load_symbols(US_TABLE))
# us-only reference tables (documented deviation: extc.py merges us+eu+relocmap)
NAMES: dict[str, str] = {}
ADDR_HITS: dict[int, list[tuple[str, str]]] = {}
for e in ENTRIES:
    NAMES.setdefault(e.name, "us")
    ADDR_HITS.setdefault(e.address, []).append((e.name, "us"))


def classify_subset(name: str, subset: dict[str, str], addr_hits: dict[int, list[tuple[str, str]]]):
    """classify() against a subset table (same algorithm, smaller names set)."""
    return classify(name, subset, addr_hits)


# ── recorded classify cases (real names) ────────────────────────────────────
RECORDED_NAMES = [
    # review's headline example: real retail name, drift via embedded address
    "func_80137038",
    # review's invented example: well-formed MWCC ctor name NOT in the us table
    "__ct__11CGameFv",
    # real retail-exact member (us)
    "OnFileEvent__12CExchangeWinFP10CEventFile",
    # real anonymous-namespace member (us)
    "wkUpdate__Q219@unnamed@CGame_cpp@12CGameRestartFv",
    # real drift: declared is a strict prefix of a retail member
    "func_80047814",
    # real jp-stale: name retail, embedded address now a different retail entry
    "func_8004CC80",
    # real retail-exact free function
    "func_80295764",
    # invented free-function-ish name
    "CGame_DoThing",
    # the review's "void* self def" names from CTaskGameEvt.cpp (all retail-exact)
    "OnFileEvent__12CTaskGameEvtFP10CEventFile",
    "func_80295870",
    "__dt__12CTaskGameEvtFv",
]


def subset_for(names: list[str]) -> dict[str, str]:
    """Minimal names set that reproduces the FULL-table classify verdict for
    every recorded name. Fixpoint: add the resolved drift target, all
    embedded-address occupants, and all aliases at the name's own address.
    Order = symbols.txt order (filter preserves relative order, and classify
    picks the FIRST matching name in iteration order)."""
    entries = {e.name: e for e in ENTRIES}
    addrs = {e.address: e for e in ENTRIES}
    needed: set[str] = set()
    pending = list(names)
    while pending:
        n = pending.pop()
        if n in needed:
            continue
        needed.add(n)
        cat, resolved = classify(n, NAMES, ADDR_HITS)
        if cat == "drift" and resolved and resolved not in needed:
            pending.append(resolved)
        for m in RE_ADDR_ANY.finditer(n):
            addr = int(m.group(1), 16)
            for rn, _ in ADDR_HITS.get(addr, []):
                if rn not in needed:
                    pending.append(rn)
        if n in entries:
            addr = entries[n].address
            for rn, _ in ADDR_HITS.get(addr, []):
                if rn not in needed:
                    pending.append(rn)
    # keep symbols.txt order
    ordered = [e.name for e in ENTRIES if e.name in needed]
    return {n: "us" for n in ordered}


SUBSET = subset_for(RECORDED_NAMES)
SUBSET_ADDR: dict[int, list[tuple[str, str]]] = {}
for e in ENTRIES:
    if e.name in SUBSET:
        SUBSET_ADDR.setdefault(e.address, []).append((e.name, "us"))

# self-validate: classify every recorded name against the subset only
for n in RECORDED_NAMES:
    full = classify(n, NAMES, ADDR_HITS)
    sub = classify_subset(n, SUBSET, SUBSET_ADDR)
    if full != sub:
        raise SystemExit(f"subset mismatch for {n}: full={full} subset={sub}")

# write the frozen symbols.txt subset (real lines, original text)
lines_by_name = {e.name: e.raw_line for e in ENTRIES}
subset_text = "".join(lines_by_name[n] + "\n" for n in SUBSET)
(FIXTURES / "parity-symbols.txt").write_text(subset_text, encoding="utf-8")

scan_cases = []
for n in RECORDED_NAMES:
    cat, resolved = classify(n, NAMES, ADDR_HITS)
    case = {"name": n, "category": cat, "resolved": resolved}
    # jp-stale recording (mirror cmd_scan's jp_stale list): only when the name
    # is retail and an embedded address maps to a different retail entry
    if n in NAMES:
        a = embedded_addr(n)
        if a is not None and any(rn != n for rn, _ in ADDR_HITS.get(a, [])):
            case["jp_stale"] = True
    scan_cases.append(case)

# ── scanner parity: frozen real source (CTaskGameEvt.cpp) ───────────────────
SRC_TASKGAME = (XENO / "src" / "kyoshin" / "CTaskGameEvt.cpp").read_text(
    encoding="utf-8", errors="replace"
)
src_lines = SRC_TASKGAME.splitlines()
source_entries = []
for name, kind, lineno, raw, body in extract_entries(src_lines):
    cat, resolved = classify(name, NAMES, ADDR_HITS) if name else ("unparsed", None)
    is_mangled = "__" in name if name else False
    from tools.coop.extc import RE_SELF_FIRST

    self_style = bool(RE_SELF_FIRST.search(body)) if body else False
    source_entries.append(
        {
            "lineno": lineno,
            "name": name,
            "raw": raw,
            "category": cat,
            "resolved": resolved,
            "memberCandidateHint": is_mangled or self_style,
            "self_style": self_style,
        }
    )

# ── plan parity: frozen real source (CExchangeWin.cpp), token CExchangeWin ──
SRC_EXCHANGE = (XENO / "src" / "kyoshin" / "CExchangeWin.cpp").read_text(
    encoding="utf-8", errors="replace"
)
TOKEN = "CExchangeWin"
plan_lines = SRC_EXCHANGE.splitlines()
class_syms = sorted(n for n in NAMES if TOKEN in n)  # Python cmd_plan: class_syms.sort()
# the plan's table: every us line for a name containing the token (the
# retail_symbols listing + the decl-hit classify need the same name set)
plan_table_lines = [e.raw_line for e in ENTRIES if TOKEN in e.name]
plan_table_text = "".join(l + "\n" for l in plan_table_lines)
plan_hits = []
for name, lineno, header, body in extern_c_defs_with_bodies(plan_lines):
    cast_cls = RE_CLASS_CAST.search(body)
    if cast_cls and cast_cls.group(1) == TOKEN:
        plan_hits.append({"lineno": lineno, "name": name, "kind": "def-selfcast", "header": header})
    elif re.search(rf"\(\s*{TOKEN}\s*\*", header):
        plan_hits.append({"lineno": lineno, "name": name, "kind": "def-param", "header": header})
for name, kind, lineno, raw, body in extract_entries(plan_lines):
    if name is None:
        continue
    if TOKEN in name and (name in NAMES or classify(name, NAMES, ADDR_HITS)[0] != "invented"):
        plan_hits.append({"lineno": lineno, "name": name, "kind": "decl", "header": raw})
plan_hits.sort(key=lambda h: (h["lineno"], h["name"]))
plan_recipe = [
    {"lineno": h["lineno"], "name": h["name"], "mangled": member_mangled(TOKEN, h["name"])}
    for h in plan_hits
    if h["kind"].startswith("def")
]

# ── member-check parity: two real CfGameManager symbols in ocCfp.s ──────────
import tools.coop.member_check as mc  # noqa: E402

MEMBER_SYMS = [
    "func_80086D90__Q22cf13CfGameManagerFv",
    "func_80086D94__Q22cf13CfGameManagerFv",
]
idx = mc.AsmIndex()
member_records = []
member_table_lines = []
for sym in MEMBER_SYMS:
    r = mc.classify_symbol(sym, idx)
    calls = idx.calls.get(sym, [])
    member_records.append(
        {
            "symbol": sym,
            "call_sites": r["call_sites"],
            "callers": [[rel, caller, i] for rel, caller, i in calls],
            "r3_provenance": dict(r["r3_provenance"]),
            "callee": r["callee"],
            "binary_params": r["binary_params"],
            "verdict": r["verdict"],
            "body_present": r["body_present"],
            "vtable_hints": r["vtable_hints"],
        }
    )
    if sym in lines_by_name:
        member_table_lines.append(lines_by_name[sym])
    else:
        # not in the us table: derive a line from the asm .fn comment address
        raise SystemExit(f"{sym} missing from us symbols.txt")

# frozen asm: whole ocCfp.s + the two 1-instruction stub bodies
asm_path = XENO / "build" / "us" / "asm" / "kyoshin" / "plugin" / "ocCfp.s"
asm_text = asm_path.read_text(encoding="utf-8", errors="replace")
stub_path = XENO / "build" / "us" / "asm" / "kyoshin" / "cf" / "CfGameManager.s"
stub_lines = stub_path.read_text(encoding="utf-8", errors="replace").splitlines()
stubs = []
for i, ln in enumerate(stub_lines):
    for sym in MEMBER_SYMS:
        if ln.strip() == f".fn {sym}, global":
            stubs.append(stub_lines[i : i + 3])
for s in stubs:
    asm_text += "\n".join(s) + "\n"
(FIXTURES / "parity-member-asm.s").write_text(asm_text, encoding="utf-8")
(FIXTURES / "parity-member.json").write_text(
    json.dumps({"symbols": member_records, "symbols.txt": "\n".join(member_table_lines) + "\n"}, indent=1)
    + "\n",
    encoding="utf-8",
)

# ── write JSON fixtures ─────────────────────────────────────────────────────
(FIXTURES / "parity-extc-scan.json").write_text(
    json.dumps(
        {
            "source": SRC_TASKGAME,
            "source_path": "src/kyoshin/CTaskGameEvt.cpp",
            "cases": scan_cases,
            "sourceEntries": source_entries,
        },
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
(FIXTURES / "parity-extc-plan.json").write_text(
    json.dumps(
        {
            "token": TOKEN,
            "source": SRC_EXCHANGE,
            "source_path": "src/kyoshin/CExchangeWin.cpp",
            "symbols.txt": plan_table_text,
            "retail_symbols": class_syms,
            "hits": plan_hits,
            "recipe": plan_recipe,
        },
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)

print(f"subset names: {len(SUBSET)}  (recorded: {len(RECORDED_NAMES)})")
print(f"scan cases: {len(scan_cases)}  source entries: {len(source_entries)}")
print(f"plan: {len(class_syms)} retail symbols, {len(plan_hits)} hits")
print(f"member records: {len(member_records)}")
print("wrote:", sorted(p.name for p in FIXTURES.glob("parity-*")))
