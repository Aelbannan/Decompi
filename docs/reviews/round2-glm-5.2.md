## Section A — Round-1 finding verification

### CRITICAL

| # | Verdict | Notes |
|---|---|---|
| **C1** (acceptance stack scope/milestone) | **FIXED** | Byte-match/diff moved entirely behind `GameAdapter.diff/verify/unitReport`; core keeps only `Verifier` + thin driver (§7, §9). §1 amended truthfully (diff engine + witness are external Python+z3 process deps, carved out of "no Python"). New **M2.5** milestone with JSON-parity harness vs `hexdiff.py --json`. — See new issue **N2** below: the witness seam is still inconsistent (`witnessCommand?: string[]` vs persistent-worker). |
| **C2** (certificates dropped) | **N/A** | Deliberately removed per user decision; removal is clean. |
| **C3** (pipeline model) | **PARTIAL** | `foreach`/`batch`/`onReject`/`Trigger` added (§10) and `run_workers` gained `step_index`/`step_state`. But: (a) `run_workers.work_item_id` is still **singular** while `foreach` groups N items into one shared session — the worker→items relation C3 asked for is not realized; (b) `foreach` vs `batch` overlap and only `foreach` has a batch size; (c) `onReject` is a single `Route` and cannot express the two-branch singleton-vs-rebatch asymmetry it claims to model (see **N4**); (d) trigger detection/re-entrancy unspecified (see **N5**). |
| **C4** (selector→SQL vs no-JSON) | **FIXED (with residue)** | Promoted columns (`region`, `symbol`, `address`, `milestone`, `required_level`, `attempts`, `exhausted`, `ready`) + edge tables (`work_item_deps`, `work_item_capabilities`) resolve the hot-field queryability and `LIMIT`-pushdown for promoted fields. `filter.meta` is explicitly an app-side post-filter. Residue: the LIMIT-then-post-filter interaction for `meta` is *said* to be "documented" (§8) but is not actually documented — see **N9**. |
| **C5** (member_check/extc mis-scoped) | **FIXED** | §13 split into 13.1 (source CST) vs 13.3 (binary/asm/symbol); `parse/asm/` + `parse/symbols/` modules added (§4); adapter data-source hooks `symbolTable`/`retailAsmIndex`/`relocMap` added to `GameAdapter` (§7); rule lists extended to include `header_drift`/`fake_members`/`callee_params`/`vtable_hints`/`integer_only`/`vtable_dispatch`/`jp_stale_address`/`unparsed`/`plan`. |
| **C6** (delta-lint over tree-sitter) | **FIXED** | §13.2 keeps the delta gate explicitly line/regex+state-machine; CST reserved for whole-file rules. Parity defined as golden-corpus + documented deviations (§13.4). `smell_report` brought into scope as `decompi report --check` (§15) and into M1a/M5 acceptance. `PlaceholderPatterns.unknown` is un-anchored and explicitly matches `lint.py` substring semantics (§7, §13.2). |

### HIGH

