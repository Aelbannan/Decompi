# Decompi — Implementation Spec

A game-agnostic decomp-matching orchestration harness built on the pi SDK.
This document is the concrete implementation contract: interfaces, schema,
rule registry, CLI surface, and milestones. It supersedes the Xenoblade-only
`tools/pi_harness` (in-repo) and the Python coop tooling it shells out to.

> **rev 4** — incorporates adversarial review rounds 1–2
> (`docs/reviews/round1-consolidated.md`, `round2-consolidated.md`). Round-1
> fixes retained; certificate system removed (user decision: witness/SMT are
> fixed-spec). Round-2 fixes: daemon split into an M2 embedded store daemon +
> M4 control-plane daemon; worker protocol + `WorkerSpec` layering specified;
> `run_worker_items` junction (batched sessions); `onReject[]` routing;
> `auth_tokens` table; migration spec (§6.4); milestone reorder M1a→M2→M1b→M2.5.

---

## 1. Goals & non-goals

### Goals
- **Generic across games.** One installable package; each game ships an *adapter*.
- **No Python in the control plane.** Orchestration, linter, claims, status,
  selection, reporting, store, and UI are all TypeScript. The *diff engine* and
  the *equivalence witness* are external process dependencies (Xenoblade's are
  Python — `hexdiff.py` + `tools/ppc_equivalence` + z3) run as **persistent
  worker processes** (spawn once, serve many requests over a stdio/JSON
  protocol), so there is no per-call interpreter/import startup. They are
  invoked like `objdump`, never reimplemented.
- **One database.** A generic SQL adapter over a single logical database that
  holds *everything* (work items, claims, runs, events, telemetry).
  SQLite is the v1 engine; Postgres is a later drop-in behind the same interface.
- **Configurable pipelines.** New pipelines are `.ts` files composing step
  primitives (including batching and retry routing — see §10). No engine changes
  to add `fakematch-detect`, `tu-cleanup`, etc.
- **Dynamic targeting.** Declarative selectors resolve to work items at run time
  and can be re-evaluated mid-flow ("first 50 CODE_MATCH sorted by size").
- **Full observability + control.** A control-plane daemon owns run state; a web
  UI controls and inspects runs (transcripts, costs, verdicts, per-run/global
  stats); an introspection agent can analyze runs conversationally.
- **Model directory.** Models are named presets defined once (`models.json`);
  every run references a name.

### Non-goals (v1)
- Postgres *implementation* (interface exists; SQLite ships first).
- Cross-machine distributed claim coordination (see §6.3).
- Replacing the game's build system (ninja/configure) or cross toolchain.
- Containerising / sandboxing the agent (best-effort guardrails, not a sandbox).

---

## 2. Concepts (glossary)

| Term | Meaning |
|---|---|
| **WorkItem** | A unit of work: a function, object, or label to be matched/cleaned. Promoted queryable columns + a `meta` bag for the rest. |
| **Unit** | A grouping (translation unit / object file) that WorkItems belong to. |
| **Run** | One invocation of a pipeline against a selection, with its own model, concurrency, and budget. |
| **Pipeline** | A sequence of steps that may include batching (`foreach`/`batch`), retry routing (`onReject`), and event triggers. |
| **Step** | The smallest executable unit of a pipeline. |
| **Verifier** | A predicate that decides whether a WorkItem is accepted (diff/witness/behaviour); sets status + evidence. |
| **Selector** | Declarative filter/sort/limit over promoted columns, compiled to SQL. |
| **Adapter** | The per-game integration: build, diff engine, witness, lint rules, status vocab, placeholder patterns, style guide, data sources (symbols/asm/reloc). |
| **Claim** | A lease — ephemeral, heartbeat-refreshed write-scope ownership of a WorkItem by a worker. |
| **Event** | An append-only, typed record of what happened (the observability substrate). |
| **Span** | A timed section of work within a run. |
| **Model** | A named preset in `models.json` (provider + model + thinking + cost + limits). |
| **Style guide** | A Markdown file injected into agent prompts. |
| **Prompt** | A versioned, hashable artifact produced by the PromptBuilder. |
| **Worker process** | A long-lived child process (diff engine / witness) spawned once, serving many requests over stdio/JSON. |

---

## 3. Principles

1. **Adapter is the only game-specific seam.** Core has zero knowledge of MWCC,
   PPC, ELF, regions, or Xenoblade names. Diff/witness engines, symbol tables,
   and status vocab are adapter-provided.
2. **Portable SQL.** The store is written against a `SqlAdapter` interface; SQL
   uses `?` placeholders, ISO-8601 TEXT timestamps, TEXT-encoded JSON for
   *unindexed* blobs only, and no engine-specific extensions for queryable
   fields (which are real columns). `SqlAdapter` exposes portable primitives
   (`insertIgnore`, `isUniqueViolation`) so CAS claim works on both engines.
3. **Port the *actual* lessons, with traceability.** Each operational mechanism
   carried from v1 maps to a module and an incident it prevents (see table in
   §11). New mechanisms (budget caps, resume) are marked **new**, not "ported".
4. **State is append-only + derived.** `events` is the source of truth for "what
   happened"; `work_items` is the current view; stats are derived
   on read with rollups for hot paths.
5. **Configurable identifiers.** Placeholder-name patterns (`func_`, `fn_`,
   `unkN`, `Class_XXXX`) are adapter-required config, never hardcoded in core.

---

## 4. Repository layout

