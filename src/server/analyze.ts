/**
 * M4 introspection agent (SPEC §17): a read-only query surface over the
 * store + transcript artifacts, plus the driver that wires those tools into
 * an agent session.
 *
 * `AnalyzeTools` answers questions about what happened: `listRuns`/`getRun`
 * for run state, `getEvents`/`getSpans` for the observability substrate
 * (§18), `getMetrics` for derived counts, `getTranscript` to read a
 * worker's transcript artifact file when one exists. Exactly ONE method
 * mutates: `suggestChange` appends a row to the `proposals` table for a
 * human to accept — it never edits work state (no runs, items, claims,
 * events, or spans are ever written from here).
 *
 * `runAnalysis` is the driver: it renders the tools as function descriptions
 * into a system prompt and opens one session on the AgentRuntime (SPEC §11),
 * then runs the caller's prompt. For `MockAgentRuntime` the descriptions are
 * simply listed in the system prompt and one prompt is run; wiring the
 * descriptions into the real pi SDK as a tool-call loop (callbacks into
 * these methods) is M5. `AnalyzeTools` exposes `names()` and
 * `descriptions()` so the M5 wiring can hand the pi SDK the same table.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AgentRuntime } from "../agent/runtime.js";
import type { ModelSpec } from "../types.js";
import type { EventLevel, EventRow } from "../core/events.js";
import type { SqlAdapter } from "../core/store/adapter.js";
import type { Selector } from "../types.js";
import type { RunRecord } from "./scheduler.js";

/** Optional filter for {@link AnalyzeTools.listRuns} (SPEC §17 `{ filter }`). */
export interface RunFilter {
  /** One status, or several (queued|running|paused|done|failed|cancelled). */
  status?: string | string[];
  /** `runs.pipeline` equality. */
  pipeline?: string;
  /** `runs.model` equality. */
  model?: string;
}

/** Query for {@link AnalyzeTools.getEvents}; every field narrows the read. */
export interface EventQuery {
  /** Restrict to one run's events. */
  runId?: string;
  /** Restrict to one event type. */
  type?: string;
  /** Cursor: only events with `seq > after`. */
  after?: number;
  /** Cap the result; unbounded when omitted. */
  limit?: number;
}

/** A materialized `spans` row (SPEC §18), camelCase per §6.1. */
export interface SpanRecord {
  id: string;
  runId: string;
  parentId: string | null;
  name: string;
  startedAt: string;
  finishedAt: string | null;
  promptId: string | null;
  /** Parsed attrs JSON (model, tokens, cost, verdict…). */
  attrs: Record<string, unknown>;
}

/** Derived global counters (SPEC §18: "stats are derived on read"). */
export interface GlobalMetrics {
  scope: "global";
  totalRuns: number;
  activeRuns: number;
  doneRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  totalEvents: number;
  totalSpans: number;
  openProposals: number;
}

/** Derived per-run counters (SPEC §18). */
export interface RunMetrics {
  scope: string;
  runId: string;
  status: string;
  pipeline: string;
  model: string;
  startedAt: string | null;
  finishedAt: string | null;
  events: number;
  spans: number;
  workers: number;
  workItems: number;
  /** Cumulative audited spend for the run in integer micro-USD. */
  costMicroUsd: number;
}

/** The scope literal accepted by {@link AnalyzeTools.getMetrics} for global stats. */
export const GLOBAL_SCOPE = "global";

/** Model name the analyze driver opens sessions with by default (SPEC §11). */
export const DEFAULT_ANALYZE_MODEL = "analyze";

/**
 * Default model spec for the introspection agent's sessions on the
 * deterministic MockAgentRuntime (so `DEFAULT_ANALYZE_MODEL` resolves).
 * Cost/limits are informational — `runAnalysis` has no budget — but the
 * shape is the real `ModelSpec` contract.
 */
export const DEFAULT_ANALYZE_MODEL_SPEC: ModelSpec = {
  provider: "mock",
  model: "analyze",
  thinkingLevel: "medium",
  maxTokens: 0,
  rpm: 0,
  cost: { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 },
};

/** Default `proposals.author` for {@link AnalyzeTools.suggestChange}. */
export const ANALYZE_AUTHOR = "analyze";

/** One function description rendered into the agent system prompt (M5 wires these into the pi SDK). */
export interface ToolDescription {
  name: string;
  description: string;
}

/** The introspection agent's tool names, in prompt order (SPEC §17). */
export const ANALYZE_TOOL_NAMES: string[] = [
  "listRuns",
  "getRun",
  "getEvents",
  "getSpans",
  "getMetrics",
  "getTranscript",
  "suggestChange",
];

