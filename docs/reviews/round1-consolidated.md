# Round 1 — Consolidated Adversarial Review (Decompi SPEC.md)

Reviewers: kimi-k3 (`pi/openrouter/moonshotai/kimi-k3`, high) and glm-5.2
(`pi/openrouter/z-ai/glm-5.2`, high). Raw reviews in this directory
(`round1-kimi-k3.md`, `round1-glm-5.2.md`). Findings deduplicated and merged;
where both reviewers independently found the same issue it is noted as
**[converged]** — treat these as highest-confidence.

---

## CRITICAL

### C1 — The acceptance stack (byte-match/witness) is mis-scoped, misplaced, and un-milestoned. **[converged]** (glm C1/C3, kimi #2/#3)
- `byte-match` sits in **core** (`src/verify/byte-match.ts`) but is 100% MWCC/PPC/ELF/DOL-specific. Replacing `hexdiff.py` means reimplementing: 1,714-line hexdiff + 911-line `reloc_map.py` + `object_size.py` + DOL stripped-name recovery + `tools/ppc_equivalence` (**~61k lines**: ELF parsing, PPC opcode decode, IR) — all Python, all in this repo. This violates Principle 1 ("core has zero knowledge of MWCC, PPC") and has **no milestone**.
- The "witness" is not a "native tool": it is `renaming_witness.py` + `tools/ppc_equivalence` using **z3 Python bindings**, in this repo. §1's "No Python scripts… not Python scripts from this repo" is factually false for the witness.
- **Fix:** move byte-match/diff entirely into the adapter (`GameAdapter.diff/verify` already exist — use them); core keeps only the `Verifier` interface + a thin `diff-verifier` driver. Add an explicit milestone (between M2 and M3) for the Xenoblade diff engine with a JSON-parity harness vs `hexdiff.py --json`. Amend §1: the witness is a **versioned external Python+z3 process dependency** (like MWCC/ninja), carved out of deprecation; `.venv`/`tools/ppc_equivalence` provisioning stays in scope.

### C2 — No equivalence-certificate model; migration discards semantic-equivalence provenance. **[converged]** (glm C3, kimi #6)
- v1 has a full `equivalence_certificate` system: `SEMANTIC_CERTIFIED`, sha256 chaining of callee certs, helpers, summary, `equivalence_confidence` (A/B/C), `equivalence_policy` — stored in `targets.certs.jsonl.gz` (7 MB). The spec drops all of it; there is no `certificates` table.
- **Fix:** add a `certificates` table (work_item_id, status, evidence, retail/candidate sha256, certificate_sha256, callees, helpers, summary, created_at) + `equivalence_confidence`/`equivalence_policy` columns; `witness` emits a certificate the acceptance pipeline stores; M5 acceptance requires certificate migration with chain integrity verified.

### C3 — The pipeline/step model cannot express v1's core execution semantics. (kimi #1)
- `Pipeline.steps` is a flat list; nothing says whether steps run per-item, per-batch, or per-run. v1's cost structure is **batching** (`batchSize:5` targets share one session + one brief), **size-based retry routing** (singleton at a harder model vs rebatch at a cheaper one), and the **TU-final trigger** ("unit reaches zero unmatched → finalize"). A flat per-item model = ~5× session-cost regression and cannot express routing or triggers. `run_workers.work_item_id` (singular) bakes in the wrong unit.
- **Fix:** add `foreach`/`batch` step kinds (group N items into one shared prompt), per-step `onReject` routing to named sub-pipelines with their own model/budget, and an event-trigger construct (`on unitComplete → pipeline tu-final`). Make `run_workers` a worker→items relation.

### C4 — Selector→SQL contradicts the "no JSON operators" portability rule. **[converged]** (glm C2, kimi #10)
- `Selector.filter.meta` (`contains`/`regex`) cannot be pushed into portable SQL over a single `meta TEXT` JSON column without JSON1/JSONB. Hot fields (symbol, region, address, milestone, required_level, equivalence_*) are unqueryable in `meta` — a regression vs v1's first-class fields — and `LIMIT` can no longer be pushed down (filter-then-limit silently changes semantics).
- **Fix:** promote queryable fields to real columns (or a typed `work_item_attrs(key,value,val_type)` index table + `work_item_deps`/`work_item_capabilities` edge tables). Restrict `meta` ops to documented app-side post-filtering, or add an engine-capability flag permitting JSON operators per adapter.