```
decompi/
  SPEC.md
  README.md
  package.json
  tsconfig.json
  models.example.json
  src/
    core/
      engine.ts           # run scheduler + lifecycle + trigger dispatch
      store/
        adapter.ts        # SqlAdapter interface (+ insertIgnore/isUniqueViolation)
        sqlite.ts         # SQLite engine (v1)
        postgres.ts       # Postgres engine (later)
        migrations.ts     # versioned migrations
        schema.sql        # canonical DDL
      events.ts           # typed event emission (daemon-owned seq) + cursor reads
      spans.ts            # span recorder
      worker.ts           # persistent worker-process protocol (spawn once, stdio/JSON)
      lock.ts             # build-lock ordering (flock outside SQLite txn)
    target/
      work-item.ts        # WorkItem type + repo
      selector.ts         # selector parse + SQL compile (promoted columns)
      claim.ts            # lease claim/release + heartbeat + reap
      lifecycle.ts        # canonical lifecycle transitions
    adapter/
      types.ts            # GameAdapter interface (data sources + worker engines)
      registry.ts         # adapter discovery (env → config → adapters/<id>/ → fail)
    verify/
      types.ts            # Verifier interface + Verdict (+ soft flags)
      driver.ts           # thin diff/witness/behaviour drivers (call adapter)
    pipeline/
      types.ts            # Step + Pipeline (foreach/batch/onReject/trigger)
      engine.ts           # step executor (per-item / per-batch dispatch)
      builtin/
        match.ts
        fakematch-detect.ts
        tu-cleanup.ts
        tu-header-prepass.ts
    agent/
      runtime.ts          # AgentRuntime interface (pi default, oh-my-pi optional)
      session.ts          # session wrapper
      retry.ts            # continuation / re-prompt policy
      ratelimit.ts        # per-model pacer + daemon-wide semaphore
      watchdog.ts         # silence watchdog
      banking.ts          # near-miss draft bank
    prompt/
      builder.ts          # PromptBuilder
      templates.ts        # template registry
      style-guide.ts      # MD loader/injector
    parse/
      cpp/
        tree.ts           # tree-sitter-cpp wrapper (whole-file rules)
        rules/            # smell, pointer, clone, vtable, fakematch, member-source
        delta.ts          # line-oriented delta-lint gate (added lines)
        registry.ts       # rule registry + adapter config merge
      asm/
        dtk.ts            # dtk .s parser + call-graph indexer + r3-provenance
        objscan.ts        # .o data-pointer scan
      symbols/
        table.ts          # symbols.txt loader + mangled-name parser
        reloc-map.ts      # reloc-map ingestion
    cli/
      index.ts            # arg dispatch
      run.ts select.ts status.ts diff.ts lint.ts claims.ts
      report.ts serve.ts analyze.ts export.ts models.ts
      recertify.ts sync.ts scan-source.ts
    server/
      daemon.ts           # control-plane daemon (owns store, single writer)
      api.ts              # REST + WebSocket (auth)
      analyze.ts          # introspection-agent endpoint
    observability/
      metrics.ts          # derived stats + rollups
      export.ts           # JSONL / OTLP export
      retention.ts        # prune / TTL
  adapters/
    xenoblade/            # reference adapter
      adapter.ts
      diff-engine.ts      # persistent worker wrapping hexdiff.py + ppc_equivalence
      witness.ts          # persistent worker wrapping renaming_witness (z3)
      lint-rules.ts
      style-guide.md
      placeholders.ts
      symbols.ts asm.ts   # data-source adapters
  pipelines/              # user-authored pipeline .ts files
  web/                    # UI (served by the daemon)
  tests/
```

---

## 5. Process & concurrency model

```
                         ┌────────────────────────────┐
   CLI (RPC) ───────────▶│        daemon             │
                         │  (single SQLite writer)   │
   web UI  ─────────────▶│  ┌──────────────────────┐ │
                         │  │   run scheduler      │ │
                         │  │  run₁ run₂ … runₙ    │ │   N concurrent runs
                         │  │   each: M agents     │ │   each with own model
                         │  └──────────────────────┘ │
                         │  ┌──────────────────────┐ │
                         │  │  worker pool         │ │   persistent diff/witness
                         │  │  (spawn once)        │ │   engines, warmed once
                         │  └──────────────────────┘ │
                         └────────────┬───────────────┘
                                      │ claims/events/telemetry
                                      ▼
                               SQLite (WAL) store
```

- **One daemon per checkout** owns the store as the single writer. "Several runs
  in parallel" are logical `Run` records the daemon schedules; each run has its
  own model name, concurrency (`maxParallelAgents`), and budget.
- **The daemon is mandatory and split in two.** Every CLI command is a thin RPC
  to a daemon; there is **no** standalone mode that opens the store directly (a
  second writer would break claim serialization, orphan recovery, and
  `events.seq`). **M2 ships an embedded store daemon** (claims + events +
  selectors + single writer, in-process, no REST/UI); **M4 adds the control-plane
  daemon** (REST/WS/UI/scheduling/security). M0–M3 run against the embedded
  store daemon in-process; CI starts a detached one via `decompi serve
  --detached`. The store daemon is an **embeddable library** hosted by the
  long-running run/CLI process (which also listens on the local socket for
  worker RPCs); concurrent *processes* require the detached daemon — never two
  embedded writers.
- **Agents are subprocesses**, not in-process — a pi/oh-my-pi crash must not
  take down the single writer. Workers reach the daemon's claim/event API over a
  local socket; hard-abort is SIGTERM→SIGKILL with a grace period.
- **Build-lock scope**: the daemon takes the repo-wide advisory flock (flock on
  `build/<region>/.hexdiff.lock`, never unlink) for **build + immediate
  post-build `.o` reads only**. The witness/SMT and any long external analysis
  run **outside** the lock — v1's run30 incident (a z3 simplify under the lock
  froze every agent ~30 min) must not recur.
- **Lock ordering**: the build flock is always acquired *outside* any SQLite
  write transaction; a SQLite transaction is never held while waiting on the
  flock (prevents AB-BA deadlock). Workers RPC the daemon for claim/release.

---

## 6. Storage

### 6.1 SqlAdapter interface

```ts
interface SqlAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T>;
  /** Insert, returning false on a unique/PK violation (portable CAS claim). */
  insertIgnore(sql: string, params?: unknown[]): Promise<boolean>;
  /** Classify a thrown error as a unique-violation (SQLite vs Postgres differ). */
  isUniqueViolation(err: unknown): boolean;
  migrate(migrations: Migration[]): Promise<void>;
}
interface Migration { version: number; up(sql: SqlAdapter): Promise<void>; }
```

Portability rules: `?` placeholders everywhere; timestamps as ISO-8601 TEXT;
ULID string ids generated in-app (no `AUTOINCREMENT`/`SERIAL`); queryable fields
are real columns (no JSON operators in queries); `meta` is TEXT-encoded JSON used
for genuinely unindexed blobs only, filtered in the app layer when a selector
references it.