| # | Verdict | Notes |
|---|---|---|
| **H1** (standalone CLI = 2nd writer) | **FIXED (but see N3)** | §5: "daemon is mandatory… no standalone mode." `events.seq` is daemon-assigned from `counters` (§6.2, §18). — However the milestone ordering still places M2/M2.5/M3 before the daemon (M4), see **N3**. |
| **H2** (claim lease/epoch/reap) | **PARTIAL** | `owner=run_id:worker_seq`, `epoch`, `expires_at`, `heartbeat_at`, `insertIgnore`/`isUniqueViolation`, FK(`run_id`)+indexes all present (§6.2, §6.3, §6.1). Continuous reap on timer + cancel/pause/fail stated. Gaps: (a) daemon-**restart** sweep of old-epoch claims is implied by `epoch` but never stated (§6.3 only mentions mid-lifetime reap); (b) no **fencing** — a slow worker whose lease expired can still complete writes before the allowed_paths intersection rejects the next call (§6.3, §11); (c) `allowed_paths` derivation is unspecified (who computes it at claim time?); (d) `ON DELETE SET NULL` on `claims.run_id` vs reap-on-cancel ordering is ambiguous — if the run row is deleted before reap, the reaper can no longer find claims by `run_id`. |
| **H3** (graph edges + maintenance cmds) | **FIXED (with drops)** | Edge tables + promoted columns added (§6.2); adapter-declared maintenance commands surfaced (§15). But `dedupe`, `import-symbols`, `audit-promotion` from v1 are silently dropped — not in §15's adapter-command list. |
| **H4** (event/span write path) | **FIXED** | §18: in-process channel (or local socket for subprocesses), daemon assigns `seq` from `counters` inside a batched write txn, bounded queue with backpressure (block, never drop). `idx_events_run (run_id, ts)` present (§6.2). |
| **H5** (security) | **PARTIAL** | §16: default bind 127.0.0.1, bearer token on **all** endpoints (incl. WS upgrade), per-token spend cap + pipeline allowlist, `audit_log`, global daemon spend cap, pipelines not API-authorable. Gaps: (a) **no `tokens` table** — per-token caps and cumulative spend have no storage/enforcement path defined (audit_log records cost per action but there's no per-token aggregate or cap config location); (b) "fronting reverse proxy required beyond localhost" is stated but TLS/origin-validation is hand-waved. |
| **H6** (witness outside build lock) | **FIXED** | §5: lock covers "build + immediate post-build `.o` reads only"; witness/SMT runs outside the lock; run30 incident cited verbatim; lock ordering (flock outside SQLite txn) specified. |
| **H7** (migration drops state) | **PARTIAL** | M5 acceptance now requires reproducing `run.py targets status` + the exhausted set, and `targets.json + ledger → SQLite` is named. But: **no field-by-field migration map**, **no explicit id-preservation requirement**, no statement that **claims must NOT be migrated** (the 316 stale claims would otherwise come along), `workflow_status` axis absent, `instruction_match` not surfaced. The migration is milestone'd but not specified. |
| **H8** (M0 fixture adapter) | **FIXED** | M0 ships a "fixture adapter (imports JSON/CSV)" (§19). |
| **H9** (fakematch as reject-verifier) | **FIXED** | §9: fakematch-detect is a pipeline emitting flags/events, "never a hard `accepted:false`." |
| **H10** (M1 split) | **FIXED (modulo ordering)** | M1a (C++ CST source-scan) / M1b (asm/obj/symbol) split; M1b correctly deferred to after the store. But the milestone *table order* lists M1b before M2 while its acceptance says "(after store exists)" — see **N6**. |
| **H11** (two status axes) | **FIXED** | `lifecycle` (core-owned) + `status` (adapter vocab) columns; `revalidation_required`/`blocked`/`not_required` in the lifecycle vocab (§6.2, §8). |
| **H12** (per-model pacing) | **FIXED** | §11: pacer keyed by model-directory name + daemon-wide concurrency semaphore. |
| **H13** (budget mechanism) | **FIXED (lite)** | Integer `budget_micro_usd` (§6.2); checked at step/round boundaries; hard-abort stops in-flight workers (§11). In-flight worker kill mechanics unspecified (cooperative cancel vs SIGKILL depends on process model — see **N8**). |
| **H14** (call-graph wave) | **PARTIAL** | `ready`/`attempts`/`exhausted` materialized (§6.2, §8). But the maintenance trigger is wrong/incomplete: §8 says these are "maintained by the engine on status/claim/verify transitions," yet `ready` changes when **deps change** (`sync-calls` / `work_item_deps` mutation), not on a verify transition. No reconciliation/recompute command if materialized columns drift from the event log. |

### MEDIUM (compressed)

- M1 region col/index → **FIXED** (`idx_work_items_region`).
- M2 `run_workers.step_index/step_state` → **FIXED** (but singular `work_item_id` breaks batched resume — see **N1**).
- M3 drafts/proposals tables → **FIXED**; rate-limit/watchdog state left in-memory (acceptable).
- M4 lock ordering → **FIXED** (§5).
- M5 `counters` table → **FIXED** (§6.2, §18).
- M6 adapter discovery → **FIXED** (§7).
- M7 clang softened → **FIXED** (§13).
- M8 tree-sitter spike → **FIXED** (M1a acceptance).
- M9 lessons traceability table → **FIXED** (§11).
- M10 model pooling spike / pause-resume → **PARTIAL** (pause-at-next-step defined; per-model pooling spike not addressed).
- M11 `idx_events_work` → **FIXED**.

### LOW (compressed)

- L1 prune/retention → **FIXED** (§18, CLI `prune`).
- L2 `spans.prompt_id` → **FIXED**.
- L3 `style_guides` cache vs file → **FIXED** (§12).
- L4 `allowed_paths` enforcement → **FIXED at call-time** (§11); **derivation** still unspecified.
- L5 `units.source_paths` → **FIXED**.
- L6 `diff`/`hexdiff` alias → **FIXED**.
- L7 Span examples → **FIXED**.
- L8 `paused` semantics → **PARTIAL** (no `pause_requested` transition state — see **N7**).
- L9 `thinkingLevel` validation → **FIXED** (§14).
- L10 plan stream / per-item exec → **FIXED** (§10).
- L11 `proposals` table → **FIXED**.
- L12 network surface → **FIXED** (§16).
- L13 M3-without-daemon → **NOT FIXED / REGRESSION** — §5 now makes the daemon *mandatory* ("no standalone mode") but milestones still put M2/M2.5/M3 before M4; the contradiction is sharper than round 1 (see **N3**).
- L14 placeholder defaults → **FIXED** (§7, adapter-required, no core defaults).
- L15 `sort by "status"` meaningless + `updated_at` index → **NOT FIXED** (`sort.by: "status"` still in §8; no `idx_work_items_updated_at`).
- L16 pipeline↔adapter resolution/versioning → **PARTIAL** (§10 `Pipeline.adapter` field; versioning/error behavior still absent).

---

## Section B — New findings

### CRITICAL

**(none)** — nothing new at CRITICAL severity. The remaining problems are coherence/underspecification, not architectural fractures.

### HIGH

**N1 — `run_workers.work_item_id` is singular, but `foreach`/`batch` process N items per worker session.** §6.2 vs §10.
- *Problem:* C3's fix demanded a worker→**items** relation. The schema still has `run_workers.work_item_id TEXT` (one item). A `foreach` step groups N items into one shared agent session (§10), so a worker row cannot record which items it owns/processed. Resume (`step_state`) for a partially-completed batch is also ambiguous — there is no place to persist per-item progress within the batch.
- *Why it matters:* This is the unit-of-work mismatch C3 was about. The pipeline model gained batching but the persistence model didn't follow.
- *Fix:* Either a `run_worker_items(run_id, worker_seq, work_item_id, state)` junction table, or make `run_workers.work_item_id` a JSON array + document partial-batch checkpoint semantics. Section §6.2.

**N2 — The witness seam contradicts itself: `witnessCommand?: (ctx, item) => string[]` vs "persistent worker process."** §7, §9, §1, §4.
- *Problem:* §1/§4/§9 all say the witness is a long-lived stdio/JSON worker spawned once (`adapters/xenoblade/witness.ts # persistent worker wrapping renaming_witness (z3)`). But the `GameAdapter` interface exposes `witnessCommand?(ctx, item): string[]` — a *command argv*, i.e. the per-call spawn model — and §9 routes the witness verifier through `GameAdapter.witnessCommand`. Returning an argv and running a persistent worker are mutually exclusive shapes.
- *Why it matters:* An implementer cannot tell whether core owns the worker lifecycle (then the interface should return a `WorkerSpec`/handler, not an argv) or the adapter owns it (then `witnessCommand` is dead and `verify()` is the only seam). The same ambiguity infects `buildUnit`/`diff`/`unitReport`, which are high-level `Promise<…>` methods — does core's `worker.ts` spawn the diff-engine worker, or does the adapter do it internally behind `diff()`? `worker.ts` is listed in **core** (§4) but the interface gives core no worker-spec to spawn.
- *Fix:* Pick one layering. Recommended: `GameAdapter` exposes `diffEngine(): WorkerSpec` / `witnessEngine(): WorkerSpec` (script path + protocol) and core's `worker.ts` owns spawn/lifecycle/pool; `diff()`/`verify()` then become core-side drivers over the worker protocol, not adapter methods. Drop `witnessCommand`. Section §7, §4, §9.

**N3 — Milestone ordering contradicts the mandatory-daemon principle (regression of L13).** §19 vs §5.
- *Problem:* §5: "The daemon is mandatory. Every CLI command is a thin RPC to the daemon. There is no standalone mode." Yet M2 (store/selectors/claims), M2.5 (diff engine), and M3 (pipeline/agent) all ship **before** M4 (daemon/control plane). M2's own acceptance — "claims are cross-process safe (lease CAS)" — requires a single writer (the daemon) to exist. M3's "drives one TU end-to-end" requires claims, events.seq, and the single writer. You cannot test M2/M3 acceptance without the daemon that M4 delivers.
- *Why it matters:* Round 1 L13 asked this be *noted*; the revision instead made the contradiction sharper by promoting the daemon from "M4 feature" to "mandatory invariant" without reordering milestones.
- *Fix:* Split the daemon into an **M2-embedded store/single-writer daemon** (claims + events + selectors, no REST/UI) and an **M4 control-plane daemon** (REST/WS/UI/scheduling/security). M3 then runs against the M2 daemon. Section §5, §19.

**N4 — `onReject: Route` is a single route and cannot express the singleton-vs-rebatch asymmetry it claims.** §10.
- *Problem:* `Route.by.sizeBelow` is documented as "singleton vs rebatch routing (v1 singletonMinSize)." v1 semantics: items below `singletonMinSize` → singleton at a *harder* model; items above → rebatch at a *cheaper* model. That is **two** branches with different target pipelines, models, and attempt budgets. But `onReject?: Route` is a single `Route` (`to`, `model`, `maxAttempts`). One route cannot branch into two sub-pipelines by size. It's unclear whether `sizeBelow` means "route only items below this to `to`" (then where do the rest go? unspecified) or is inert metadata.
- *Fix:* Make `onReject: Route[]` with per-route `when` predicates (size/model/attempts), evaluated in order; or model it as `onReject: { singleton?: Route; rebatch?: Route }`. Define the default for items matching no route. Section §10.

### MEDIUM

**N5 — Trigger detection and re-entrancy are unspecified.** §10, §4 (`engine.ts # trigger dispatch`).
- *Problem:* `Trigger.when: "unitComplete" | "runStart" | "runEnd" | string`. `unitComplete` requires evaluating "this unit has zero non-accepted items" — a query the engine must run after every verify transition. Cadence (every verify? batched?), cost, and the index it relies on are unspecified. Worse: a triggered pipeline (`tu-final`) may itself accept/reject items and re-fire `unitComplete` on the same unit — no re-entrancy/de-dup guard is defined.
- *Fix:* Define trigger evaluation as a post-verify sweep keyed on `unit_id` with a "triggered" marker per (unit, pipeline) to prevent re-fire; document the query and that it uses `idx_work_items_unit` + `lifecycle`. Section §10.

**N6 — M1b is table-ordered before M2 but its acceptance says "(after store exists)."** §19.
- *Problem:* §19 lists M1a → M1b → M2, but M1b's acceptance reads "parity … on recorded cases (after store exists)." Either M1b needs a stub store (say so) or it belongs after M2.
- *Fix:* Reorder to M1a → M2 → M1b → M2.5, or state that M1b runs against an in-memory stub store pre-M2. Section §19.

**N7 — `runs.status=paused` has no `pause_requested` transition state.** §6.2, §11.
- *Problem:* §11: "pause at next step boundary." Between the pause command and the next boundary, `status` is still `running` — a concurrent `decompi run` against the same selector may see a "running" run and assume it's not pausing. There's no `pause_requested` flag/column.
- *Fix:* Add `pause_requested INTEGER NOT NULL DEFAULT 0` to `runs`, or a `pausing` status enum value distinct from `paused`. Section §6.2, §11.

**N8 — Agent process model (in-process vs subprocess) is undecided, breaking budget-abort and claim-RPC assumptions.** §5, §11, §18.
- *Problem:* §5 puts the worker pool *inside* the daemon (in-process). §18 says agents emit events "through an in-process channel (or a local socket if subprocesses)." §5 says "Workers RPC the daemon for claim/release" — only meaningful if workers are subprocesses. The process model drives: (a) crash isolation (in-process agent crash kills the daemon/single writer), (b) budget hard-abort mechanics (cooperative cancel vs SIGKILL), (c) whether claim/release is a direct call or RPC, (d) whether a hung agent blocks the daemon event loop. All unspecified.
- *Fix:* Decide and state: recommended subprocess workers (crash isolation matters — a pi/oh-my-pi crash must not take down the single writer), with the daemon owning an in-process claim/event API that workers reach over the local socket. Define hard-abort as SIGTERM-then-SIGKILL with a grace period. Section §5, §11, §18.

**N9 — `filter.meta` post-filter + `LIMIT` silently returns fewer than `limit` items, and it's not actually documented.** §8.
- *Problem:* §8 says meta filtering is "an explicit app-side post-filter applied after SQL selection (documented; no JSON operators)." But the LIMIT interaction is not documented anywhere: SQL returns `limit` rows, the meta post-filter then drops some, so the caller gets ≤ `limit` (possibly 0) items. This is the exact "filter-then-limit silently changes semantics" residue from C4.
- *Fix:* Either over-fetch (SQL `LIMIT limit * over_fetch_factor` then post-filter then truncate) with a documented heuristic, or require that any selector using `filter.meta` skip SQL pushdown of `LIMIT` and fetch all matches. Document the chosen behavior. Section §8.

**N10 — `ready` materialization trigger is wrong; no recompute path.** §8, §6.2.
- *Problem:* §8 says materialized columns are "maintained by the engine on status/claim/verify transitions." But `ready` (call-graph resolved) changes when `work_item_deps` changes (via `sync-calls` / `scan-source`), *not* on a verify transition. So after a `sync-calls` run, `ready` is stale until some unrelated verify happens. Also, since events are the source of truth (§3.4) but materialized columns are incrementally maintained, there's no `recompute`/reconcile command if they drift.
- *Fix:* State that `ready`/`exhausted` are recomputed on `sync-calls`/dep-mutation events, and add a `decompi recompute [--unit]` command (or fold into `sync`) that re-derives materialized columns from the event/dep state. Section §8, §15.

**N11 — Per-token spend enforcement has no storage or config location.** §16, §6.2.
- *Problem:* §16 promises "per-token policy: spend cap (micro-USD) and pipeline allowlist." `audit_log` records `actor` + `cost_micro_usd` per action, but there is no `tokens` table (token id, cap, remaining, pipeline allowlist) and no statement of how cumulative per-token spend is computed at enforcement time (sum over `audit_log` on every `run-create`?).
- *Fix:* Add a `tokens(id, secret_hash, spend_cap_micro_usd, pipeline_allowlist JSON, created_at, revoked_at)` table; enforce by summing `audit_log.cost_micro_usd WHERE actor=token` (or a materialized `token_spend` rollup) at run-create. Section §6.2, §16.

**N12 — Migration does not say claims are not migrated, and has no field map.** §19 M5, §6.3.
- *Problem:* §6.3 is emphatic that "claims are never committed to git (316 stale claims sit in the committed file today)." But M5's "targets.json + ledger → SQLite" migration says nothing about *excluding* claims — a naive importer would faithfully migrate 316 stale leases. Combined with H7's still-missing field map / id-preservation, the migration is underspecified.
- *Fix:* Add a "Migration" subsection: field map (targets.json → work_items/deps/capabilities), mandatory id preservation, explicit "claims are ephemeral and NOT migrated; all items start `lifecycle=pending`," and the exhausted-set import (ledger-derived → `exhausted`). Section §6.3 or a new §6.4.

### LOW / NIT

**N13 — `git-export` of durable assignment isn't wired to any CLI command.** §6.3, §15.
- §6.3 says durable assignment is "git-exported as a canonical snapshot (round-tripping columns, deps, and capabilities)." `decompi export [work-items|…]` (§15) has no `--git`/`--snapshot` flag and no indication it emits deps/capabilities. Either add a `decompi export work-items --git-snapshot` mode or document that `export work-items` round-trips edges. Section §15.

**N14 — Edge/junction tables have no FKs to `work_items`.** §6.2.
- `work_item_deps(from_id, to_id, kind)`, `work_item_capabilities(work_item_id, capability)`, `drafts(work_item_id, …)`, `run_workers(run_id, seq)`, `spans(run_id, …)`, `artifacts(run_id, …)` — none have FK constraints. Orphaned rows on work-item/run delete are silent. Add FKs (or document that deletes are rare and this is intentional). Section §6.2.

**N15 — `counters`-based `events.seq` mechanism is portable but unspecified at the SQL level.** §6.2, §18.
- "daemon assigns `seq` from `counters` inside a single batched-write transaction" — but the actual portable SQL (`UPDATE counters SET next=next+? … RETURNING next` requires SQLite ≥3.35 / Postgres) and how a *batched* write allocates a contiguous seq range in one txn is not shown. Minor, but it's the kind of detail that bites portability. Section §18.

**N16 — `foreach.key?: string` is undocumented.** §10.
- The `key` field on `foreach` has no description. Presumably a grouping key for the batch (group by unit?). State what it does or drop it. Section §10.

**N17 — `models` cache reload trigger unspecified; `max_tokens=0` meaning unstated.** §14, §6.2.
- "reloaded on config edit" — file watcher? mtime? On which commands? And `max_tokens INTEGER NOT NULL DEFAULT 0` with `maxTokens: 0` in the example — the "0 = unlimited" convention is in the JSON example but not the schema comment. Section §14, §6.2.

**N18 — `batch` step kind has no batch size.** §10.
- `foreach` has `batch: number`; `batch` (the step kind) has only `steps` and `onReject`. If `batch` is meant to process a pre-formed batch (e.g. the current foreach group), say so; if it sizes its own batch, the size is missing. The `foreach`/`batch` naming collision (`foreach.batch` the field vs `batch` the kind) is also confusing. Section §10.

**N19 — `gate` step skip semantics undefined.** §10.
- `{ kind: "gate"; when: ... }` — when `when` returns false, does it skip the gate step only, skip the remaining steps in the current scope, or abort? Not specified. Section §10.

**N20 — `select` step's `into: string` binding is not shown to be consumed.** §10.
- `select` writes into a named binding, but no later step kind references `into` bindings (no `from` field on `foreach`/`batch`/`agent`). How does a later step use the selection? Section §10.

---

## Section C — What's now sound, and top fixes before any code

**Now sound (one-liners):**
- Adapter-as-only-seam (§3, §7) is real now that byte-match/diff/witness live behind the adapter — Principle 1 holds.
- Promoted-columns + edge-tables schema (§6.2) is a clean, portable answer to the selector/SQL contradiction; `SqlAdapter` portability primitives (`insertIgnore`/`isUniqueViolation`) make CAS claims engine-agnostic.
- Lease model with `owner=run_id:worker_seq` + `epoch` + continuous reap (§6.3) is the right shape and fixes both PID-reuse and stale-claim-in-git.
- Build-lock scope excluding the witness, with explicit AB-BA ordering (§5) — run30 is genuinely foreclosed.
- Pipeline model *shape* (foreach/batch/onReject/trigger) (§10) is a real improvement over a flat per-item list, even though it has coherence holes.
- §13 split (source-CST vs binary/asm/symbol) with adapter data-source hooks is correct and parity-honest.
- Security posture (§16) — token-on-all-endpoints, default localhost, audit_log, spend caps, no API-authored pipelines — is the right baseline.
- Append-only events + daemon-assigned `seq` from `counters` (§18) is a sound single-writer write path.
- Lessons→module→incident traceability table (§11) grounds the "ported" claims in real incidents.

**Top fixes before any code is written:**

1. **Resolve the witness/worker layering (N2).** `witnessCommand: string[]` vs persistent-worker is a contradiction that will fork every implementation. Pick `WorkerSpec`-on-adapter + core-owned `worker.ts`, drop `witnessCommand`. (HIGH)
2. **Fix the milestone/daemon contradiction (N3).** M2/M3 acceptance is untestable without the daemon; split the daemon into an M2 store-daemon and an M4 control-plane daemon. (HIGH)
3. **Make `run_workers` a worker→items relation (N1) and finish the pipeline model (N4, N18, N20).** The batched-session unit-of-work has no persistence, `onReject` can't two-branch, and `into`/`key`/`batch` are dangling. (HIGH)
4. **Specify the persistent-worker protocol (N8 process model + framing/correlation/restart/timeout).** Right now "spawn once, stdio/JSON" is a sentence where a protocol belongs. (MEDIUM-HIGH)
5. **Close the migration spec (N12 / H7):** field map, id preservation, "claims not migrated," exhausted-set import. M5 is a milestone with no spec body. (MEDIUM)

Everything else (N5–N11, N13–N20) is medium-or-lower and can be tightened during implementation, but the five above are load-bearing and will cause rework if coded around.