### C5 — `member_check.py`/`extc.py` are asm/obj/symbol analyzers, not C++ CST rules. **[converged]** (glm C4, kimi #17/#18)
- `member_check.py` parses dtk `.s` retail asm + scans `.o` binaries for data pointers + reads `symbols.txt` + parses mangled `__Q…` names; `extc.py` joins symbols.txt + `retail_reloc_map.json` + source. None touch a C++ CST, yet §4 puts them under `parse/cpp/rules/` and §13 under the tree-sitter heading. The adapter interface has **no hook** for their data inputs (symbol table, retail asm index, reloc map). Parity is also understated: `member_check` has `header_drift`, `fake_members`, `callee_params`, `vtable_hints`, `integer_only`/`vtable_dispatch` verdicts; `extc` has `plan` (mangling rename plan), `jp_stale_address`, `unparsed`.
- **Fix:** split §13 into "source-CST rules" vs "binary/asm analysis"; add `parse/asm/` + `parse/symbols/` modules; add adapter data-source interfaces (symbol table, retail asm index, reloc map); extend the rule/command lists or mark the extras deferred.

### C6 — Delta-lint over tree-sitter-cpp is the wrong tool and infeasible as described. **[converged]** (glm C5, kimi #19)
- `lint.py` is **line/diff-based** with cross-line state (`cast_pending`), comment stripping, and C/C++ branching; tree-sitter parses whole files and cannot "parse added lines in isolation." Mapping a difflib delta to CST nodes is an unsolved problem the spec doesn't design. Also `smell_report.py` — the actual **committed CI gate** (freshness + per-TU regression, RVL variant, `--completeness`) — is absent from the spec entirely. And `PlaceholderPatterns.unknown`'s anchored default `^(unk…|…)` would **miss** `CActorParam_UnkStruct2`, which `lint.py`'s unanchored `_RE_UNK_GEN` intentionally catches.
- **Fix:** keep the delta gate line-oriented (regex+state machine) explicitly; use CST for whole-file rules only. Define parity as **golden-corpus comparison with a documented deviation list** (not count-identical). Add `smell_report` (write/check/regression) to scope + M1/M5. Un-anchor the unknown-pattern default to match `lint.py`.

---

## HIGH

### H1 — Standalone CLI mode violates the single-writer model. **[converged]** (glm H1, kimi #11)
Direct store open by a standalone CLI = second SQLite writer, `database is locked`, and `events.seq` (read MAX,+1) races. **Fix:** daemon-mandatory (CLI = RPC), or a single-writer flock; make `events.seq` engine-assigned.

### H2 — Claim CAS/lease/orphan-recovery is underspecified. **[converged]** (glm H2, kimi #13/#14)
No epoch/expires/heartbeat; PID-reuse guard from v1 dropped; recovery is "daemon start" only (a long-lived daemon never reaps mid-lifetime worker deaths); portable atomic-claim SQL unspecified (`INSERT OR IGNORE` vs `ON CONFLICT DO NOTHING`). **Fix:** owner = `run_id:worker_seq` + lease/heartbeat + continuous reap; add `insertIgnore`/`isUniqueViolation` to `SqlAdapter`; add FK(run_id) + index.

### H3 — Registry-maintenance tooling + graph edges have no home. **[converged]** (glm H3, kimi #7)
`depends_on`/`capabilities`/callgraph/`milestone`/`required_level`/`equivalence_*` all in `meta` → unqueryable; `recertify --bottom-up` needs queryable deps. `targets scan-source/sync-calls/sync-symbols/recertify/dedupe/import-symbols/audit-promotion`, `reloc-map`, `size`, `progress`, `ctx`, `triage` have no CLI/milestone. **Fix:** edge tables + promoted columns; scope these as adapter commands in M5 or explicitly keep the Python registry tools alive.