### 6.2 Schema (canonical DDL — portable)

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- function | object | label | adapter vocab
  unit_id TEXT,
  lifecycle TEXT NOT NULL,            -- core-owned: pending|claimed|active|verified|accepted|rejected|revalidation_required|blocked|not_required
  status TEXT NOT NULL,               -- adapter status vocab (NOT_STARTED…FULL_MATCH)
  region TEXT,                        -- promoted (multi-region selection)
  symbol TEXT,                        -- promoted (queryable)
  address TEXT,                       -- promoted (queryable)
  milestone TEXT,
  required_level TEXT,
  size INTEGER,
  source TEXT,                        -- repo-relative source path
  attempts INTEGER NOT NULL DEFAULT 0,-- materialized (ledger-derived)
  exhausted INTEGER NOT NULL DEFAULT 0,-- materialized (1 = dead-end reached)
  ready INTEGER NOT NULL DEFAULT 0,   -- materialized (call-graph resolved)
  meta TEXT NOT NULL DEFAULT '{}',    -- JSON: unindexed blobs (callgraph arrays, notes…)
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_items_unit   ON work_items(unit_id);
CREATE INDEX idx_work_items_status ON work_items(status);
CREATE INDEX idx_work_items_lifecycle ON work_items(lifecycle);
CREATE INDEX idx_work_items_region ON work_items(region);
CREATE INDEX idx_work_items_kind   ON work_items(kind);
CREATE INDEX idx_work_items_size   ON work_items(size);
CREATE INDEX idx_work_items_ready  ON work_items(ready);
CREATE INDEX idx_work_items_symbol ON work_items(symbol);
CREATE INDEX idx_work_items_updated_at ON work_items(updated_at);

CREATE TABLE units (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  region TEXT,
  source_paths TEXT NOT NULL DEFAULT '[]', -- JSON array
  meta TEXT NOT NULL DEFAULT '{}'
);

-- Queryable graph edges (recertify --bottom-up, call-graph wave).
CREATE TABLE work_item_deps (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'depends_on', -- depends_on | calls | unresolved_calls | abi_helper
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX idx_deps_to ON work_item_deps(to_id);

CREATE TABLE work_item_capabilities (
  work_item_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (work_item_id, capability)
);

CREATE TABLE claims (
  work_item_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,                -- "<run_id>:<worker_seq>" — never a PID
  run_id TEXT,
  worker_seq INTEGER,
  allowed_paths TEXT NOT NULL DEFAULT '[]', -- JSON array
  epoch TEXT NOT NULL,                -- daemon start UUID (PID-reuse guard)
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,           -- lease expiry
  heartbeat_at TEXT NOT NULL,
  FOREIGN KEY(work_item_id) REFERENCES work_items(id),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE SET NULL
);
CREATE INDEX idx_claims_owner   ON claims(owner);
CREATE INDEX idx_claims_run     ON claims(run_id);
CREATE INDEX idx_claims_expires ON claims(expires_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,                -- model directory name
  selector TEXT NOT NULL DEFAULT '{}', -- JSON
  config TEXT NOT NULL DEFAULT '{}',   -- JSON overrides
  status TEXT NOT NULL,               -- queued|running|paused|done|failed|cancelled
  pause_requested INTEGER NOT NULL DEFAULT 0,  -- 1 = pause at next step boundary
  budget_micro_usd INTEGER,           -- integer, no float error
  env_snapshot TEXT NOT NULL DEFAULT '{}', -- JSON: git sha, dirty flag (reproducibility)
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE run_workers (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,               -- app-assigned per-run worker id (one session)
  step_index INTEGER NOT NULL DEFAULT 0,
  step_state TEXT NOT NULL DEFAULT '{}', -- JSON checkpoint (resume)
  status TEXT NOT NULL,               -- idle|active|done|failed
  model TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, seq)
);

-- Worker→items junction: a foreach/batch session owns N items (per-item state).
CREATE TABLE run_worker_items (
  run_id TEXT NOT NULL,
  worker_seq INTEGER NOT NULL,
  work_item_id TEXT NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT '{}',   -- JSON per-item checkpoint
  PRIMARY KEY (run_id, worker_seq, work_item_id)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY,            -- daemon-assigned (counters table), not app MAX+1
  ts TEXT NOT NULL,
  run_id TEXT,
  work_item_id TEXT,
  type TEXT NOT NULL,                 -- typed event name
  level TEXT NOT NULL DEFAULT 'info', -- debug|info|warn|error
  data TEXT NOT NULL DEFAULT '{}'     -- JSON payload
);
CREATE INDEX idx_events_run  ON events(run_id, ts);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_work ON events(work_item_id);

CREATE TABLE counters (              -- portable monotonic generators (events.seq)
  name TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);

CREATE TABLE spans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  prompt_id TEXT,                     -- link transcript span → prompt
  attrs TEXT NOT NULL DEFAULT '{}'    -- JSON: tokens, cost, model, verdict…
);
CREATE INDEX idx_spans_run ON spans(run_id);
CREATE INDEX idx_spans_prompt ON spans(prompt_id);

