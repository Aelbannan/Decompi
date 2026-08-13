## Section A — Round-1 finding verification

### CRITICAL

| # | Verdict | Note |
|---|---|---|
| **C1** (acceptance stack mis-scoped) | **FIXED** | Diff/witness moved behind adapter as persistent workers (§1, §4, §9); M2.5 is an honest milestone with JSON-parity acceptance. One wart survives — `witnessCommand(): string[]` contradicts the persistent-worker model (see B-H2). |
| **C2** (certificates dropped) | **N/A — removed per user decision; removal verified clean.** | §9 correctly scopes witness evidence to status+summary in `meta`. |
| **C3** (pipeline model can't express v1) | **PARTIAL** | `foreach`/`batch`/`onReject`/triggers added (§10) — good. But `run_workers.work_item_id` is still **singular** (§6.2), so a batched worker's N items have no state home; and route/sub-pipeline semantics are undefined (B-H4, B-H5). The exact thing round 1 called out ("`run_workers.work_item_id` (singular) bakes in the wrong unit") was **not** changed. |
| **C4** (selector vs no-JSON-operators) | **FIXED** | Promoted columns + edge tables; `meta` explicitly an app-side post-filter. Limit×post-filter interaction still loose (B-M4). |
| **C5** (member_check/extc mis-homed) | **FIXED** | §13.3 split, `parse/asm` + `parse/symbols` modules, adapter data sources (`symbolTable`, `retailAsmIndex`, `relocMap`), full rule lists including `header_drift`/`extc plan`/`jp_stale_address`. |
| **C6** (delta-lint over tree-sitter) | **FIXED** | §13.2 stays line/regex+state-machine explicitly; parity = golden corpus + documented deviations; `no_unk_generated` un-anchored; `report --check` scoped into M1a/M5. |

### HIGH

| # | Verdict | Note |
|---|---|---|
| **H1** (standalone CLI = second writer) | **FIXED** | §5 daemon-mandatory, CLI=RPC, no standalone mode. *But the fix created a new contradiction with the milestone schedule — see B-C1.* |
| **H2** (claim lease underspecified) | **FIXED** | Lease/heartbeat/epoch/continuous reap/`insertIgnore`/FK+indexes all present (§6.2/§6.3). Residual races in B-M2/B-M3. |
| **H3** (registry tooling homeless) | **FIXED** | Edge tables + promoted columns; §15 adapter-declared maintenance commands; M5. |
| **H4** (event write path) | **FIXED** | §18: in-process channel, daemon-assigned `seq` via `counters`, bounded blocking queue, `idx_events_run(run_id,ts)`. |
| **H5** (security) | **PARTIAL** | §16 hits every asked-for control (bind, token-on-all-endpoints incl. WS, per-token caps/allowlists, audit, global cap, no API-authored pipelines) — but there is **no storage/provisioning model for tokens or their policies** (B-H3). |
| **H6** (witness under build lock) | **FIXED** | §5 lock covers build + post-build `.o` reads only; run30 cited. |
| **H7** (migration drops state) | **PARTIAL** | M5 acceptance = reproduce `targets status` + exhausted set — good. But the demanded **field-by-field map and mandatory id preservation** are absent; id preservation is nowhere required. |
| **H8** (M0 needs adapter) | **FIXED** | M0 fixture adapter. |
| **H9** (fakematch as reject-verifier) | **FIXED** | `Verdict.flags`, "never a hard accepted:false" (§9). |
| **H10** (M1a/M1b split) | **PARTIAL** | Split done, but the §19 table lists **M1b before M2 (store)** while M1b's own acceptance says "(after store exists)" and §13.3 says "M1b (after the store milestone)". The fix's ordering half was not applied. |
| **H11** (two status axes) | **FIXED** | `lifecycle` (core) vs `status` (adapter); vocab includes `revalidation_required`/`blocked`/`not_required`. |
| **H12** (per-model pacing) | **FIXED** | §11 keyed pacer + daemon-wide semaphore. |
| **H13** (budget mechanism) | **FIXED** | micro-USD, boundary checks, hard-abort path. Minor self-contradiction (B-L7). |
| **H14** (wave selection) | **FIXED** | Materialized `ready`/`attempts`/`exhausted` maintained on transitions. |

### MEDIUM (compressed)
M1 FIXED · M2 FIXED · M3 FIXED (drafts/proposals tables; watchdog state in-memory, acceptable) · M4 FIXED (§5 lock ordering) · M5 FIXED (`counters`) · M6 FIXED (discovery order, but bad cross-ref — B-L2) · M7 FIXED (clang adapter-optional) · M8 FIXED (parse-spike in M1a acceptance) · M9 FIXED (§11 traceability table is accurate and complete) · **M10 PARTIAL** (pause-at-step-boundary defined; the per-model session-pooling spike vanished) · M11 FIXED (`idx_events_work`).

### LOW (compressed)
L1 FIXED · L2 FIXED · L3 FIXED · **L4 PARTIAL** (intersection specified; who *populates* `allowed_paths` is not — B-M8) · L5 FIXED · L6 FIXED · L7 FIXED · L8 FIXED · L9 FIXED · L10 FIXED · L11 FIXED · L12 FIXED · **L13 NOT FIXED — and worsened**: round 1 asked to *note* M3's daemon-less unsafety; rev 2 instead made the daemon mandatory while keeping it in M4 (B-C1) · L14 FIXED · **L15 NOT FIXED**: §8 still lists `sort by "status"`; still no `updated_at` index · **L16 PARTIAL** (`Pipeline.adapter` exists; versioning/missing-id/error behavior still unspecified — B-L13) · L17 FIXED (diff flags, CLI-parity appendix, §20 CI open question).

---

## Section B — New findings

### CRITICAL

**B-C1 — §5 (daemon-mandatory) directly contradicts §19 (daemon in M4).**
- **Problem:** §5: "The daemon is **mandatory**. Every CLI command is a thin RPC to the daemon… There is **no** standalone mode." But the daemon ships in **M4**, while M0 (`select`/`status`), M2 ("claims are cross-process safe", `export`), and M3 ("`match` pipeline drives one TU end-to-end") all precede it. Either M0–M3 build a standalone store-opening mode the spec forbids, or their acceptance criteria are unexecutable. This is round-1 L13 made strictly worse.
- **Fix:** introduce an **embedded/in-process daemon** (same code path, loopback RPC, single process) as the M0–M3 execution mode, promoted to a detached process in M4; or move a minimal `serve` (no UI) into M0/M2. State it in §5 and §19.

### HIGH

**B-H1 — The persistent-worker protocol has zero protocol. (§4 `worker.ts`, §5, §9, M2.5)**
- **Problem:** The spec's biggest new architectural bet — "spawn once, serve many requests over stdio/JSON" — specifies nothing: no message envelope/framing (newline-delimited JSON? Content-Length?), no request-id correlation, no cancellation, no per-request timeout, no crash/respawn semantics (a z3 worker that wedges mid-SMT — the exact run30 failure class — has no watchdog), no statement of whether a worker is serialized (one outstanding request) or multiplexed, no pool-sizing config, no warmup story. M2.5's acceptance is only output parity.
- **Fix:** a §worker-protocol subsection: JSON-RPC-ish `{id, method, params}` envelope, NDJSON framing, one-outstanding-request-per-worker + pool queue, per-request timeout → kill + respawn + retry-once, pool size in adapter config, explicit "worker never holds the build flock; daemon wraps `buildUnit` RPCs with the flock" (ties to B-M6).

**B-H2 — `witnessCommand(): string[]` contradicts the persistent-worker model. (§7 vs §1/§4/§9)**
- **Problem:** Everywhere else the witness is "a persistent worker wrapping renaming_witness (z3)" (`adapters/xenoblade/witness.ts`, §1, §9), but the `GameAdapter` interface exposes `witnessCommand(ctx, item): string[]` — a per-call argv spawn, i.e. exactly the per-call interpreter startup §1 says is eliminated. It's also unclear who calls it: `verify()` *and* `witnessCommand` both exist on the adapter.
- **Fix:** replace with `witness(ctx, item): Promise<Verdict>` routed through the worker pool like `diff`; if a command-line form is needed for debugging, make it an adapter-internal detail, not core interface.

**B-H3 — Auth tokens and their policies have no home. (§16 vs §6.2)**
- **Problem:** §16 mandates bearer tokens, **per-token** spend caps and pipeline allowlists, and per-actor audit — but §6.2 has no `tokens`/`auth` table, and no config file is named as the source. The **global daemon spend cap** likewise has no configured location. As written, the security section is unimplementable without inventing storage.
- **Fix:** add an `auth_tokens` table (token hash, policy JSON, spend cap, allowlist) or explicitly specify a `decompi.config.json` `auth` section; state where the global cap lives.

**B-H4 — `onReject` routing semantics are undefined. (§10)**
- **Problem:** `Route.to` is a "named sub-pipeline id", but `Pipeline` is a full object with `plan()`/`adapter`/`triggers`. Undefined: do routed items skip `plan` and enter `steps`? Are they re-batched or singleton? What is the terminal disposition after `maxAttempts` (lifecycle `rejected`? `blocked`?)? Can routes chain/cycle (A→B→A)? `Route.by` has only `sizeBelow` — v1's routing asymmetry is size-based, fine, but say that's the only dimension or make the predicate general.
- **Fix:** define a sub-pipeline as a steps-only fragment with explicit item ingress; define terminal lifecycle state after route exhaustion; require acyclic route graphs (validate at pipeline load).

**B-H5 — Batch execution has no state model. (§6.2 `run_workers` vs §10)**
- **Problem:** C3 residue: with `foreach batch:5`, one worker session owns 5 items, but `run_workers` has a single `work_item_id` and one `step_state` JSON. Resume mid-batch, per-item outcomes within a batch, and the UI's per-item progress are all unrepresentable.
- **Fix:** `run_worker_items(run_id, worker_seq, work_item_id, step_index, state)` relation, or drop `work_item_id` from `run_workers` and track membership via claims + a batch-id.

### MEDIUM

**B-M1 — `unitComplete` trigger detection is undefined and racy. (§10)** Nothing says how "unit reaches zero unmatched" is computed (a `SELECT count(*) ... WHERE unit_id=? AND lifecycle NOT IN (accepted...)` on every acceptance?), who fires it, or how it's exactly-once when two workers finish a unit's last two items concurrently. **Fix:** daemon-side transition hook re-checking the unit aggregate inside the status-update transaction, firing the trigger once (record in events, dedupe on restart).

**B-M2 — Expired-lease acquisition race + no lease parameters. (§6.3)** `insertIgnore` fails while an expired-but-not-yet-reaped row sits in `claims`; the spec never defines atomic steal (`DELETE … WHERE expires_at < now` then insert, in one txn) — so between expiry and the sweeper's timer, a free item is unclaimable. Heartbeat interval, TTL, and jitter values are also absent. **Fix:** specify steal-on-expired in the claim path and give default TTL/heartbeat numbers.

**B-M3 — `epoch` conflicts with cross-restart resume. (§6.3 vs §11)** Claims carry the daemon-start epoch and "re-claim requires matching owner+epoch". After a daemon restart — the exact scenario `step_state` checkpoints exist for — all leases are foreign-epoch. The spec never says whether runs resume across daemon restart (workers re-claim under the new epoch) or are failed. **Fix:** state it: e.g. "on daemon start, runs in `running` move to `paused`; resume re-claims under the current epoch."

**B-M4 — `meta` post-filter × `LIMIT` is still semantically wrong. (§8)** LIMIT is pushed to SQL, meta filtered after — so `{filter:{meta:[…]}, limit:50}` can return 0–49 rows while matches exist. Round-1 C4 explicitly named this; rev 2 documented the post-filter but not the limit interaction. **Fix:** fetch-filter-until-limit (over-fetch loop), or reject selectors combining `meta` with `limit`.

**B-M5 — `sort.by` free string is an injection/typo vector. (§8)** `by: … | string` compiles into `ORDER BY` from CLI/API input. Authenticated, but still: whitelist to the known promoted columns. (Also L15 residue: `by:"status"` still meaningless; `updated_at` unindexed in §6.2.)

**B-M6 — Build-lock wiring to the worker pool is unspecified. (§5 vs §7)** §5 says the *daemon* holds the flock for "build + immediate post-build `.o` reads", but builds run via `adapter.buildUnit` → persistent worker (hexdiff does build+diff in one invocation). Who acquires/releases around a worker request? Can a `diff` request interleave with a `build` request on the same worker while the lock is held? **Fix:** "daemon wraps `buildUnit` worker-RPCs with the flock; workers never touch the lock; build and diff are separate worker methods with the lock held only across build."

**B-M7 — Git-export snapshot vs `export` CLI mismatch. (§6.3 vs §15)** §6.3 requires a canonical git-exported snapshot "round-tripping columns, **deps, and capabilities**"; §15 `export` offers only `work-items|events|spans` — no deps/capabilities, and no corresponding import/restore command, so "round-tripping" is impossible as specified. **Fix:** `export registry` (work-items+deps+capabilities) + `import`/`sync-from-snapshot`.

**B-M8 — `allowed_paths` population is undefined. (§6.2/§11; L4 residue)** Default `'[]'` = the agent can write nothing. Nothing derives the allowed set from the work item (its `source`, unit headers, etc.). **Fix:** state that the adapter computes `allowed_paths` at claim time (e.g. `adapter.claimScope(item)`).

**B-M9 — M1a includes store-dependent rules before the store exists. (§13.1 vs §19)** "Matched-function smells… **requires store access** for status filtering" sits in M1a; the store is M2. **Fix:** move `match.*` rules to M2+, or define a targets.json fallback reader for M1a.

### LOW / NIT

- **B-L1** Title says "rev 2", header note says "rev 3". Pick one.
- **B-L2** §7: "(§6.1 order)" cross-ref is wrong — discovery order is defined in §7 itself; §6.1 is `SqlAdapter`.
- **B-L3** Lifecycle vocab mismatch: §6.2 DDL comment includes `not_required`; §8's canonical lifecycle omits it.
- **B-L4** §11 budget: "checked at step/round boundaries" vs "hard-abort path stops in-flight workers" — mid-round abort contradicts boundary-only checks. Define which.
- **B-L5** §14 calls the `models` table a "hash-checked cache" but §6.2 gives it no `content_hash` column.
- **B-L6** §8 selector omits an `address` filter despite `address` being a promoted column (§6.2 vs §8).
- **B-L7** `audit_log.cost_micro_usd` semantics undefined (cost of the action? cumulative spend at time of action?); global-cap accounting source unstated. (§16 vs §6.2)
- **B-L8** §10: `foreach.key`, `select.into`, `StepCtx`/`PlanCtx` are referenced but never defined; `shell` step's `Promise<string[]>` return meaning unstated.
- **B-L9** `claims` FK `ON DELETE SET NULL` leaves `owner` (`"<run>:<seq>"`) dangling; if runs are never deleted, the clause is noise. (§6.2)
- **B-L10** `work_item_deps.kind='unresolved_calls'` has no resolvable `to_id` — dangling-target semantics undefined. (§6.2)
- **B-L11** Span `attrs` cost units unspecified — float USD vs the `budget_micro_usd` convention. (§18 vs §6.2)
- **B-L12** `counters` seeding/migration unspecified; `events.seq` initial value unstated. (§6.2/§18)
- **B-L13** Pipeline versioning/missing-id/load-error behavior still unspecified (L16 residue): routes, triggers, and CLI all reference pipelines by id. (§10/§15)
- **B-L14** Silent drops from round-1 H3's command list: `dedupe`, `import-symbols`, `audit-promotion` appear nowhere, even as examples in §15. The generic adapter-command mechanism covers them, but the promised CLI-parity appendix must enumerate them explicitly.
- **B-L15** `drafts` bank: `bankOnlyOnBetter` appears only in a comment; no uniqueness, selection, or pruning policy. (§6.2/§11)

---

## Section C — Assessment

### What's now sound
- Lease claims with `owner=run:seq`, epoch, continuous reap, portable CAS via `insertIgnore` — the right design.
- Promoted columns + edge tables cleanly kill the JSON-operator contradiction.
- Daemon-as-single-writer + `counters`-based `events.seq` + bounded blocking event queue — correct.
- Delta-lint kept line-oriented; parity defined as golden corpus + documented deviations — honest and achievable.
- §13.1/§13.3 split with adapter data sources — correct shape for member_check/extc.
- Per-model pacing keyed by directory name + daemon-wide semaphore — right.
- §16 security checklist (localhost default, tokens on *all* endpoints incl. WS, per-token caps, audit, no API-authored pipelines) — the right list.
- Build lock excluding witness/SMT with run30 cited — the lesson is correctly encoded.
- M0 fixture adapter and an honest M2.5 diff-engine milestone — good de-risking.
- Certificate removal is surgical; §9's reduced witness-evidence scope is coherent.

### Top fixes before any code
1. **B-C1** — resolve daemon-mandatory vs daemon-in-M4 (embedded daemon for M0–M3, or pull `serve` forward). Four milestones are unacceptable as written.
2. **B-H1 + B-H2** — actually specify the worker protocol (framing, timeout, kill/respawn, pool, lock-wrapping) and make the witness a worker-backed `Promise<Verdict>`, not `string[]`.
3. **B-H5/B-H4** — give batches a state model (worker↔items relation) and define sub-pipeline ingress/terminal/cycle semantics for `onReject`.
4. **B-H3** — give tokens/policies/global-cap a storage home.
5. **Milestone order** — M1b after M2 (H10 residue), and move the store-dependent `match.*` rules out of M1a (B-M9).

Verdict: rev 2 fixed the majority of round 1 (≈30 of 36 findings fully fixed) and the certificate excision is clean — but it traded the round-1 CRITICALs for a new architectural contradiction (B-C1) and left the revision's two flagship additions — the worker protocol and the batch/routing pipeline model — specified at the level of vibes. Do not start M0 until B-C1, B-H1, B-H2, and B-H5 are resolved in the document.
