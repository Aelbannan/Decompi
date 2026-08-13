# Round 3 — Gate Decision

Reviewers: kimi-k3 and glm-5.2 (both `pi/openrouter`, high). Raw:
`round3-kimi-k3.md`, `round3-glm-5.2.md`.

## GATE: DONE — safe to start M0. **[converged, both reviewers]**

All six round-2 load-bearing fixes landed correctly. Remaining findings are
surgical one-line patches gateable by milestone, not architecture regressions —
**no further adversarial round required.**

## Final patches applied (post-round-3, rev 4.1)

1. **Diff-lock seam** (both): the daemon wraps **any build-performing RPC**
   (`buildUnit` **and** `diff`) with the build flock; only `witness`/SMT runs
   lock-free. (§7.1)
2. **Migration lifecycle** (both): `workflow_status` DISCOVERY/QUEUED/CLAIMED/
   ACTIVE → `pending` (nothing lands `claimed`/`active` — there's no migrated
   claim). (§6.4)
3. **Daemon hosting** (kimi B-1): store daemon = embeddable library hosted by the
   run/CLI process (which also serves the worker socket); concurrent processes
   require the detached daemon. (§5)
4. **Adapter↔pool handoff** (kimi B-4): adapter engine methods are sugar over
   `AdapterCtx.workers.call(spec, method, params)`. (§7.1)
5. **`match.*` store dependency** (kimi B-3): M1a's `match.*` rules read the M0
   fixture store (or targets.json fallback). (§19)

## Deferred to implementation (non-blocking, tracked)

- steal-on-expired lease + TTL/heartbeat defaults; `adapter.claimScope(item)`
  derivation; FKs on junction/edge tables; `Route.to` fragment registry/loading
  errors; `WorkerSpec` per-method timeout; `poolSize` config location; `gate`
  scope wording; `serve` double-duty (M2 store-daemon vs M4 control plane);
  `ready`/`attempts` populated via `recompute` post-import.

## Process summary

Round 1 → 6 CRITICAL / 14 HIGH / 11 MEDIUM / 17 LOW-NIT → spec rev 2.
Round 2 → ≈30/36 fixed; new load-bearing (daemon split, worker protocol, batch
state, auth storage, migration) → spec rev 4.
Round 3 → all load-bearing fixes verified; gate DONE; 5 surgical patches applied.

The spec is implementation-ready. Start M0 (scaffold + fixture adapter +
SqlAdapter/SQLite/migrations + CLI skeleton), which is unblocked and depends on
none of the deferred items.