/** Human-readable descriptions of each tool's shape (SPEC §17). */
export const ANALYZE_TOOL_DESCRIPTIONS: readonly ToolDescription[] = [
  {
    name: "listRuns",
    description:
      "listRuns({status?, pipeline?, model?}): list runs; status is one string or an array of statuses.",
  },
  {
    name: "getRun",
    description: "getRun(id): fetch one run by id, or null when unknown.",
  },
  {
    name: "getEvents",
    description:
      "getEvents({runId?, type?, after?, limit?}): events ascending by seq, optionally filtered by run, type, or a seq cursor.",
  },
  {
    name: "getSpans",
    description:
      "getSpans(runId): timed sections of a run (session, verify round, build, agent turn) with attrs.",
  },
  {
    name: "getMetrics",
    description:
      "getMetrics('global' | runId): derived counts — global totals, or one run's events/spans/workers/items/cost.",
  },
  {
    name: "getTranscript",
    description:
      "getTranscript(runId, workerId): the worker's transcript text when an artifact exists, else null.",
  },
  {
    name: "suggestChange",
    description:
      "suggestChange(text, {runId?, author?}): append a proposal for a human to accept; returns the proposal id.",
  },
];

/** Raw snake_case `runs` row as stored (schema.sql §6.2). */
interface RunRow {
  id: string;
  pipeline: string;
  model: string;
  status: string;
  budget_micro_usd: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  selector: string;
}

/** Raw snake_case `spans` row as stored. */
interface SpanRow {
  id: string;
  run_id: string;
  parent_id: string | null;
  name: string;
  started_at: string;
  finished_at: string | null;
  prompt_id: string | null;
  attrs: string;
}

/** Raw snake_case `events` row as stored. */
interface EventRowRow {
  seq: number | bigint;
  ts: string;
  run_id: string | null;
  work_item_id: string | null;
  type: string;
  level: string | null;
  data: string;
}

/** Raw snake_case `artifacts` row as stored. */
interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  path: string;
  meta: string;
  created_at: string;
}

/** Parse a TEXT JSON payload; corrupt rows degrade to `{}` rather than throw. */
function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Map a raw `runs` row to a {@link RunRecord} (selector JSON parsed defensively). */
function rowToRunRecord(row: RunRow): RunRecord {
  let selector: Selector | null = null;
  try {
    const parsed: unknown = JSON.parse(row.selector);
    if (parsed !== null && typeof parsed === "object") {
      selector = parsed as Selector;
    }
  } catch {
    selector = null;
  }
  return {
    id: row.id,
    pipeline: row.pipeline,
    model: row.model,
    status: row.status as RunRecord["status"],
    budgetMicroUsd: row.budget_micro_usd,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    selector,
  };
}

/** Map a raw `spans` row to a {@link SpanRecord} with parsed attrs. */
function rowToSpanRecord(row: SpanRow): SpanRecord {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id,
    name: row.name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    promptId: row.prompt_id,
    attrs: parseJson(row.attrs),
  };
}

/** Map a raw `events` row to an {@link EventRow} (same shape as the EventStore). */
function rowToEventRow(row: EventRowRow): EventRow {
  return {
    seq: Number(row.seq),
    ts: row.ts,
    runId: row.run_id ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    type: row.type,
    level: (row.level ?? "info") as EventLevel,
    data: parseJson(row.data),
  };
}

/**
 * Read an artifact file to string. The `artifacts.path` is "repo-relative or
 * blob ref"; v1 resolves relative paths against the process CWD. Missing or
 * unreadable artifacts degrade to `null` ("no transcript") instead of
 * throwing — the agent tool must never fail the session over a stale path.
 */
async function readArtifactFile(path: string): Promise<string | null> {
  try {
    const resolved = isAbsolute(path) ? path : join(process.cwd(), path);
    return await readFile(resolved, "utf8");
  } catch {
    return null;
  }
}

/**
 * The introspection agent's tools (SPEC §17): read-only queries over the
 * store + transcript artifacts, plus the single append-only `suggestChange`.
 * Constructed over a `SqlAdapter` directly (the store is host-owned; this
 * class never writes anything except `proposals`).
 */
export class AnalyzeTools {
  constructor(private readonly adapter: SqlAdapter) {}

  /** The tool names exposed to an agent session, in prompt order. */
  names(): string[] {
    return [...ANALYZE_TOOL_NAMES];
  }

  /** The function descriptions for an agent session (M5 wires these into the pi SDK). */
  descriptions(): readonly ToolDescription[] {
    return ANALYZE_TOOL_DESCRIPTIONS;
  }