### H4 — Event/span write path (N×M agents → single writer) unspecified. (glm H4)
Batching queue, backpressure, `seq` assignment, and `(run_id, ts)` index all missing. **Fix:** in-process channel; daemon assigns `seq` under a batching writer; bounded queue (block, never drop); add `idx_events_run_ts`.

### H5 — Security model underspecified. **[converged]** (glm H5, kimi #22)
Bearer-token-on-mutating-only leaks read endpoints (transcripts contain copyrighted retail ASM). No bind-address default, TLS/proxy story, per-token spend caps, pipeline allowlists, audit log, global spend cap, or WS auth. **Fix:** default bind 127.0.0.1; token on **all** endpoints; per-token caps + allowlists; `audit_log` table; global daemon spend cap; WS auth; fronting proxy required beyond localhost.

### H6 — Build-lock scope must exclude the witness (run30 incident). (kimi #5)
v1 deliberately does **not** hold the flock across the z3 witness (a z3 spin under the lock froze every agent ~30 min). §5's "runs the build… under the lock" would reintroduce it. **Fix:** lock covers build + post-build `.o` reads only; witness/SMT runs outside the lock; port the comment verbatim.

### H7 — Migration drops load-bearing state. **[converged]** (kimi #6, glm C3)
No field-by-field mapping, no id preservation, no exhaustion/attempt-state import (ledger-driven `maxAttemptsPerTarget`), no `workflow_status` axis, no `instruction_match`/`required_level`. **Fix:** migration section with a field map; mandatory id preservation; import exhaustion + certificates; acceptance = reproduce `run.py targets status` + the exhausted set.

### H8 — M0 needs an adapter that M5 delivers. **[converged]** (glm H7, kimi #20)
**Fix:** ship a fixture/test adapter in M0.

### H9 — `fakematch-detect` promoted from heuristic flag to reject-verifier. (glm H8)
**Fix:** keep it a pipeline emitting flags/events; if a verifier, return a soft verdict (`flags`/`severity`), not `accepted:false`.

### H10 — M1 acceptance excludes files §13.1 claims parity with. **[converged]** (glm H6, kimi #19)
**Fix:** split M1a (C++ CST: lint/smell/pointer-arith/detect_smells source-scan) from M1b (asm/obj/symbol: member_check/extc/witness-cert) — M1b after the store milestone.

### H11 — Two status axes, one column. **[converged]** (glm M1, kimi #8)
**Fix:** core-owned `lifecycle` column beside adapter `status`; add REVALIDATION_REQUIRED/BLOCKED/NOT_REQUIRED to the lifecycle vocab.

### H12 — Per-model pacing, not one global pacer. (kimi #15)
One global pacer sized for a 20-rpm provider strangles a 1,000-rpm sibling run. **Fix:** pacer keyed by model-directory name + a daemon-wide concurrency semaphore.

### H13 — Budget is a column, not a mechanism. (kimi #16)
**Fix:** integer micro-USD (or derive cost from tokens at read); check at step/round boundaries; hard-abort path; define in-flight worker behavior.

### H14 — Call-graph "wave" selection is unexpressible. (kimi #9)
`isCallGraphReady` is a recursive predicate over a JSON array. **Fix:** materialize derived columns (`ready`, `attempts`, `exhausted`, `milestone`, `region`) maintained by the engine on status change.

---

## MEDIUM (merged, one-line each)

