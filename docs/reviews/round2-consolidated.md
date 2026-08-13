# Round 2 — Consolidated Adversarial Review (Decompi SPEC rev 3)

Reviewers: kimi-k3 and glm-5.2 (both `pi/openrouter`, high thinking). Raw:
`round2-kimi-k3.md`, `round2-glm-5.2.md`. **[converged]** = both found it
independently.

## Verdict on round 1

≈30 of 36 round-1 findings **FIXED**. Certificate removal verified **clean**
(surgical; §9's reduced witness-evidence scope is coherent). Remaining
round-1 residues: H5/H7/H10/H14 partial, L13 (worsened → now the daemon
contradiction below), L15/L16.

## New findings (round 2)

### CRITICAL / HIGH — load-bearing, fix before any code

1. **[converged] Daemon-mandatory (§5) contradicts daemon-in-M4 (§19).**
   M2 ("claims cross-process safe"), M2.5, M3 ("drives one TU end-to-end") all
   precede M4 but require the single writer. → Split the daemon: **M2 embedded
   store daemon** (claims/events/selectors, no REST/UI) + **M4 control-plane
   daemon** (REST/WS/UI/scheduling/security). (kimi B-C1, glm N3)

2. **[converged] The persistent-worker protocol has no protocol, and the
   witness seam contradicts itself.** `witnessCommand?: string[]` (per-call
   spawn) vs "persistent worker" everywhere else; `worker.ts` in core but the
   adapter gives core no WorkerSpec to spawn. No framing/correlation/timeout/
   kill-respawn/pool-size/lock-wrapping. → `GameAdapter` exposes
   `diffEngine()/witnessEngine(): WorkerSpec` (command + protocol); core
   `worker.ts` owns spawn/pool/lifecycle; NDJSON `{id,method,params}`; one
   outstanding request per worker + queue; per-request timeout → kill+respawn
   +retry-once. (kimi B-H1/B-H2, glm N2)

3. **[converged] `run_workers.work_item_id` is singular but `foreach` batches N
   items per session.** → add `run_worker_items(run_id, worker_seq,
   work_item_id, step_index, state)` junction; `run_workers` = worker-level
   state only. (kimi B-H5, glm N1)

4. **[converged] `onReject: Route` (single) can't express the singleton-vs-
   rebatch two-branch asymmetry.** → `onReject: Route[]` with ordered `when`
   predicates (size/model/attempts), or `{singleton, rebatch}`. (kimi B-H4, glm N4)

5. **[converged] Auth tokens + per-token caps + global cap have no storage.**
   → add `auth_tokens(id, secret_hash, spend_cap_micro_usd, pipeline_allowlist,
   created_at, revoked_at)`; global cap in `decompi.config.json`. (kimi B-H3, glm N11)

6. **[converged] Migration is milestone'd but not specified.** No field map, no
   id-preservation requirement, no "claims are NOT migrated" (would faithfully
   import 316 stale leases). → new §6.4 Migration: field map, mandatory id
   preservation, claims excluded (all items start `lifecycle=pending`),
   exhausted-set + workflow_status→lifecycle import. (kimi H7, glm N12)

7. **[converged] Worker process model undecided (in-process vs subprocess).**
   Drives crash isolation, budget-abort mechanics, claim RPC, event-loop
   blocking. → subprocess workers (crash isolation — a pi/oh-my-pi crash must
   not kill the single writer); daemon exposes in-process claim/event API over
   local socket; hard-abort = SIGTERM→SIGKILL with grace. (kimi B-H1, glm N8)

8. **[converged] Milestone order: M1b listed before M2 but acceptance says
   "after store exists".** → reorder M1a → M2 → M1b → M2.5. (kimi H10, glm N6)

### MEDIUM / LOW (apply during implementation, note in spec)

- **meta × LIMIT** — post-filter can return < limit rows; over-fetch or reject
  meta+limit; document. (kimi B-M4, glm N9)
- **`ready` materialization trigger wrong** — recompute on `sync-calls`/dep
  mutation, not verify; add `decompi recompute`. (kimi —, glm N10/H14)
- **unitComplete trigger** — define post-verify sweep + exactly-once (dedupe on
  restart). (kimi B-M1, glm N5)
- **Expired-lease steal + lease params** — atomic steal-on-expired; default TTL/
  heartbeat numbers. (kimi B-M2)
- **epoch vs restart resume** — on daemon start, `running` runs → `paused`;
  resume re-claims under new epoch. (kimi B-M3)
- **`sort.by` whitelist + `updated_at` index + drop meaningless `by:"status"`**
  (kimi B-M5/L15, glm L15)
- **Build-lock ↔ worker wiring** — daemon wraps `buildUnit` RPCs with the flock;
  workers never touch the lock. (kimi B-M6)
- **git-export vs `export` CLI** — `export registry` (work-items+deps+caps) +
  import. (kimi B-M7, glm N13)
- **`allowed_paths` derivation** — `adapter.claimScope(item)` at claim time.
  (kimi B-M8, glm L4/H2)
- **`match.*` rules need the store** — move to M2+ or targets.json fallback.
  (kimi B-M9)
- **`pause_requested` state** — distinct from `running`/`paused`. (glm N7)
- **FKs on edge/junction tables** (glm N14); **`counters` RETURNING/batch-range
  SQL** (glm N15); **`gate` skip semantics + `select.into`/`foreach.key`/`batch`
  size** (glm N16/N18/N19/N20, kimi B-L8); **pipeline load/version errors**
  (kimi B-L13); **`dedupe`/`import-symbols`/`audit-promotion` in CLI-parity
  appendix** (kimi B-L14, glm H3); **drafts `bankOnlyOnBetter` policy** (kimi
  B-L15); **models `content_hash` + `max_tokens=0` convention** (kimi B-L5, glm
  N17); **`address` selector filter** (kimi B-L6); **lifecycle `not_required`
  consistency** (kimi B-L3); **title rev number** (kimi B-L1), **§6.1 cross-ref
  typo** (kimi B-L2), **budget boundary-vs-abort contradiction** (kimi B-L4).

## Sound (both)

Lease claims (owner=run:seq + epoch + continuous reap) · promoted columns +
edge tables · daemon single-writer + `counters` seq + bounded event queue ·
delta-lint kept line-oriented · §13.1/§13.3 split + adapter data sources ·
per-model pacing + semaphore · security checklist · build-lock-excludes-witness
· M0 fixture adapter + honest M2.5 · lessons→incident traceability table ·
cert removal clean.

## Do before M0

1. Daemon split (M2 store-daemon / M4 control-plane).
2. Worker protocol spec + WorkerSpec layering (drop `witnessCommand`).
3. `run_worker_items` junction + finish pipeline model (`onReject[]`, `gate`,
   `select.into`, `foreach.key`).
4. `auth_tokens` table + global-cap location.
5. Migration spec (§6.4): field map, id preservation, claims excluded.