  /**
   * List runs, oldest first, optionally filtered by status (one or many),
   * pipeline, or model. Filter values are bound parameters — never string
   * interpolation — so they cannot inject SQL.
   */
  async listRuns(filter: RunFilter = {}): Promise<RunRecord[]> {
    if (filter.pipeline !== undefined && typeof filter.pipeline !== "string") {
      throw new TypeError("listRuns: filter.pipeline must be a string");
    }
    if (filter.model !== undefined && typeof filter.model !== "string") {
      throw new TypeError("listRuns: filter.model must be a string");
    }
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (!statuses.every((s) => typeof s === "string" && s.length > 0)) {
        throw new TypeError(
          "listRuns: filter.status must be a string or an array of strings",
        );
      }
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (filter.pipeline !== undefined) {
      where.push("pipeline = ?");
      params.push(filter.pipeline);
    }
    if (filter.model !== undefined) {
      where.push("model = ?");
      params.push(filter.model);
    }
    const sql =
      `SELECT id, pipeline, model, status, budget_micro_usd, created_at, ` +
      `started_at, finished_at, selector FROM runs` +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY created_at, id`;
    const rows = await this.adapter.query<RunRow>(sql, params);
    return rows.map(rowToRunRecord);
  }

  /** Fetch one run by id, or null when unknown. */
  async getRun(id: string): Promise<RunRecord | null> {
    const rows = await this.adapter.query<RunRow>(
      `SELECT id, pipeline, model, status, budget_micro_usd, created_at,
              started_at, finished_at, selector
       FROM runs WHERE id = ?`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : rowToRunRecord(row);
  }

  /**
   * Events ascending by `seq`, optionally filtered by run, type, and a seq
   * cursor (`after`: only events with `seq > after`), with an optional cap.
   */
  async getEvents(query: EventQuery = {}): Promise<EventRow[]> {
    if (query.runId !== undefined && typeof query.runId !== "string") {
      throw new TypeError("getEvents: runId must be a string");
    }
    if (query.type !== undefined && typeof query.type !== "string") {
      throw new TypeError("getEvents: type must be a string");
    }
    if (
      query.after !== undefined &&
      (!Number.isFinite(query.after) || query.after < 0)
    ) {
      throw new TypeError("getEvents: after must be a non-negative seq");
    }
    if (
      query.limit !== undefined &&
      (!Number.isInteger(query.limit) || query.limit < 1)
    ) {
      throw new TypeError("getEvents: limit must be a positive integer");
    }
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.runId !== undefined) {
      where.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.type !== undefined) {
      where.push("type = ?");
      params.push(query.type);
    }
    if (query.after !== undefined) {
      where.push("seq > ?");
      params.push(query.after);
    }
    let sql =
      "SELECT seq, ts, run_id, work_item_id, type, level, data FROM events";
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY seq ASC";
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }
    const rows = await this.adapter.query<EventRowRow>(sql, params);
    return rows.map(rowToEventRow);
  }

  /** Timed sections (sessions, verify rounds, builds, agent turns) of a run, oldest first. */
  async getSpans(runId: string): Promise<SpanRecord[]> {
    const rows = await this.adapter.query<SpanRow>(
      `SELECT id, run_id, parent_id, name, started_at, finished_at, prompt_id, attrs
       FROM spans WHERE run_id = ? ORDER BY started_at, id`,
      [runId],
    );
    return rows.map(rowToSpanRecord);
  }

  /**
   * Derived metrics (SPEC §18: derived on read). `"global"` returns store-wide
   * counters; a run id returns that run's counters (null when the run is
   * unknown).
   */
  async getMetrics(scope: string): Promise<GlobalMetrics | RunMetrics | null> {
    if (scope === GLOBAL_SCOPE) return this.globalMetrics();
    const run = await this.getRun(scope);
    if (run === null) return null;
    const [events, spans, workers, workItems, costRows] = await Promise.all([
      this.adapter.query<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM events WHERE run_id = ?",
        [scope],
      ),
      this.adapter.query<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM spans WHERE run_id = ?",
        [scope],
      ),
      this.adapter.query<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM run_workers WHERE run_id = ?",
        [scope],
      ),
      this.adapter.query<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM run_worker_items WHERE run_id = ?",
        [scope],
      ),
      this.adapter.query<{ s: number | bigint | null }>(
        "SELECT SUM(cost_micro_usd) AS s FROM audit_log WHERE run_id = ?",
        [scope],
      ),
    ]);
    return {
      scope,
      runId: scope,
      status: run.status,
      pipeline: run.pipeline,
      model: run.model,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      events: Number(events[0]?.n ?? 0),
      spans: Number(spans[0]?.n ?? 0),
      workers: Number(workers[0]?.n ?? 0),
      workItems: Number(workItems[0]?.n ?? 0),
      costMicroUsd: Number(costRows[0]?.s ?? 0),
    };
  }

  /** Store-wide derived counters (SPEC §18 rollup-free: derived on read). */
  private async globalMetrics(): Promise<GlobalMetrics> {
    const count = (sql: string, params: unknown[] = []): Promise<number> =>
      this.adapter
        .query<{ n: number | bigint }>(sql, params)
        .then((rows) => Number(rows[0]?.n ?? 0));
    const [
      totalRuns,
      activeRuns,
      doneRuns,
      failedRuns,
      cancelledRuns,
      totalEvents,
      totalSpans,
      openProposals,
    ] = await Promise.all([
      count("SELECT COUNT(*) AS n FROM runs"),
      count("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')"),
      count("SELECT COUNT(*) AS n FROM runs WHERE status = 'done'"),
      count("SELECT COUNT(*) AS n FROM runs WHERE status = 'failed'"),
      count("SELECT COUNT(*) AS n FROM runs WHERE status = 'cancelled'"),
      count("SELECT COUNT(*) AS n FROM events"),
      count("SELECT COUNT(*) AS n FROM spans"),
      count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'"),
    ]);
    return {
      scope: GLOBAL_SCOPE,
      totalRuns,
      activeRuns,
      doneRuns,
      failedRuns,
      cancelledRuns,
      totalEvents,
      totalSpans,
      openProposals,
    };
  }

  /**
   * The worker's transcript text when an artifact exists, else null. Finds
   * the `transcript` artifact for the run whose meta records `workerId`
   * (or the snake_case `worker_seq` alias), newest first, and reads its
   * `path` from disk. Missing artifacts or unreadable files degrade to
   * null — never a throw.
   */
  async getTranscript(runId: string, workerId: number): Promise<string | null> {
    const rows = await this.adapter.query<ArtifactRow>(
      `SELECT id, run_id, kind, path, meta, created_at FROM artifacts
       WHERE run_id = ? AND kind = 'transcript'
       ORDER BY created_at DESC, id DESC`,
      [runId],
    );
    for (const row of rows) {
      const meta = parseJson(row.meta);
      const stored = meta.workerId ?? meta.worker_seq;
      if (stored !== undefined && Number(stored) === workerId) {
        return readArtifactFile(row.path);
      }
    }
    return null;
  }

  /**
   * Append a proposal for a human to accept (SPEC §17: suggestions persist to
   * `proposals`). This is the introspection agent's ONE mutating call, and it
   * only appends a proposal row — it never edits runs, work items, claims,
   * events, spans, or any other work state. Returns the new proposal's id.
   */
  async suggestChange(
    text: string,
    opts: { runId?: string; author?: string } = {},
  ): Promise<string> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new TypeError("suggestChange: text must be a non-empty string");
    }
    const id = randomUUID();
    await this.adapter.execute(
      `INSERT INTO proposals (id, run_id, text, author, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [
        id,
        opts.runId ?? null,
        text,
        opts.author ?? ANALYZE_AUTHOR,
        new Date().toISOString(),
      ],
    );
    return id;
  }
}

