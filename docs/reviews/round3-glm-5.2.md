## Section A — Round-2 load-bearing findings

| # | Finding | Status |
|---|---|---|
| 1 | Daemon split (M2 embedded store daemon + M4 control-plane) — M0–M3 execution mode | **FIXED** (see nit in B3) |
| 2 | Worker protocol (§7.1) + `WorkerSpec` layering, `witnessCommand` dropped | **PARTIAL** (clean seam, but introduces the diff-lock contradiction in B1) |
| 3 | `run_worker_items` junction + `onReject: Route[]` + `gate`/`select.into`/`foreach.key` | **FIXED** |
| 4 | `auth_tokens` table + global cap in `decompi.config.json` (§16, §6.2) | **FIXED** |
| 5 | Migration §6.4 (field map, id preservation, claims-not-migrated, exhausted set) | **PARTIAL** (see B2) |
| 6 | Milestone reorder M1a→M2→M1b→M2.5 | **FIXED** |

## Section B — New findings (rev 4 content)

**B1 — MEDIUM. Build-lock seam contradicts itself (regression from the round-2 lock-wiring fix).**
- §9: `diff` (→ `GameAdapter.diff`) is "the persistent-worker diff engine (build → disassembly → instruction diff + reloc handling)." So **`diff` performs a build.**
- §5 + §7.1: "The daemon wraps `buildUnit` worker-RPCs with the flock… **`diff`/`witness` RPCs run lock-free**" and "workers never touch the build flock."
- These cannot both be true: the diff engine builds, so its build either (a) is wrapped by the daemon's flock — contradicting "diff runs lock-free" — or (b) is taken by the worker — contradicting "workers never touch the build flock." v1's hexdiff.py holds the lock internally; the spec forbids that. This is exactly the load-bearing concurrency seam (run30), so it must be coherent.
- *Fix (one line):* the daemon wraps **any build-performing RPC** (`buildUnit` *and* `diff`) with the flock; only `witness`/SMT runs lock-free. Or split `diff` into a locked `buildUnit` step + a lock-free disassembly step. Non-M0-blocking (diff is M2.5) but must be resolved before M2.5.

**B2 — MEDIUM-LOW. Migration `workflow_status→lifecycle` contradicts "all items start pending."**
- Field map: "DISCOVERY/QUEUED/CLAIMED/ACTIVE → mapped" (strongly implies CLAIMED→`claimed`, ACTIVE→`active`).
- Same section: "Claims are NOT migrated… All items start `lifecycle=pending` (except accepted-status items → `accepted`)."
- An item that was `ACTIVE`/`CLAIMED` in v1 has no migrated claim, so it must land `pending`, not `active`/`claimed` (else it's stuck "active" with no owner). The map should read `DISCOVERY/QUEUED/CLAIMED/ACTIVE → pending`. M5-level, non-M0-blocking.

**B3 — LOW. `decompi serve --detached` referenced for M0–M3 CI (§5) but `serve` is an M4 deliverable.**
Clarify that M2 ships a minimal detached store-daemon mode (no REST/UI/auth), or that M2's cross-process claim test exercises SQL-level `insertIgnore` CAS directly without a persistent writer. Not blocking — M2 acceptance ("claims cross-process safe (lease CAS)") is satisfiable via SQLite CAS alone.

**NITs (implementation-level, no spec action required to start M0):**
- Migration doesn't mention populating `ready`/`attempts` for non-exhausted items or running `recompute` post-import (implied but unstated).
- `buildUnit` is described as a "worker-RPC" in §7.1 but the worker method surface (buildUnit vs diff vs witness over NDJSON) is not enumerated; `WorkerSpec` only carries command/protocol/timeout/poolSize.
- `gate` "skip remaining steps in current scope" — "current scope" (foreach body vs top-level) is vague.
- `Route.to` references a "steps-only fragment" but fragment registration/discovery is unspecified.
- `WorkerSpec.poolSize` is described as both a field and "adapter config."
- "Every CLI command is a thin RPC to a daemon" is slightly at odds with "M0–M3 run against the embedded store daemon in-process"; intent is clear (same daemon module, in-process or detached), wording could be tightened.

## Section C — GATE

**DONE — safe to start M0.**

All six round-2 load-bearing fixes landed; four are fully correct, two are partial only in localized, non-architectural ways. The remaining findings are confined to M2.5 (B1) and M5 (B2) and are one-line surgical fixes, not architecture regressions requiring a full re-review round. M0 (scaffold + fixture adapter + `SqlAdapter`/SQLite/migrations + CLI skeleton) is unblocked and depends on none of them.

**One mandatory pre-M2.5 action** (not a round blocker, but track it): resolve B1 — the diff-engine build must be classified under the build flock, contradicting "diff RPCs run lock-free." Fix before implementing M2.5, since that seam is exactly where v1's run30 incident originated.
