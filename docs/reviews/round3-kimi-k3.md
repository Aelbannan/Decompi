## Section A: Round-2 load-bearing fixes

1. **Daemon split (M2 embedded store / M4 control-plane)** — **PARTIAL.** The split itself landed (§5 ¶3, §19 M2 row), but "in-process, no REST/UI" contradicts the same section's "Workers reach the daemon's claim/event API over a local socket" — see B-1.
2. **Worker protocol §7.1 + WorkerSpec layering** — **FIXED.** `witnessCommand` gone; `diffEngine()/witnessEngine(): WorkerSpec`; NDJSON `{id,method,params}`; one-outstanding-request + queue; timeout→kill→respawn→retry-once; daemon wraps `buildUnit` RPCs with the flock; warmup at daemon start. Clean seam.
3. **`run_worker_items` junction + `onReject: Route[]` + gate/select.into/foreach.key** — **FIXED.** Junction table present with per-item state; `onReject: Route[]` with ordered `when` predicates, per-route `model`/`maxAttempts`, acyclic validation; `gate` scope semantics, `select.into`→`foreach.from` binding, `key` group-before-batch all stated.
4. **`auth_tokens` + global cap location** — **FIXED.** Table matches the round-2 prescription exactly; global cap explicitly in `decompi.config.json` (§16).
5. **Migration §6.4** — **PARTIAL.** Field map, id preservation, claims-not-migrated, exhausted set, acceptance all present — but it contradicts itself (B-2).
6. **Milestone reorder M1a→M2→M1b→M2.5** — **FIXED.** §19 order correct; M1b acceptance now explicitly "runs against the M2 store".

Round-2 medium/low sweep: meta×LIMIT over-fetch ✓, `ready` recompute on dep mutation + `decompi recompute` ✓, unitComplete exactly-once via events marker ✓, epoch/restart resume ✓, `sort.by` whitelist + `updated_at` index + `by:"status"` dropped ✓, lock↔worker wiring ✓, `export registry`/`import` ✓, `pause_requested` ✓, `address` filter ✓, `not_required` ✓, rev number ✓, models `content_hash`/`max_tokens=0` ✓. **Not applied** (all round-2 "low", now confirmed still open): steal-on-expired lease, `claimScope`/`allowed_paths` derivation, FKs on junction/edge tables, `match.*`-needs-store (see B-3).

## Section B: New findings (severity-ordered)

- **B-1 (MEDIUM) — Who hosts the embedded store daemon?** §5 says three incompatible things: (a) "every CLI command is a thin RPC to a daemon, **no** standalone mode opens the store directly," (b) the M2 store daemon is "**in-process**," (c) workers reach "the daemon's claim/event API over a **local socket**." If two concurrent CLI/run processes each embed the daemon in-process, you have two embedded "single writers" (SQLite's file lock makes it non-corrupting but not the claimed serialization, and `events.seq`/claim ownership semantics assume one daemon generation — whose `epoch` wins?). The coherent reading is: the store daemon is an embeddable library *hosted by the long-running run/CLI process*, which also listens on the local socket for worker RPCs; concurrent-process use requires the detached daemon. Say that in one sentence and (a)/(b)/(c) reconcile. Doesn't block M0; must be nailed before M2.
- **B-2 (MEDIUM-LOW) — §6.4 self-contradiction on lifecycle import.** The field map maps `workflow_status`→`lifecycle` (BACKLOG/BLOCKED→`blocked`, REVALIDATION_REQUIRED→`revalidation_required`, NOT_REQUIRED→`not_required`), then the claims bullet says "**All items** start `lifecycle=pending` (except `accepted`)". Both can't be true. Presumably: CLAIMED/ACTIVE/DISCOVERY/QUEUED→`pending`; BLOCKED/REVALIDATION_REQUIRED/NOT_REQUIRED/ACCEPTED preserved. One-sentence fix; blocks nothing until M5.
- **B-3 (MEDIUM-LOW) — `match.*` rules still in M1a but "require store access"; the store is M2.** §13.1 keeps matched-function smells + `detect_smells.py` parity in M1a's acceptance while §19 puts work-items/promoted-columns in M2. M0 *does* ship SqlAdapter+SQLite+migrations and a fixture adapter, so the escape hatch exists — but the spec never says M1a reads the M0 fixture store (or a targets.json fallback). State it, or move `match.*` to M2.
- **B-4 (LOW-MEDIUM) — Adapter↔pool seam handoff unspecified.** `GameAdapter` declares `buildUnit`/`diff`/`unitReport`/`verify` *and* `diffEngine()/witnessEngine(): WorkerSpec`, with core owning spawn/pool. But nothing says how an adapter method (or the verify driver) reaches the core-owned pool — presumably a pool handle on `AdapterCtx`, and §9's witness bullet implies the driver calls `witnessEngine()` directly, bypassing `adapter.verify`. Also `buildUnit` appears both as an adapter method and as a daemon-wrapped worker RPC — which is it? One sentence ("adapter engine methods are sugar over `ctx.workers.call(spec, method, params)`") closes it.
- **B-5 (LOW) — `Route.to` targets a "steps-only fragment" that has no definition site.** `Pipeline` requires `plan()`; fragments aren't declared anywhere (registry? `Pipeline` with optional plan? naming convention?). Also unstated whether a fragment may contain `foreach`/`gate`/`onReject` (nested routing depth).
- **B-6 (LOW) — `WorkerSpec.timeoutMs` is per-spec, but methods differ by 100×.** A diff-engine worker serves `buildUnit` (minutes, under flock) and `diff` (seconds) with one timeout. Allow per-method override or per-request timeout in the envelope.
- **B-7 (LOW) — No steal-on-expired in CAS claim.** `insertIgnore` fails while an expired-but-unswept row exists; between expiry and reaper tick the item is unclaimable. Either claim `WHERE expires_at < now` (atomic steal) or state reaper cadence bounds the window.
- **B-8 (LOW) — `allowed_paths` derivation still unspecified** (round-2 B-M8): no `claimScope(item)` on `GameAdapter`. Who populates the claims column?
- **B-9 (NIT) — FKs absent** on `work_item_deps`, `work_item_capabilities`, `run_worker_items` (round-2 N14 acknowledged, not applied).
- **B-10 (NIT) — `decompi serve` is double-duty**: M2 CI starts the embedded daemon via `serve --detached`, but §15 annotates `serve` as "daemon + web UI" (M4). Fine, just say `serve` grows the control plane at M4.

## Section C: GATE

**DONE — safe to start M0.**

No finding requires structural redesign; the load-bearing round-2 fixes are in and the new seams (worker protocol, junction table, Route[], migration, daemon split) are coherent at the architecture level. The two PARTIALs and B-1/B-2/B-3 are one-paragraph patches, gateable by milestone rather than by review round:

- **Before M2:** B-1 (daemon hosting sentence), B-4 (pool handle on AdapterCtx).
- **Before M1a:** B-3 (match.* reads M0 fixture store or targets.json fallback).
- **Before M5:** B-2 (§6.4 lifecycle wording).
- **During implementation:** B-5…B-10.

These are edits, not another adversarial round. Start M0.