/** Options for {@link runAnalysis}. */
export interface RunAnalysisOptions {
  /** Model name to open the session with; defaults to {@link DEFAULT_ANALYZE_MODEL}. */
  model?: string;
}

/**
 * Render the tool descriptions into the agent's system prompt (SPEC §17).
 * The prompt states the read-only contract — every tool is a read except
 * `suggestChange`, which appends a proposal — and lists each tool's shape.
 */
export function buildAnalyzeSystemPrompt(
  descriptions: readonly ToolDescription[] = ANALYZE_TOOL_DESCRIPTIONS,
): string {
  const lines = descriptions.map((d) => `- ${d.name}: ${d.description}`);
  return [
    "You are the Decompi introspection agent (SPEC §17): you analyze runs, events,",
    "spans, metrics, and transcripts to explain what happened and propose changes.",
    "All tools are READ-ONLY except suggestChange, which APPENDS a proposal row to",
    "the proposals table for a human to accept — it never edits work state.",
    "Available tools:",
    ...lines,
    "Answer the user's question using real data from these tools; cite what you",
    "observed rather than speculating.",
  ].join("\n");
}

/**
 * Driver: wire the tools as function descriptions into an agent session
 * (SPEC §11) and run one prompt, returning the final text. For
 * `MockAgentRuntime` the descriptions are listed in the system prompt and a
 * single prompt is run; the real pi SDK tool-call wiring is M5.
 */
export async function runAnalysis(
  runtime: AgentRuntime,
  tools: AnalyzeTools,
  prompt: string,
  opts: RunAnalysisOptions = {},
): Promise<string> {
  const session = await runtime.createSession({
    model: opts.model ?? DEFAULT_ANALYZE_MODEL,
    prompt: buildAnalyzeSystemPrompt(tools.descriptions()),
    tools: tools.names(),
  });
  const result = await session.prompt(prompt);
  return result.finalText;
}
