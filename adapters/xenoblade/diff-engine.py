#!/usr/bin/env python3
"""M2.5 — Xenoblade diff-engine Python worker (Decompi).

A long-lived stdio NDJSON worker that wraps the Xenoblade hexdiff logic
(``tools/coop/hexdiff.py`` in the xenoblade repo) so Decompi does NOT pay
per-call interpreter/import startup for every symbol diff.

Protocol (stdin/stdout, one JSON object per line):

    -> {"id": 1, "method": "ping", "params": {}}
    <- {"id": 1, "result": {"ok": true}}

    -> {"id": 2, "method": "diff", "params": {"unit": "kyoshin/CGame",
                                              "symbol": "__ct__5CGameFPCcP11CWorkThread",
                                              "build": false}}
    <- {"id": 2, "result": { ...exact JSON document emitted by
                             `hexdiff.py <unit> --symbol <sym> --json` ... }}

    -> {"id": 3, "method": "list", "params": {"unit": "kyoshin/CGame"}}
    <- {"id": 3, "result": {"unit": ..., "count": N,
                            "symbols": [{"address": int, "size": int, "name": str}, ...]}}

    -> {"id": 4, "method": "nope", "params": {}}
    <- {"id": 4, "error": {"message": "unknown method 'nope'"}}

Errors are ``{"id": <id>, "error": {"message": str, "exit_code"?: int,
"stderr"?: str}}`` (``exit_code`` is the underlying hexdiff return code —
4 = symbol not found, 2/3 = build/read failure, 1 = no object).  The daemon
reads requests serially (one at a time); it exits when stdin reaches EOF.
On startup it prints exactly ``[diff-engine] ready`` to stderr after all
heavy imports and caches are warm.

Why this is fast (no per-request startup):

  * The xenoblade repo root is added to ``sys.path`` and the heavy modules
    (``tools.ppc_equivalence.*``, ``tools.coop.hexdiff``, the reloc-map path)
    are imported ONCE at worker startup — never per request.
  * The 18 MB ``tools/coop/targets.json`` registry is cached keyed by
    (mtime_ns, size), so it is parsed once per worker lifetime and only
    re-parsed when the file changes on disk (matching the other caches).  The
    stock ``hexdiff._recover_retail_names`` re-parses that file on EVERY diff
    (~100 ms/request); the worker installs a behaviour-identical replacement
    that reads the cached parse.  This is a runtime monkey-patch of the
    imported module only — no file in the xenoblade repo is modified.
  * ``objdiff.json`` (1.2 MB) and ``retail_reloc_map.json`` (850 KB) are also
    cached, keyed by file (path, mtime, size) so they self-invalidate if the
    underlying files change while the worker lives.
  * ``hexdiff.run()`` is driven in-process (``sys.argv``-style argv, stdout
    captured with ``contextlib.redirect_stdout``); no
    ``subprocess.run(["python3", "hexdiff.py", ...])`` per request.

Repo-root resolution: ``--repo <root>`` (argv, parsed at startup) wins, then
``XENOBLADE_REPO`` (env), then the sibling-of-decompi default.  The adapter
passes both ``--repo`` and a spawn env carrying ``XENOBLADE_REPO`` so either
channel alone configures the worker.

CLI:

    python3 diff-engine.py [--repo <root>]                 # stdio daemon
    python3 diff-engine.py [--repo <root>] --bench <unit> <sym> [N]   # timing benchmark

``--bench`` times N in-process diffs against N fresh ``hexdiff.py``
subprocess invocations (both ``--no-build``, i.e. against the objects that
already exist) and prints the per-request ms for both to stderr, plus a
parity check proving the in-process JSON equals the fresh-subprocess JSON.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

# ── repo root discovery ────────────────────────────────────────────────────
# Layout: <parent>/decompi/adapters/xenoblade/diff-engine.py
#         <parent>/xenoblade/tools/coop/hexdiff.py
_HERE = Path(__file__).resolve()
_DEFAULT_XENOBLADE_ROOT = _HERE.parents[3] / "xenoblade"
VERSION = "1.0.0"

# Engine slots — filled by `_load_engine(root)` ONCE, after argv parsing so
# `--repo` can re-point the repo root before any heavy import runs.  The
# module-level defaults are what `--repo`/`XENOBLADE_REPO` override.
XENOBLADE_ROOT: Path = Path(
    os.environ.get("XENOBLADE_REPO", str(_DEFAULT_XENOBLADE_ROOT))
).resolve()
_HEXDIFF_PATH: Path = XENOBLADE_ROOT / "tools" / "coop" / "hexdiff.py"
hexdiff: Any = None
_reloc_map_mod: Any = None
_object_size_mod: Any = None
_load_config: Any = None
_Project: Any = None
FunctionBytes: Any = None
list_text_functions: Any = None


def _load_engine(root: Path) -> None:
    """Resolve the repo root and import the heavy engine modules ONCE.

    Sets the module globals the request handlers below use; call exactly
    once, before serving.  ``root`` has already been resolved from
    ``--repo`` / ``XENOBLADE_REPO`` / the sibling default.
    """
    global XENOBLADE_ROOT, _HEXDIFF_PATH
    global hexdiff, _reloc_map_mod, _object_size_mod, _load_config, _Project
    global FunctionBytes, list_text_functions
    XENOBLADE_ROOT = root
    _HEXDIFF_PATH = root / "tools" / "coop" / "hexdiff.py"
    if not _HEXDIFF_PATH.is_file():
        raise RuntimeError(
            f"xenoblade repo not found at {root} "
            f"(set XENOBLADE_REPO env var or pass --repo to the repo root)"
        )

    sys.path.insert(0, str(root))

    from tools.coop import hexdiff  # noqa: E402
    from tools.coop import reloc_map as _reloc_map_mod  # noqa: E402  (pulls census_elf_relocs)
    from tools.coop.lib import object_size as _object_size_mod  # noqa: E402
    from tools.coop.lib.config import load_config as _load_config  # noqa: E402
    from tools.coop.lib.project import Project as _Project  # noqa: E402
    from tools.ppc_equivalence import decoder as _decoder  # noqa: E402,F401  (lazy inside hexdiff)
    from tools.ppc_equivalence import elf_symbols  # noqa: E402,F401
    from tools.ppc_equivalence import ir  # noqa: E402,F401  (hexdiff imports it)
    from tools.ppc_equivalence.elf_symbols import FunctionBytes, list_text_functions  # noqa: E402

    _install_patches()


# ── targets.json registry: cached, keyed by (mtime_ns, size) ───────────────
_TARGETS_REGISTRY: Optional[tuple[tuple[int, int], dict]] = None
_REGISTRY_INDEX: Optional[tuple[tuple[int, int], tuple[dict[str, int], dict[int, str]]]] = None


def _registry_stamp() -> Optional[tuple[int, int]]:
    """(mtime_ns, size) of tools/coop/targets.json, or None when absent."""
    path = XENOBLADE_ROOT / "tools" / "coop" / "targets.json"
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _targets_registry() -> dict:
    """Return the parsed tools/coop/targets.json (18 MB), cached by
    (mtime_ns, size) — parsed once and re-parsed only when the file changes
    on disk (``run.py cycle`` rewrites it), matching the objdiff.json /
    reloc-map / splits caches.
    """
    global _TARGETS_REGISTRY
    stamp = _registry_stamp()
    if stamp is None:
        return {}
    hit = _TARGETS_REGISTRY
    if hit is not None and hit[0] == stamp:
        return hit[1]
    doc: dict = {}
    path = XENOBLADE_ROOT / "tools" / "coop" / "targets.json"
    try:
        with path.open(encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        doc = {}
    _TARGETS_REGISTRY = (stamp, doc)
    return doc


def _registry_index() -> tuple[dict[str, int], dict[int, str]]:
    """Derived symbol -> address / address -> symbol maps, cached by the same
    stamp so a registry re-parse (file change) rebuilds the index; per-request
    name recovery must not re-iterate all 19300 rows.
    """
    global _REGISTRY_INDEX
    stamp = _registry_stamp()
    if stamp is None:
        return {}, {}
    hit = _REGISTRY_INDEX
    if hit is not None and hit[0] == stamp:
        return hit[1]
    doc = _targets_registry()
    rows = doc.get("targets", []) if isinstance(doc, dict) else []
    name_to_addr: dict[str, int] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        sym = r.get("symbol")
        addr = r.get("address")
        if isinstance(sym, str) and sym and isinstance(addr, str) and addr:
            try:
                name_to_addr[sym] = int(addr, 0)
            except ValueError:
                pass
    index = (name_to_addr, {a: s for s, a in name_to_addr.items()})
    _REGISTRY_INDEX = (stamp, index)
    return index


def _recover_retail_names_cached(
    project: Any,
    retail_fn: list[FunctionBytes],
    decomp_fn: Optional[list[FunctionBytes]],
    unit_name: str,
) -> int:
    """Behaviour-identical mirror of ``hexdiff._recover_retail_names`` that
    reads the cached (mtime-keyed) registry instead of re-parsing the 18 MB
    file on every request.  Installed as ``hexdiff._recover_retail_names``.
    """
    if not retail_fn or not decomp_fn:
        return 0
    if not (project.root / "tools" / "coop" / "targets.json").is_file():
        return 0
    name_to_addr, addr_to_name = _registry_index()
    if not name_to_addr:
        return 0
    text_base: Optional[int] = None
    for f in decomp_fn:
        if f.name in name_to_addr:
            text_base = (name_to_addr[f.name] - f.value) & 0xFFFFFFFF
            break
    if text_base is None:
        return 0
    renamed = 0
    for i, f in enumerate(retail_fn):
        if f.name and f.name != "(null)":
            continue
        abs_addr = (text_base + f.value) & 0xFFFFFFFF
        sym = addr_to_name.get(abs_addr)
        if sym:
            retail_fn[i] = FunctionBytes(
                name=sym, path=f.path, code=f.code, base=f.base, value=f.value,
                size=f.size, section_index=f.section_index,
                section_name=f.section_name, symbol_type=f.symbol_type,
                relocations=f.relocations,
            )
            renamed += 1
    return renamed


# ── objdiff.json unit table: mtime-keyed module cache ──────────────────────
_OBJDIFF_UNITS_ORIG = None  # bound in _install_patches
_OBJDIFF_UNITS_CACHE: dict[str, tuple[tuple[int, int], list]] = {}


def _load_objdiff_units_cached(self: Any) -> list:
    """Cache Project.load_objdiff_units by (path, mtime_ns, size).

    objdiff.json (1.2 MB) is parsed on every hexdiff request; the cache
    self-invalidates when the file changes on disk.
    """
    path = self.config.objdiff_json
    try:
        st = path.stat()
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return _OBJDIFF_UNITS_ORIG(self)
    key = str(path)
    hit = _OBJDIFF_UNITS_CACHE.get(key)
    if hit is not None and hit[0] == stamp:
        return hit[1]
    units = _OBJDIFF_UNITS_ORIG(self)
    _OBJDIFF_UNITS_CACHE[key] = (stamp, units)
    return units


# ── retail_reloc_map.json: mtime-keyed module cache ────────────────────────
_LOAD_MAP_ORIG = None  # bound in _install_patches
_LOAD_MAP_CACHE: dict[str, tuple[tuple[int, int], dict]] = {}


def _load_map_cached(path: Any = None) -> dict:
    """Cache reloc_map.load_map (850 KB JSON) by (path, mtime_ns, size)."""
    if path is None:
        path = _reloc_map_mod.DEFAULT_MAP
    path = Path(path)
    try:
        st = path.stat()
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return _LOAD_MAP_ORIG(path)
    key = str(path)
    hit = _LOAD_MAP_CACHE.get(key)
    if hit is not None and hit[0] == stamp:
        return hit[1]
    data = _LOAD_MAP_ORIG(path)
    _LOAD_MAP_CACHE[key] = (stamp, data)
    return data


# ── splits.txt: mtime-keyed cache (parsed by check_object_size per request) ─
_LOAD_SPLITS_ORIG = None  # bound in _install_patches
_LOAD_SPLITS_CACHE: dict[str, tuple[tuple[int, int], list]] = {}


def _load_splits_cached(path: Any) -> list:
    """Cache object_size.load_splits (splits.txt, ~170 KB) by mtime+size."""
    path = Path(path)
    try:
        st = path.stat()
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return _LOAD_SPLITS_ORIG(path)
    key = str(path)
    hit = _LOAD_SPLITS_CACHE.get(key)
    if hit is not None and hit[0] == stamp:
        return hit[1]
    units = _LOAD_SPLITS_ORIG(path)
    _LOAD_SPLITS_CACHE[key] = (stamp, units)
    return units


# ── configure.py compiler config: mtime-keyed cache (parsed per request) ────
_UNIT_COMPILER_ORIG = None  # bound in _install_patches
_COMPILER_CFG_CACHE: dict[str, tuple[int, dict[str, str]]] = {}


def _unit_compiler_config_cached(project: Any, unit_name: str) -> str:
    """Cache hexdiff._unit_compiler_config per (configure.py mtime, unit)."""
    cfg = project.root / "configure.py"
    try:
        mtime = cfg.stat().st_mtime_ns
    except OSError:
        return _UNIT_COMPILER_ORIG(project, unit_name)
    key = str(cfg)
    hit = _COMPILER_CFG_CACHE.get(key)
    if hit is not None and hit[0] == mtime:
        inner = hit[1]
        if unit_name in inner:
            return inner[unit_name]
        res = _UNIT_COMPILER_ORIG(project, unit_name)
        inner[unit_name] = res
        return res
    res = _UNIT_COMPILER_ORIG(project, unit_name)
    _COMPILER_CFG_CACHE[key] = (mtime, {unit_name: res})
    return res


def _install_patches() -> None:
    """Install the cached replacements over the imported engine functions
    (runtime patch of the imported modules only — no repo file is touched).
    Binds the *_ORIG globals and monkey-patches the module/class methods.
    """
    global _OBJDIFF_UNITS_ORIG, _LOAD_MAP_ORIG, _LOAD_SPLITS_ORIG, _UNIT_COMPILER_ORIG
    _OBJDIFF_UNITS_ORIG = _Project.load_objdiff_units
    _LOAD_MAP_ORIG = _reloc_map_mod.load_map
    _LOAD_SPLITS_ORIG = _object_size_mod.load_splits
    _UNIT_COMPILER_ORIG = hexdiff._unit_compiler_config
    hexdiff._recover_retail_names = _recover_retail_names_cached
    _Project.load_objdiff_units = _load_objdiff_units_cached
    _reloc_map_mod.load_map = _load_map_cached
    _object_size_mod.load_splits = _load_splits_cached
    hexdiff._unit_compiler_config = _unit_compiler_config_cached


# ── protocol helpers ───────────────────────────────────────────────────────

class DiffEngineError(Exception):
    """A request-level failure; serialised to {id, error}."""

    def __init__(self, message: str, *, exit_code: Optional[int] = None,
                 stderr: Optional[str] = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stderr = stderr

    def to_dict(self) -> dict:
        d: dict = {"message": str(self)}
        if self.exit_code is not None:
            d["exit_code"] = self.exit_code
        if self.stderr:
            d["stderr"] = self.stderr[-2000:]
        return d


def _run_hexdiff(argv: list[str]) -> tuple[int, str, str]:
    """Drive hexdiff.run() in-process; return (exit_code, stdout, stderr)."""
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
        code = hexdiff.run(argv)
    return code, out_buf.getvalue(), err_buf.getvalue()


def _stderr_tail(err: str, lines: int = 8) -> str:
    return "\n".join(err.strip().splitlines()[-lines:]) if err and err.strip() else ""


def _diff(unit: str, symbol: str, build: bool = False) -> dict:
    """Return the exact JSON document `hexdiff.py <unit> --symbol <sym> --json`
    emits.  build=True reproduces hexdiff's default (ninja-build the decomp
    object first); the default build=False passes --no-build (diff against the
    objects that already exist — required for units whose source does not
    currently compile, and the fast path for a long-lived worker).

    hexdiff exit codes: 0 = clean diff, 5 = mismatch diff (both emit a JSON
    document); 1 = no retail/decomp object, 2 = build/usage failure, 3 = read
    failure, 4 = symbol not found (no JSON).  Any code outside 0/5 is raised
    as DiffEngineError carrying exit_code so the adapter can classify
    NOT_FOUND (4) vs NOT_BUILDABLE (2/3).
    """
    argv = [unit, "--symbol", symbol, "--json"]
    if not build:
        argv.append("--no-build")
    code, out, err = _run_hexdiff(argv)
    if code not in (0, 5):
        tail = _stderr_tail(err)
        raise DiffEngineError(
            f"hexdiff diff failed for {unit} {symbol!r} (exit {code})"
            + (f": {tail}" if tail else ""),
            exit_code=code,
            stderr=tail,
        )
    text = out.strip()
    if not text:
        tail = _stderr_tail(err)
        raise DiffEngineError(
            f"hexdiff diff failed for {unit} {symbol!r} "
            f"(exit {code}, no JSON on stdout)"
            + (f": {tail}" if tail else ""),
            exit_code=code,
            stderr=tail,
        )
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise DiffEngineError(
            f"hexdiff emitted non-JSON stdout for {unit} {symbol!r}: {exc}",
            exit_code=code,
        ) from exc


def _list_symbols(unit: str) -> dict:
    """Return the symbol list equivalent to `hexdiff.py <unit> --list`."""
    argv = [unit, "--list"]
    code, out, err = _run_hexdiff(argv)
    text = out.strip()
    if not text and code != 0:
        tail = _stderr_tail(err)
        raise DiffEngineError(
            f"hexdiff --list failed for {unit} (exit {code})"
            + (f": {tail}" if tail else ""),
            exit_code=code,
            stderr=tail,
        )
    symbols: list[dict] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            address = int(parts[0], 16)
            size = int(parts[1], 16)
        except ValueError:
            continue
        symbols.append({
            "address": address,
            "size": size,
            "name": " ".join(parts[2:]),
        })
    return {"unit": unit, "count": len(symbols), "symbols": symbols}


def _dispatch(method: str, params: dict) -> Any:
    if method == "ping":
        return {"ok": True}
    if method == "diff":
        unit = params.get("unit")
        symbol = params.get("symbol")
        if not unit or not symbol:
            raise DiffEngineError("diff requires params {unit, symbol}")
        return _diff(unit, symbol, build=bool(params.get("build", False)))
    if method == "list":
        unit = params.get("unit")
        if not unit:
            raise DiffEngineError("list requires params {unit}")
        return _list_symbols(unit)
    raise DiffEngineError(f"unknown method {method!r}")


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def serve() -> None:
    """Read NDJSON requests on stdin until EOF; reply on stdout."""
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as exc:
            _emit({"id": None, "error": {"message": f"invalid JSON request: {exc}"}})
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        try:
            _emit({"id": rid, "result": _dispatch(method, params)})
        except DiffEngineError as exc:
            _emit({"id": rid, "error": exc.to_dict()})
        except Exception as exc:  # noqa: BLE001 — protocol boundary
            _emit({"id": rid, "error": {"message": f"{type(exc).__name__}: {exc}"}})


# ── warmup + startup banner ────────────────────────────────────────────────

def _warmup() -> None:
    """Pay every heavy one-time cost now so `[diff-engine] ready` is truthful.

    Parses targets.json (18 MB) once, pre-loads the reloc map and the
    objdiff.json unit table, and loads the coop config so lazy imports inside
    hexdiff.run() (capability_assurance etc.) are resolved before serving.
    """
    _targets_registry()
    _load_map_cached()
    try:
        cfg = _load_config(None, XENOBLADE_ROOT)
        _load_objdiff_units_cached(_Project(cfg))
    except Exception:  # noqa: BLE001 — config/objdiff will re-attempt per request
        pass


# ── --bench: in-process vs fresh-subprocess timing ─────────────────────────

def bench(unit: str, symbol: str, n: int = 5) -> None:
    """Time N in-process diffs vs N fresh `hexdiff.py` subprocess invocations
    (both --no-build) and print per-request ms to stderr, plus a parity check.
    """
    n = max(1, int(n))
    cmd = [
        sys.executable, str(_HEXDIFF_PATH),
        unit, "--symbol", symbol, "--json", "--no-build",
    ]

    def _check_subproc(r: subprocess.CompletedProcess[str]) -> dict:
        if r.returncode not in (0, 5) or not r.stdout.strip():
            raise DiffEngineError(
                f"fresh hexdiff subprocess failed for {unit} {symbol!r} "
                f"(rc={r.returncode}): {_stderr_tail(r.stderr or '')}",
                exit_code=r.returncode,
                stderr=_stderr_tail(r.stderr or ""),
            )
        return json.loads(r.stdout)

    # Parity: the in-process result must equal a fresh subprocess result.
    sub0 = subprocess.run(cmd, capture_output=True, text=True)
    res_sub0 = _check_subproc(sub0)
    res_in0 = _diff(unit, symbol)  # warm call (fills any remaining caches)
    parity = res_in0 == res_sub0

    in_times: list[float] = []
    for _ in range(n):
        t0 = time.perf_counter()
        _diff(unit, symbol)
        in_times.append((time.perf_counter() - t0) * 1000.0)

    sub_times: list[float] = []
    for _ in range(n):
        t0 = time.perf_counter()
        subprocess.run(cmd, capture_output=True, text=True)
        sub_times.append((time.perf_counter() - t0) * 1000.0)

    def _fmt(ts: list[float]) -> str:
        return f"mean {statistics.fmean(ts):.1f} ms/req, min {min(ts):.1f} ms/req"

    in_mean = statistics.fmean(in_times)
    sub_mean = statistics.fmean(sub_times)
    speedup = sub_mean / max(in_mean, 1e-9)

    print(f"[diff-engine] bench {unit} {symbol} (N={n}, --no-build):", file=sys.stderr)
    print(f"[diff-engine]   in-process:       {_fmt(in_times)}", file=sys.stderr)
    print(f"[diff-engine]   fresh-subprocess: {_fmt(sub_times)}", file=sys.stderr)
    print(f"[diff-engine]   speedup: {speedup:.1f}x", file=sys.stderr)
    print(
        f"[diff-engine]   parity (in-process JSON == fresh subprocess JSON): "
        f"{'OK' if parity else 'MISMATCH'}",
        file=sys.stderr,
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="diff-engine.py",
        description="M2.5 Xenoblade diff-engine NDJSON worker (adapters/xenoblade).",
    )
    parser.add_argument(
        "--repo", metavar="ROOT", default=None,
        help="xenoblade repo root; overrides XENOBLADE_REPO and the sibling-of-decompi default",
    )
    parser.add_argument(
        "--bench", nargs="+", metavar="ARG", default=None,
        help="run the timing benchmark: --bench <unit> <symbol> [N]",
    )
    args = parser.parse_args(argv)

    if args.repo:
        root = Path(args.repo).resolve()
    else:
        root = Path(os.environ.get("XENOBLADE_REPO", str(_DEFAULT_XENOBLADE_ROOT))).resolve()
    _load_engine(root)

    _warmup()
    print("[diff-engine] ready", file=sys.stderr, flush=True)

    if args.bench is not None:
        if len(args.bench) < 2:
            print("usage: python3 diff-engine.py --bench <unit> <symbol> [N]",
                  file=sys.stderr)
            return 2
        unit, symbol = args.bench[0], args.bench[1]
        n = int(args.bench[2]) if len(args.bench) > 2 else 5
        bench(unit, symbol, n)
        return 0

    serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