CREATE TABLE models (
  name TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL,       -- off|minimal|low|medium|high|xhigh
  max_tokens INTEGER NOT NULL DEFAULT 0,  -- 0 = model default/unlimited
  rpm INTEGER NOT NULL DEFAULT 0,
  cost TEXT NOT NULL DEFAULT '{}',    -- JSON {inputPerM,outputPerM,cacheReadPerM,cacheWritePerM}
  content_hash TEXT,                  -- hash-checked cache of models.json
  meta TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE auth_tokens (            -- bearer tokens for the control plane
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  spend_cap_micro_usd INTEGER,        -- NULL = inherit global cap
  pipeline_allowlist TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE style_guides (
  adapter TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,              -- UI/replay cache; the FILE is the source of truth
  PRIMARY KEY (adapter, path)
);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,                -- hash of inputs
  template TEXT NOT NULL,
  style_guide_hash TEXT,
  context_hash TEXT NOT NULL,
  rendered TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- transcript|snapshot|patch|draft
  path TEXT NOT NULL,                 -- repo-relative or blob ref
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);

CREATE TABLE drafts (                 -- near-miss bank (bankOnlyOnBetter)
  work_item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  divergence INTEGER NOT NULL,        -- structural/mismatch count
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_drafts_work ON drafts(work_item_id);

CREATE TABLE proposals (              -- introspection agent suggestions
  id TEXT PRIMARY KEY,
  run_id TEXT,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (              -- who started/stopped what, spend per token
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,                -- token id / user
  action TEXT NOT NULL,               -- run-create|cancel|config-edit|…
  run_id TEXT,
  cost_micro_usd INTEGER,
  data TEXT NOT NULL DEFAULT '{}'
);
```

### 6.3 Claims: leases, one store

- **Lease model.** A claim is a heartbeat-refreshed lease: `owner = "<run_id>:<worker_seq>"`
  (never a parsed PID — v1's PID-reuse and owner-format bugs are the reason).
  `epoch` is the daemon's start UUID so orphan recovery verifies *this* daemon
  generation owns the lease.
- **CAS claim** is `insertIgnore` on the PK (returns false if already held); a
  re-claim requires matching owner+epoch. Release sets the row gone; expiry and
  heartbeat are `expires_at`/`heartbeat_at`.
- **Reap continuously**, not just at daemon start: the daemon sweeps expired
  leases on a timer and on run cancel/pause/fail (claims are tied to `run_id` via
  FK, `ON DELETE SET NULL`).
- **Durable assignment / match state** (what you share across *people*) is not a
  claim. It lives in `work_items` and is **git-exported** as a canonical
  snapshot (round-tripping columns, deps, and capabilities — not just a flat
  work-item list).
- Claims are **never** committed to git (fixing v1's stale-claim-in-targets.json
  bug — 316 stale claims sit in the committed file today).

### 6.4 Migration (targets.json + ledger → SQLite)

- **Field map** (Xenoblade, `tools/coop/targets.json` → schema): `id`→`work_items.id`
  (preserved verbatim — the ledger, deps, and asm data reference these ids),
  `status`→`status`, `workflow_status`→`lifecycle` (DISCOVERY/QUEUED/CLAIMED/ACTIVE
  → `pending` — there is no migrated claim, so nothing may land `claimed`/`active`;
  BACKLOG/BLOCKED→`blocked`; ACCEPTED→`accepted`; REVALIDATION_REQUIRED→
  `revalidation_required`; NOT_REQUIRED→`not_required`), `region`→`region`,
  `symbol`→`symbol`, `address`→`address`, `milestone`→`milestone`,
  `required_level`→`required_level`, `size`→`size`, `source`→`source`,
  `unit`→`unit_id`, `kind`→`kind`, `depends_on`→`work_item_deps(kind=depends_on)`,
  `called_functions`→`work_item_deps(kind=calls)`, `capabilities`→`work_item_capabilities`,
  `instruction_match`/`equivalence_*`/notes→`meta`.
- **Mandatory id preservation**: target ids are the join key for deps, ledger
  attempt counts, and asm data; the importer must not re-generate them.
- **Claims are NOT migrated** — they are ephemeral. All items start
  `lifecycle=pending` (except `accepted`-status items → `accepted`).
- **Exhausted set**: ledger `batch-session-exhausted`/`target-skipped`/dead-end
  `batch-cycle` rows (≥ `exhaustionThreshold`) → `exhausted=1`, `attempts` =
  ledger session count.
- **Acceptance**: migrated DB reproduces `run.py targets status` and the
  exhausted set exactly; id-preservation verified by spot-checking dep edges.

---

## 7. Game adapter interface

```ts
interface GameAdapter {
  id: string;

  // registry + maintenance
  importWorkItems(): Promise<WorkItem[]>;
  scanSource?(ctx): Promise<WorkItem[]>;     // discover new func_* (targets scan-source)
  syncCalls?(ctx): Promise<void>;            // callgraph maintenance (sync-calls)
  syncSymbols?(ctx): Promise<void>;          // symbols.txt re-sync

  // build + diff (persistent worker behind a stdio/JSON protocol)
  buildUnit(ctx: AdapterCtx, unit: string): Promise<BuildResult>;
  diff(ctx: AdapterCtx, item: WorkItem): Promise<DiffResult>;
  unitReport(ctx: AdapterCtx, unit: string): Promise<UnitReport>; // objdiff report + torn-.o backoff

  // acceptance
  verify(ctx: AdapterCtx, item: WorkItem): Promise<Verdict>;       // sets status + evidence

  // worker engines (core owns spawn/lifecycle/pool — see §7.1)
  diffEngine?(): WorkerSpec;            // hexdiff worker (build+diff)
  witnessEngine?(): WorkerSpec;         // equivalence witness worker (Python+z3)

  // data sources for asm/symbol rules
  symbolTable?(ctx): Promise<SymbolTable>;   // symbols.txt (mangled names)
  retailAsmIndex?(ctx): Promise<AsmIndex>;   // dtk .s index
  relocMap?(ctx): Promise<RelocMap>;

  // lint / style
  lintRules(): LintRule[];
  placeholderPatterns(): PlaceholderPatterns;
  styleGuidePath(): string;
  statusVocab(): StatusVocab;

  // build lock
  buildLockPath(ctx: AdapterCtx): string;
}

/** All patterns are adapter-REQUIRED; core provides no misleading defaults. */
interface PlaceholderPatterns {
  function: string;   // e.g. "^func_[0-9A-Fa-f]{7,8}$" (Xenoblade) / "^fn_" (Last Story)
  class: string;
  unknown: string;    // un-anchored, matching lint.py's substring semantics (e.g. "UnkClass_|UnkStruct_|UnkVirtualFunc|unk[0-9A-Fa-f]+")
  label: string;
  data: string;
}

interface StatusVocab {
  accepted: string[];   // e.g. ["FULL_MATCH","EQUIVALENT_MATCH"]
  rejected: string[];   // e.g. ["NOT_BUILDABLE","NOT_FOUND"]
  pending: string[];
}
```

**Adapter discovery** (in order): `DECOMPI_ADAPTER` env → `decompi.config.json`
`adapter` field → presence of `adapters/<id>/adapter.ts` → fail with a clear
message. The adapter package shape is a default export implementing `GameAdapter`.

### 7.1 Worker protocol

```ts
interface WorkerSpec {
  command: string[]; protocol: "ndjson"; timeoutMs: number; poolSize?: number;
  env?: NodeJS.ProcessEnv;   // spawn env; REPLACES the environment when set
}
```

- **Framing**: NDJSON (one JSON object per line); envelope `{id, method, params}`
  with a matching `{id, result | error}` response (request-id correlation).
- **Concurrency**: one outstanding request per worker process; the pool queues
  requests. `poolSize` (adapter config) bounds parallel worker processes.
- **Failure**: per-request `timeoutMs` → kill the worker, respawn, retry-once;
  a wedged worker (z3 mid-SMT) is fenced by the timeout, not left to hang.
- **Lock discipline**: workers never touch the build flock. The daemon wraps
  **any build-performing RPC** (`buildUnit` **and** `diff`, which builds before
  diffing) with the flock (build + immediate post-build `.o` reads); only
  `witness`/SMT RPCs run lock-free.
- **M2.5 interim (build-lock story)**: until the M3/M4 daemon lands, the
  xenoblade adapter's `diff()` is `--no-build` and single-process — it diffs
  against objects that already exist and never invokes ninja, so it assumes
  **no concurrent build** is mutating those objects and holds no flock (the
  adapter only exposes the lock path, `buildLockPath()` →
  `build/<region>/.hexdiff.lock`). When the daemon wires the flock around
  build-performing RPCs (M3/M4), `diff()`'s eventual build step is wrapped
  there per the rule above.
- **Warmup**: workers are spawned at daemon start and serve many requests — no
  per-call interpreter/import startup.
- **Adapter handoff**: adapter engine methods (`buildUnit`/`diff`/`verify`) are
  sugar over `AdapterCtx.workers.call(spec, method, params)` — core owns the
  pool and hands it to the adapter via `AdapterCtx`.

---

## 8. WorkItem & Selector

```ts
interface WorkItem {
  id: string;
  kind: string;
  unitId?: string;
  lifecycle: string;                   // core-owned (see §6.2)
  status: string;                      // adapter vocab
  region?: string;  symbol?: string;  address?: string;
  milestone?: string; requiredLevel?: string;
  size?: number;
  source?: string;
  attempts: number; exhausted: boolean; ready: boolean;  // materialized
  meta: Record<string, unknown>;       // unindexed blobs only
}

interface Selector {
  filter?: {
    status?: string[]; lifecycle?: string[];
    kind?: string[]; unit?: string[]; region?: string[];
    symbol?: string;                   // promoted column
    address?: string;                  // promoted column
    milestone?: string[]; requiredLevel?: string[];
    ready?: boolean; exhausted?: boolean; attempts?: { min?: number; max?: number };
    size?: { min?: number; max?: number };
    meta?: { key: string; op: "eq"|"neq"|"in"|"contains"|"regex"; value: unknown }[]; // app-side post-filter
  };
  sort?: { by: "size"|"attempts"|"unit"|"region"|"updated_at"; dir: "asc"|"desc" }[]; // whitelisted
  limit?: number;
}
```

- Queryable fields are **promoted columns** and compile to SQL (`WHERE`/`ORDER BY`/
  `LIMIT` pushed down). `filter.meta` is an explicit **app-side post-filter**
  applied after SQL selection; when `filter.meta` and `limit` are combined, the
  engine **over-fetches** (`LIMIT × over-fetch factor`) then post-filters then
  truncates, so a matching item is never silently dropped below `limit`.
- Materialized columns (`attempts`, `exhausted`, `ready`, plus `lifecycle`) are
  maintained by the engine on status/claim/verify transitions **and on dep
  mutation** (`sync-calls`/`scan-source` recompute `ready`; the event log is the
  source of truth and `decompi recompute` re-derives them if they drift), so
  call-graph "wave" selection (`ready = 1`) and `greenfieldOnly`-style filters
  are SQL.
- Canonical lifecycle (core-owned, distinct from adapter `status`):
  `pending → claimed → active → verified → accepted | rejected`, with
  `revalidation_required` and `blocked` preserved for recertify / stuck targets.

---

## 9. Verifiers

```ts
interface Verifier<Ctx = unknown> {
  id: string;
  verify(item: WorkItem, ctx: Ctx): Promise<Verdict>;
}
interface Verdict {
  accepted: boolean;
  status?: string;
  evidence: Record<string, unknown>;
  flags?: string[];                    // soft signals (fakematch candidates) — NOT a reject
  feedback?: string;
}
```

- **diff** (`driver.ts` → `GameAdapter.diff`) — the persistent-worker diff engine
  (build → disassembly → instruction diff + reloc handling). Core only interprets
  `DiffResult`; the Xenoblade engine wraps `hexdiff.py` + `ppc_equivalence`.
- **witness** (`driver.ts` → `GameAdapter.witnessEngine()` via the worker pool)
  — external process dependency (Xenoblade: `renaming_witness.py` + z3).
  Fixed-spec: accepts/rejects (sets status = `EQUIVALENT_MATCH`/…); the
  acceptance pipeline stores minimal evidence (status + summary) in
  `work_items.meta`. No certificate chaining.
- **unitReport** (`GameAdapter.unitReport`) — objdiff report parse (code/data/fuzzy
  %) with the torn-`.o` backoff that v1 learned the hard way.
- **behaviour** — runs the adapter's behaviour tests.
- **fakematch-detect** — a *pipeline* that runs the fakematch rule family +
  natural-rewrite hexdiff test and emits **flags** (events/artifacts), never a
  hard `accepted:false`. A heuristic must not reject accepted work.

Acceptance order: `verify: diff → verify: witness` (byte-identity first, witness
for register-only divergence).

---

## 10. Pipeline engine

```ts
type Step =
  | { kind: "agent"; prompt: PromptSpec; tools?: string[]; model?: string; maxParallel?: number }
  | { kind: "shell"; run: (ctx: StepCtx) => Promise<string[]> }
  | { kind: "verify"; verifier: string }
  | { kind: "transform"; fn: (ctx: StepCtx) => Promise<void> }
  | { kind: "select"; selector: Selector; into: string }            // named binding for later `from`
  | { kind: "foreach"; from?: string; batch: number; key?: string;  // key: group by "unit"|"status"|… before batching
      steps: Step[]; onReject?: Route[] }                           // N items → one shared session/brief
  | { kind: "gate"; when: (ctx: StepCtx) => boolean | Promise<boolean> }; // false → skip remaining steps in current scope

interface Route {
  when?: { sizeBelow?: number; status?: string[]; attempts?: { min?: number; max?: number } }; // ordered predicate
  to: string;                           // sub-pipeline id (steps-only fragment; items enter `steps`, skip `plan`)
  model?: string;                       // harder/cheaper model per route (v1 singleton-vs-rebatch asymmetry)
  maxAttempts?: number;
}

interface Trigger {
  when: "unitComplete" | "runStart" | "runEnd" | string;
  to: string;                           // pipeline id (e.g. tu-final)
}

interface Pipeline {
  id: string;
  adapter: string;
  plan(ctx: PlanCtx): Promise<WorkItem[]>;
  steps: Step[];
  triggers?: Trigger[];
}
```

- **Per-item vs per-batch**: `foreach` runs its child `steps` once per group of
  `batch` items (one agent session, one shared prompt context — v1's `batchSize`).
  Bare `steps` outside a `foreach` run per-run. `select.into` binds a named
  selection that a later `foreach.from` consumes (dynamic targeting).
- **Retry routing**: `onReject: Route[]` evaluates `when` predicates in order and
  routes failed items to a steps-only sub-pipeline with its own model/attempt
  budget — this expresses v1's two-branch singleton (harder model) vs rebatch
  (cheaper model) routing. Route graphs must be acyclic (validated at load);
  after a route's `maxAttempts`, the item's lifecycle goes `rejected`/`blocked`.
- **Triggers**: `unitComplete → tu-final` fires on a post-verify sweep keyed by
  `unit_id`, deduped per (unit, pipeline) via a marker in `events` (exactly-once
  even when two workers finish a unit's last two items concurrently).

```ts
export default definePipeline({
  id: "fakematch-detect",
  adapter: "xenoblade",
  async plan(ctx) {
    return ctx.select({ filter: { status: ["FULL_MATCH", "EQUIVALENT_MATCH"] },
                        sort: [{ by: "size", dir: "asc" }], limit: 50 });
  },
  steps: [
    { kind: "verify", verifier: "diff" },
    { kind: "agent", prompt: { template: "cleanup" }, model: "nube-ds4-flash-low" },
  ],
});
```

Built-in pipelines: `match`, `fakematch-detect`, `tu-cleanup`, `tu-header-prepass`.

---

## 11. Agent execution

- **AgentRuntime abstraction**: `createSession`, `prompt`, `stream`, tool wiring,
  model resolution. `pi` is the default adapter; **oh-my-pi**
  (`@oh-my-pi/pi-coding-agent`) is optional — decided by A/B, not by this spec.
- **Per-run model**: `Run.model` is a `models.json` name; steps may override.
- **Per-run concurrency**: `maxParallelAgents` workers per run; the daemon bounds
  total concurrency across runs with a semaphore.
- **Per-model pacing, not one global pacer**: request pacing is keyed by
  model-directory name (a 20-rpm provider must not throttle a 1,000-rpm sibling
  run); a daemon-wide concurrency semaphore bounds cross-run parallelism.
- **Tools/allowlist**: the agent's write-tool allowlist is **intersected with the
  worker's current claim `allowed_paths` at call time** (v1 semantics).
- **Budget enforcement** (new): integer micro-USD; checked at step/round
  boundaries; a hard-abort path (SIGTERM→SIGKILL with a grace period) stops
  in-flight subprocess workers when exceeded.
- **Restart semantics** (new): on daemon start, runs left in `running` move to
  `paused`; resume re-claims under the current daemon epoch. `run_workers.
  step_index`/`step_state` + `run_worker_items.state` are the checkpoints.

**Operational lessons carried from v1** (each maps to a module and an incident):

| Mechanism | Module | Incident it prevents |
|---|---|---|
| per-model request pacing + round-start jitter | `ratelimit.ts` | run32's 38× 429 burst |
| in-session continuation (`timeoutRetries`/`rejectionRetries`) | `retry.ts` | model fixes its own compile/no-match failures |
| near-miss draft banking (`bankOnlyOnBetter`) | `banking.ts` | loss of compiling drafts on reject |
| stale-round early-stop | `retry.ts` | entrenchment on dead ends |
| silence watchdog (thinking-aware) | `watchdog.ts` | high-thinking models aborted mid-think |
| claim lease + epoch + continuous reap | `claim.ts` | stale claims (316 in committed targets.json) + PID reuse |
| witness/SMT outside build lock | `lock.ts` | run30's 30-min z3 freeze |
| objdiff torn-`.o` retry backoff | `verify/driver.ts` | lost acceptances (runs 3–4) |
| `execFile` stdout-on-nonzero-exit | `session.ts` | onVerify blindness |
| ledger append serialization (single writer) | `events.ts` | PIPE_BUF interleaving |

---

## 12. Prompt system

```ts
interface PromptSpec {
  template: string;  model?: string;
  styleGuide?: boolean;                 // default true
  context?: Record<string, unknown>;    // brief, prior draft, siblings, walls…
}
interface PromptBuilder { build(spec, adapter, ctx): Promise<Prompt>; }
interface Prompt {
  id: string;                           // hash(template, styleGuideHash, contextHash)
  rendered: string; styleGuideHash: string; contextHash: string;
}
```

- Templates in `src/prompt/templates.ts`; the adapter's style guide (Markdown)
  is loaded, hashed, injected.
- `style_guides` table is a UI/replay cache — the **file is the source of truth**;
  UI edits write the file and trigger a daemon reload (no drift).
- `spans.prompt_id` links each agent-turn span to its prompt for replay/audit.

---

## 13. Parsing & linting

Two distinct subsystems — a C++ CST (tree-sitter-cpp) for whole-file analysis,
and a line-oriented delta gate; plus asm/binary/symbol analysis that is **not**
C++ parsing.

**Why tree-sitter over clang**: tree-sitter-cpp (WASM) is error-tolerant — MWCC
decomp code (`#pragma`, `__declspec`, `asm`, Gekko intrinsics) does not parse
under clang — and needs no external compiler. Clang's only advantage is true type
resolution, which the data-driven rules already get from retail ASM + `symbols.txt`.
**Core ships tree-sitter-cpp only; an adapter may optionally provide a clang-backed
backend (the Xenoblade adapter does not). Clang is not a core dependency.**

### 13.1 Source CST rules (tree-sitter-cpp, whole-file) — M1a

**Smell scan** (replaces `tools/coop/smell_scan.py`):
`smell.extern_c` (total/lbl/nonlbl-decl/nonlbl-def/other), `smell.self_param`,
`smell.self_access`, `smell.void_ptr`, `smell.void_ptr_cast`, `smell.ptr_arith`,
`smell.deref_arith`, `smell.asm_code`, `smell.fake_stack`, `smell.rn_params`,
`smell.goto_count`, `smell.decomp_macro`, `smell.pragma`, `smell.asm_insn_shim`,
`smell.schedule_pragma`, `smell.init_side_effect`, `smell.if0`,
`smell.class_in_cpp`, `smell.struct_in_cpp`, `smell.fake_array_access`,
`smell.vtable_wrapper`.

**Pointer arithmetic** (replaces `tools/coop/detect_pointer_arithmetic.py`):
`ptr.cast_byte_offset_deref`, `ptr.cast_byte_ptr_arith`, `ptr.cast_int_arith`,
`ptr.subscript_on_cast`, `ptr.ptr_offset_deref`, `ptr.reinterpret_arith`.

**Clone/duplicate** (new): `clone.repeated_code`, `clone.duplicate_class`
(subtree-hash similarity).

**Matched-function smells** (replaces `tools/coop/detect_smells.py`, requires store
access for status filtering): `match.func_placeholder` (configurable `func_`/`fn_`),
`match.class_placeholder`, `match.void_ptr_params`.

**Fakematch indicators**: `lint.no_asm_insn_shim`, `smell.schedule_pragma`,
`lint.no_init_side_effect`, `smell.decomp_macro` + natural-rewrite hexdiff test.

### 13.2 Delta-lint gate (line-oriented) — M1a

The acceptance gate operates on **added lines only** (difflib-equivalent opcodes
in TS, computed explicitly), with cross-line state (`cast_pending`), comment
stripping, and C-vs-C++ branching. **This stays line/regex+state-machine oriented**
— a CST cannot "parse added lines in isolation." Rules (replaces
`tools/pi_harness/lint.py`): `non_sjis_char`, `extern_c_in_c`, `no_pragmas`,
`no_if0`, `no_section_attr`, `no_codegen_macros`, `no_binary_patching`,
`no_extern_c` (except `lbl_*`), `cpp_free_ctor`, `no_angle_include`, `no_asm`,
`no_volatile_fake_stack`, `no_asm_insn_shim`, `no_init_side_effect`,
`no_register_keyword`, `no_register_names`, `no_void_ptr`, `no_unk_name`
(configurable), `no_unk_generated` (configurable, **un-anchored** to match
`lint.py`'s `CActorParam_UnkStruct2` substring semantics), `no_offset_arithmetic`.

### 13.3 Binary/asm/symbol analysis — M1b (after the store milestone)

Not C++ CST rules; require adapter data sources (`symbolTable`, `retailAsmIndex`,
`relocMap`) and, for member-vs-free, retail `.o` scanning:

- **member-vs-free** (replaces `tools/coop/member_check.py`): `member.N1`
  (nonzero constant in r3), `member.N2` (callee never derefs r3), `member.N3`
  (max r3 offset ≥ class size), `member.P1` (symbol addr as .data pointer),
  `member.tier_b`, `member.tier_c`, plus `header_drift`, `fake_members`,
  `callee_params`, `vtable_hints`, and `integer_only`/`vtable_dispatch` verdicts.
- **extern "C" classification** (replaces `tools/coop/extc.py`): `extc.retail_exact`,
  `extc.retail_drift`, `extc.invented`, `extc.member_candidate`,
  `extc.jp_stale_address`, `extc.unparsed`, and the `extc plan` member-conversion
  command (MWCC mangling rename plan + call sites + ceremony checklist).

### 13.4 Output formats & parity

`--json` (stable schema), `--markdown` (report), `--delta` (added-lines gate),
deterministic ordering. **Parity is defined as golden-corpus comparison with a
documented deviation list** (CST rewrites are not count-identical to the regex
scanners), not "identical counts". The committed CI gate (`smell_report.py`:
freshness + per-TU regression vs base, RVL variant, `--completeness`) is
re-implemented as `decompi report --check` and is part of M1a/M5 acceptance.

---

## 14. Model directory (`models.json`)

```json
{
  "nube-ds4-flash-low": {
    "provider": "nube", "model": "ds4-flash", "thinkingLevel": "low",
    "maxTokens": 0, "rpm": 20,
    "cost": { "inputPerM": 0.5, "outputPerM": 1.5, "cacheReadPerM": 0.1, "cacheWritePerM": 1.5 }
  }
}
```

Cost lives with the model. `thinkingLevel` is validated against
`off|minimal|low|medium|high|xhigh`. `rpm` drives the per-model pacer. The file
is the source of truth; the `models` table is a hash-checked cache loaded at
daemon start and reloaded on config edit.

---

## 15. CLI

```
decompi run <pipeline> [--selector '…'] [--model name] [--parallel N] [--dry-run] [--budget $]
decompi select '<selector>' [--json]
decompi status [--unit U] [--selector '…']
decompi diff <unit> [--symbol S] [--all] [--list] [--brief] [--asm] [--relocs] [--no-build] [--json]   # hexdiff = alias
decompi lint <paths…> [--delta] [--json]
decompi claims [list|claim|release|reap] <id…>
decompi report [--run id] [--check] [--json]
decompi export [registry|work-items|events|spans] [--out path]   # registry = work-items + deps + capabilities
  decompi import <snapshot>                                     # restore a registry snapshot
decompi recertify [--bottom-up]
decompi sync [calls|symbols]
decompi scan-source
decompi recompute [--unit U]              # re-derive materialized columns from events/deps
decompi serve [--port P] [--detached]     # daemon + web UI
decompi analyze [--run id]                # introspection agent (REPL)
decompi models [list|validate]
decompi prune [--retention-days N]        # events/spans/artifacts TTL
```

Adapter-level maintenance commands (`recertify`, `sync`, `scan-source`,
`reloc-map`, `size`, `progress`, `ctx`, `triage`) are declared by the adapter and
surfaced by `decompi <command>` when present. A CLI-parity appendix maps every
current Python command to kept/replaced/deferred, and M5 covers the CI cutover.

---

## 16. Control plane & web UI (security)

The daemon (`serve`) owns the store and exposes REST (runs, work-items, events,
spans, transcripts, config, models) + WebSocket (live run streams).

Security model (the daemon mutates the repo, runs arbitrary builds, and spends
money):
- **Default bind `127.0.0.1`**; exposing beyond localhost is unsupported without a
  fronting reverse proxy (TLS termination there).
- **Bearer token required on ALL endpoints** (read endpoints included —
  transcripts contain copyrighted retail ASM), validated at WS upgrade too.
- **Per-token policy** (`auth_tokens` table): spend cap (micro-USD) and pipeline
  allowlist; the global daemon spend cap lives in `decompi.config.json`.
- **Audit**: every run create/cancel/config-edit is written to `audit_log`
  (actor, action, run, cost).
- **Global daemon spend cap** hard-stops new runs when exceeded.
- Pipelines are trusted, filesystem-authored code; they are **not** authorable via
  the API (the UI can start/cancel/pause named pipelines, not define them).

---

## 17. Introspection agent

An agent whose tools are read-only queries over the store + transcript artifacts:

```ts
tools = [
  listRuns({ filter }), getRun({ id }),
  getEvents({ runId, type, after }), getSpans({ runId }),
  getTranscript({ runId, workerId }), getMetrics({ runId | "global" }),
  suggestChange({ text })   // → proposals table; never mutates
];
```

Exposed as `decompi analyze` (CLI REPL) and a chat endpoint in the UI.
Suggestions are persisted to `proposals` for the human to accept.

---

## 18. Observability

- **Event write path**: agents emit events through an in-process channel to the
  daemon (or a local socket if subprocesses). The daemon assigns `events.seq` from
  the `counters` table inside a single batched-write transaction. A bounded queue
  with backpressure (block, never drop).
- **Spans** wrap timed sections (session, verify round, build, agent turn) with
  attrs (model, tokens, cache, cost, verdict, latency) + `prompt_id`.
- **Metrics** derived on read; hot global/per-run stats use rollup caches.
- **Retention**: `decompi prune --retention-days N` + WAL checkpoint cadence;
  artifacts/transcripts have a TTL policy.
- **Export**: events/spans as JSONL (and OTLP later) for external dashboards and
  shared-team rollups.

---

## 19. Milestones

| Milestone | Deliverable | Acceptance |
|---|---|---|
| **M0 scaffold** | repo, package, `SqlAdapter`+SQLite+migrations, CLI skeleton, **fixture adapter** (imports JSON/CSV) | `select`/`status` work against the fixture registry |
| **M1a parser (C++ CST + delta)** | tree-sitter wrapper + source CST rules + line-oriented delta gate + `report --check` + golden corpus | golden-corpus parity vs `lint.py`+`smell_scan.py`+`detect_pointer_arithmetic.py`+`detect_smells.py` (source-scan) with documented deviations; tree-sitter spike: parse all of src/kyoshin + libs/*, report error-node rate |
| **M2 store/selectors** | work-items + promoted columns + edge tables + lease claims + selectors + `export` + **embedded store daemon** (single writer, in-process, no REST/UI) | claims are cross-process safe (lease CAS); selector returns "first 50 CODE_MATCH by size" via SQL |
| **M1b asm/obj/symbol** | dtk `.s` parser, `.o` scan, symbols.txt + mangled-name parser, `member_check`+`extc` parity | parity vs `member_check.py` + `extc.py` on recorded cases (runs against the M2 store) |
| **M2.5 diff engine** | persistent-worker protocol + Xenoblade diff engine (hexdiff.py+ppc_equivalence worker) | JSON diff parity vs `hexdiff.py --json` on a golden unit set; no per-call Python startup |
| **M3 pipeline/agent** | step engine (foreach/onReject/trigger) + AgentRuntime + prompt builder + model dir + budget + resume + per-model pacing | `match` pipeline drives one TU end-to-end with batched sessions + singleton/rebatch routing |
| **M4 control plane** | control-plane daemon (REST/WS + web UI + scheduling + introspection agent + security/auth) | N concurrent runs, each own model, live dashboard; auth + audit + spend caps |
| **M5 adapter + cut-over** | full Xenoblade adapter (build/diff/witness/lint/maintenance) + migration (§6.4) + fakematch/cleanup/prepass | migrated DB reproduces `run.py targets status` + exhausted set; Xenoblade runs entirely on Decompi |

Ordering rationale: the C++ CST (M1a) is de-risked early because the corpus is
local and stable; asm/symbol analysis (M1b) waits for the store; the diff engine
(M2.5) is a distinct, honest milestone rather than an implied part of M3. M1a's
`match.*` rules (which need work-item status) read the M0 fixture store (or a
targets.json fallback), since the real store lands in M2.

---

## 20. Open questions / TBD

- **Postgres** — interface only; implement when a shared-server deployment is real.
- **oh-my-pi** — optional `AgentRuntime` adapter; A/B after M3.
- **Clang backend** — optional per-adapter, not core (see §13).
- **CI cutover** — which Python CI gates (`smell_report --check`, `docs_sync`,
  fixture-blob check) move to Decompi vs stay; resolved in M5's CLI-parity appendix.
