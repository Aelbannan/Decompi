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

-- Per-workflow manual/run completion (SPEC §5.1). Row forms:
--   (wf, U, '')  unit-scoped    -- every target of unit U is complete
--   (wf, '', T)  target-scoped  -- target T is complete
--   (wf, U, T)   precise        -- target T of unit U (run-time finalize)
CREATE TABLE workflow_completions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  unit_id TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL,
  actor TEXT NOT NULL,                 -- token id, "manual", or run_id
  reason TEXT,
  UNIQUE (workflow_id, unit_id, target_id)
);
CREATE INDEX idx_workflow_completions_workflow ON workflow_completions(workflow_id);
CREATE INDEX idx_workflow_completions_unit ON workflow_completions(unit_id);
CREATE INDEX idx_workflow_completions_target ON workflow_completions(target_id);
