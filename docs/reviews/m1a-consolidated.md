# M1a — Consolidated Review

kimi-k3: **M1a BLOCKED** · glm-5.2: **M1a BLOCKED** (missing deliverables).

## Converged CRITICAL (missing M1a acceptance)

1. **`report --check` unimplemented** — §19 M1a + §13.4 require the CI gate
   (freshness + per-TU regression vs base, RVL variant, `--completeness`).
2. **`match.*` rules missing** — `match.func_placeholder`/`class_placeholder`/
   `void_ptr_params` (detect_smells.py parity) absent; registry defers them to M2,
   contradicting §19.
3. **`clone.*` rules missing** — `clone.repeated_code`/`duplicate_class`.

## Converged HIGH (correctness)

4. **Spike report stale** — generated under the broken 0.21.1 pin (631 files threw
   32K limit); never re-run under 0.22.1; error-node count double-counts ancestors.
5. **Delta "500/500" masks an untested diff** — parity uses `oldText=null`, so
   Myers-vs-difflib never exercised; Myers marks strictly fewer lines (weakens the
   gate); the "600-case" claim has no checked-in test.
6. **`smell.deref_arith` root cause wrong** — real cause: Python requires an inner
   scalar cast + enumerated base + `+`; CST doesn't. Parity doc mischaracterizes.
7. **`parseArgs` greedy boolean flags** — `lint --delta foo.cpp` eats the path;
   `--delta=1` silently disables the gate.
8. **`class_in_cpp`/`struct_in_cpp` fire on headers.**
9. **Myers O((n+m)²) memory** → OOM on large rewrites.

## Other (MEDIUM/LOW)

ptr_arith terminator dropped · multi-file `--json` invalid · extern_c lbl anchor
misses fn-pointer · tree-sitter exact pin liability · runReport no --config ·
compileConfig silent unknown keys.

## Fix agent

13 items dispatched (deepseek-v4-flash, low): missing rules + `report --check`,
arg parsing, header gating, deref_arith semantics, spike re-run, diff trim +
differential test, ptr terminator, JSON output, plus the cheap items.