- **M1** Region column/index missing (multi-region DB can't select "us-region by size"). (glm M2)
- **M2** `run_workers` lacks step_index/step_state — multi-step resume undefined. (glm M3)
- **M3** No tables for banked drafts / rate-limit-watchdog state / proposals. (glm M4)
- **M4** Lock ordering between build flock and SQLite write txn unspecified (AB-BA deadlock). (glm M5)
- **M5** `events.seq` generator unspecified/not portable; add `counters` table or MAX+1 inside the write txn. (glm H/M)
- **M6** Adapter discovery mechanism unspecified (`DECOMPI_ADAPTER` env → config → `adapters/<id>/` → fail). (glm M6)
- **M7** "Clang not in scope — ever" over-absolute for a game-agnostic harness; soften to "core ships tree-sitter only; an adapter may optionally provide a clang backend." (glm M7)
- **M8** tree-sitter MWCC parseability needs a spike: parse all of src/kyoshin + libs/*, report error-node rate (asm-decl/`DECL_SECTION`/`DECL_WEAK` forms). (glm M8)
- **M9** "port lessons" list is inaccurate — v1 has no "budget caps"/"resume"; omits torn-`.o` backoff, witness-outside-lock, PID-reuse guard, ledger append serialization, round-start jitter. Add a lesson→module traceability table. (kimi #12)
- **M10** One `ModelRuntime` per process with N models/providers needs a per-model pooling spike; REST pause/resume semantics on a live pi session undefined. (kimi #24)
- **M11** No `idx_events_work_item_id`; per-item history scans the whole append-only table. (kimi #21)

## LOW / NIT (merged)

- **L1** No retention/pruning for events/spans/artifacts; add `--retention-days` + `prune` + WAL checkpoint cadence. (glm L1)
- **L2** `prompts` not joined to spans; add `spans.prompt_id`. (glm L2)
- **L3** `style_guides` table is a UI/replay cache, not a second source of truth — say so; file wins on drift, UI writes the file. (glm L3, kimi #23)
- **L4** `claims.allowed_paths` enforcement path undefined — intersect agent write-tool allowlist with the worker's claim at call time. (glm L4)
- **L5** `units` has no source-path set; add `unit_files` or `units.source_paths`. (glm L5)
- **L6** Rename `decompi hexdiff` → `decompi diff` (keep `hexdiff` as Xenoblade alias). (glm L6)
- **L7** Glossary "Span" examples (session/verify/build vs +agent turn) — pick one set. (glm N1)
- **L8** `runs.status=paused` semantics undefined (vs cancel). (glm N2, kimi #24)
- **L9** `models.json` `thinkingLevel` → `thinking_level` enum validation in loader. (glm N3)
- **L10** `Pipeline.plan` returns `AsyncIterable<WorkItem[]>` but no step consumes a stream; define per-item vs per-batch execution. (glm N4, kimi #1)
- **L11** §17 `suggestChange` cross-refs a missing `proposals` table (M3). (glm N5)
- **L12** §1 "no sandbox" non-goal must not imply the network surface is safe. (glm N6)
- **L13** M3 runs without the daemon (daemon is M4) → standalone-mode concurrency-unsafe by design; note it. (glm N7)
- **L14** `PlaceholderPatterns.function` default has a pointless capture group and a Xenoblade-flavored default in "generic" core; make patterns adapter-required, provide no misleading defaults. (kimi #26)
- **L15** `sort by "status"` is meaningless; `updated_at` sort key has no index. (kimi #27)
- **L16** Pipeline↔adapter resolution/versioning/error behavior unspecified. (kimi #28)
- **L17** CLI/CI parity tail: `hexdiff --list/--brief/--asm/--relocs`, `ctx/size/progress/triage/behaviour/equivalence` commands, and CI gates (`smell_report --check`, `docs_sync`, fixture-blob check) have no M5 cutover plan. (kimi #25)

---

## Sound (both reviewers, unchanged)

- Append-only events + derived views, ULIDs, TEXT-JSON/ISO timestamps — right at this scale.
- Claims in DB, never git — fixes a real, currently-reproducible bug (316 stale claims sit in committed targets.json today).
- Tree-sitter-cpp over clang for MWCC sources is defensible — as a *backend adapters can replace*, not "never clang ever."
- Co-locating cost with the model preset is a genuine improvement.
- Daemon-as-single-writer + CLI-as-RPC is the right shape (once the standalone exception is removed).

## Top 3 before any code

1. **Pipeline model** (C3) — batching/routing/triggers are the system's reason to exist.
2. **Acceptance stack** (C1/C2) — witness/hexdiff/objdiff mis-scoped, misplaced, un-milestoned; certificates dropped.
3. **Lessons list** (M9/H6) — must be grounded in actual incident history or decompi re-learns run30/torn-`.o`/PID-reuse the hard way.
