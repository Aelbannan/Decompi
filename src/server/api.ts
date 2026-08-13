/**
 * M4 control-plane API (SPEC §16, §18): a dependency-free `node:http`
 * server implementing the daemon's REST + WebSocket surface with
 * bearer-token auth, spend caps, and an audit trail.
 *
 * Security model (SPEC §16):
 * - Bearer token required on **every** endpoint — reads included (transcripts
 *   contain copyrighted retail ASM) — and validated at WS upgrade time too.
 *   Tokens are stored as `sha256(secret)` in `auth_tokens`; validation
 *   rejects unknown/revoked tokens. An exhausted per-token spend cap
 *   (`spend_cap_micro_usd`, NULL = inherit global) does NOT 401 reads —
 *   validate returns the identity plus an `exhausted` flag, and run-create
 *   gates on it (403). The token's `pipeline_allowlist` is surfaced the same
 *   way and enforced at run-create only.
 * - Default bind `127.0.0.1` ({@link DEFAULT_BIND_HOST}). `createApiServer`
 *   returns a plain `http.Server`; pass `opts.port` to listen immediately on
 *   `opts.host` (default 127.0.0.1), or call `.listen()` yourself.
 * - Global daemon spend cap (`opts.globalSpendCapMicroUsd`): `POST
 *   /api/runs` is refused (403) once cumulative audited spend (SUM of
 *   `audit_log.cost_micro_usd`) exceeds the cap, and a run created WITHOUT
 *   a budget is refused whenever the cap is configured (finite) — actual
 *   spend is folded into the ledger by the scheduler's completion audit row.
 * - Every mutating action (run create / pause / resume / cancel / analyze)
 *   writes an `audit_log` row (actor = token id, action, run_id, cost when
 *   known — the run's reserved `budgetMicroUsd` on create; the ACTUAL
 *   metered cost in the scheduler's `run-complete` row).
 *
 * Run lifecycle is delegated to the real M4 {@link RunScheduler}
 * (`./scheduler.ts`): `createRun` → `POST /api/runs`, `getRun`/`listRuns` →
 * the read endpoints, `pause`/`resume`/`cancel` → the action endpoints.
 * This file never touches the `runs` table directly except for the read-only
 * metrics counters (SPEC §6.2).
 *
 * Live events transport: a **hand-rolled RFC 6455 WebSocket upgrade** was
 * chosen over the Server-Sent Events fallback (SPEC §16: "WebSocket (live
 * run streams)"). The server performs the SHA-1 accept-key handshake and
 * speaks minimal frames (text / close / ping / pong) itself — no
 * dependency. `GET /ws/events` pushes each new `events` row as one text
 * message containing a JSON line (one event object + `\n`). The stream is a
 * read-model poll (SPEC §18: events derived on read): every
 * `pollIntervalMs` (default 1000ms) the connection re-reads the `events`
 * table for rows with `seq > lastSeen`. `?after=<seq>` seeds the cursor
 * (default: the max seq at connect, so only new events stream). Auth is
 * checked on the upgrade request *before* the 101 is written.
 *
 * Endpoint contract (all require `Authorization: Bearer <token>`):
 *   GET  /api/health            → { status }
 *   GET  /api/metrics           → { totalRuns, activeRuns, spendMicroUsd }
 *   GET  /api/runs              → { runs: RunRecord[] }
 *   POST /api/runs              → 201 { run }  (scheduler.createRun + cap check + audit)
 *   GET  /api/runs/:id          → { run } | 404
 *   POST /api/runs/:id/pause    → { run } | 404   (audit run-pause)
 *   POST /api/runs/:id/resume   → { run } | 404   (audit run-resume)
 *   POST /api/runs/:id/cancel   → { run } | 404   (audit run-cancel)
 *   GET  /api/work-items?selector=<json> → { workItems: WorkItem[] } (selector.ts select)
 *   GET  /api/events?runId=&after=&limit= → { events: EventRow[] }
 *   POST /api/workflows/:id/completions  → 201 { workflowId, unitId?, targetId?, completed }
 *                                  (body: { targetId?, unitId?, reason? }; auth + audit,
 *                                   delegating to the WorkflowCompletionStore — SPEC §5.4)
 *   DELETE /api/workflows/:id/completions → 200 { workflowId, unitId?, targetId?, removed }
 *                                  (body: { targetId?, unitId? }; auth + audit;
 *                                   neither given = clear ALL rows for the workflow)
 *   POST /api/analyze              → 200 { result }  (body: { prompt, runId?, model? };
 *                                  introspection agent, prompt bounded, audited)
 *   WS   /ws/events[?after=]    → JSON-line event stream (see above)
 *
 * Errors: `{ error: string }` with 400 (bad input), 401 (auth), 403 (spend
 * cap), 404 (unknown route/run), 413 (body too large), 500 (internal).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import type { AgentRuntime } from "../agent/runtime.js";
import { MockAgentRuntime } from "../agent/mock.js";
import type { SqlAdapter } from "../core/store/adapter.js";
import type { EventLevel, EventRow } from "../core/events.js";
import type { Selector } from "../types.js";
import { select, validateSelector } from "../target/selector.js";
import { rowToWorkItem } from "../target/work-item.js";
import {
  AnalyzeTools,
  DEFAULT_ANALYZE_MODEL,
  DEFAULT_ANALYZE_MODEL_SPEC,
  runAnalysis,
} from "./analyze.js";
import type { RunRecord, RunScheduler, RunSpec } from "./scheduler.js";
import { WorkflowCompletionStore } from "../workflow/completions.js";

export type { RunRecord, RunSpec } from "./scheduler.js";

/** Default bind host (SPEC §16: never expose beyond localhost without a proxy). */
export const DEFAULT_BIND_HOST = "127.0.0.1";
/** WS event poll cadence (SPEC §18 derived-on-read; default 1000ms). */
const DEFAULT_POLL_INTERVAL_MS = 1000;
/** Max event rows returned per REST read / WS poll. */
const DEFAULT_EVENT_LIMIT = 1000;
/** Hard ceiling for a single `limit` query param. */
const MAX_EVENT_LIMIT = 10_000;
/** Max request body bytes (1 MiB) — protects the in-process daemon. */
const DEFAULT_MAX_BODY_BYTES = 1 << 20;

/** RFC 6455 WebSocket handshake magic GUID. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Path serving the live event stream (WS upgrade). */
const WS_PATH = "/ws/events";

/** RFC 6455 opcodes this server speaks. */
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Max length of one client→server WS frame (RFC 6455 length fields are 64-bit). */
const DEFAULT_WS_MAX_FRAME_BYTES = 1 << 20; // 1 MiB
/** Server→client buffered-bytes cap: beyond this the stream is dropped. */
const DEFAULT_WS_MAX_BUFFERED_BYTES = 8 << 20; // 8 MiB
/** WS idle timeout: a client that sends nothing this long is dropped. */
const DEFAULT_WS_IDLE_TIMEOUT_MS = 60_000;
/** Max `prompt` chars for POST /api/analyze (bounded introspection, SPEC §17). */
const MAX_ANALYZE_PROMPT_CHARS = 32_000;

/** Resolved token identity (from `auth_tokens.id`). */
export interface TokenIdentity {
  id: string;
  /**
   * Per-token spend cap is exhausted: reads/actions still authenticate (a
   * 401 on reads would lock out the operator), but run-create is gated
   * (403) — see {@link ControlPlane.handleCreateRun}.
   */
  exhausted?: boolean;
  /**
   * Pipelines this token may create runs for (SPEC §16); empty = allow-all.
   * Enforced at run-create (403 when non-empty and `input.pipeline` is not
   * listed).
   */
  pipelineAllowlist?: string[];
}

/** sha256 hex digest of a bearer secret (the stored `secret_hash`). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `auth_tokens` row columns this module reads (SPEC §6.2). */
interface AuthTokenRow {
  id: string;
  spend_cap_micro_usd: number | null;
  pipeline_allowlist: string;
  revoked_at: string | null;
}

/**
 * Bearer-token validator over the `auth_tokens` table (SPEC §16).
 *
 * `validate` hashes the presented secret (`sha256`), looks the row up by
 * `secret_hash`, and rejects (returns `null`):
 * - unknown tokens (no row);
 * - revoked tokens (`revoked_at` set);
 * - tokens whose per-token spend cap is exhausted — cumulative audited
 *   spend for the actor (`audit_log.cost_micro_usd` SUM) exceeds
 *   `spend_cap_micro_usd`. `NULL` cap = inherit the global cap (no per-token
 *   check here; the global check happens at run-create in the API server).
 *
 * `spend(actor?)` reads the cumulative audited spend for one actor, or the
 * whole ledger when omitted (used for the per-token cap, the global
 * run-create cap, and `GET /api/metrics`).
 */
export class AuthTokenProvider {
  constructor(private readonly store: SqlAdapter) {}

  /** Provision a token row (SPEC §6.2); hand `secret` to the client. */
  async issue(
    id: string,
    secret: string,
    opts: { spendCapMicroUsd?: number; pipelineAllowlist?: string[] } = {},
  ): Promise<void> {
    await this.store.execute(
      `INSERT INTO auth_tokens
         (id, secret_hash, spend_cap_micro_usd, pipeline_allowlist, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [
        id,
        hashToken(secret),
        opts.spendCapMicroUsd ?? null,
        JSON.stringify(opts.pipelineAllowlist ?? []),
        new Date().toISOString(),
      ],
    );
  }

  async validate(token: string): Promise<TokenIdentity | null> {
    if (token.length === 0) return null;
    const rows = await this.store.query<AuthTokenRow>(
      "SELECT id, spend_cap_micro_usd, pipeline_allowlist, revoked_at FROM auth_tokens WHERE secret_hash = ?",
      [hashToken(token)],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (row.revoked_at !== null) return null;
    let allowlist: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.pipeline_allowlist);
      if (Array.isArray(parsed)) {
        allowlist = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      allowlist = []; // corrupt JSON degrades to allow-all
    }
    const cap = row.spend_cap_micro_usd;
    if (cap !== null && (await this.spend(row.id)) > cap) {
      // Exhausted: still return the identity (reads must work) with the flag
      // set so run-create can gate on it (SPEC §16 — caps measure spend and
      // gate creation, not observability).
      return { id: row.id, exhausted: true, pipelineAllowlist: allowlist };
    }
    return { id: row.id, pipelineAllowlist: allowlist };
  }

  /** Cumulative audited spend for `actor`, or the whole ledger when omitted. */
  async spend(actor?: string): Promise<number> {
    const rows = await this.store.query<{ s: number | bigint | null }>(
      actor === undefined
        ? "SELECT SUM(cost_micro_usd) AS s FROM audit_log"
        : "SELECT SUM(cost_micro_usd) AS s FROM audit_log WHERE actor = ?",
      actor === undefined ? [] : [actor],
    );
    const s = rows[0]?.s;
    return s === null || s === undefined ? 0 : Number(s);
  }
}

/** Input for `POST /api/runs` (maps to a {@link RunSpec} for the scheduler). */
export interface CreateRunInput {
  pipeline: string;
  model: string;
  selector?: Selector;
  /** Whole-run cap in integer micro-USD; undefined = unlimited. */
  budgetMicroUsd?: number;
  /** Explicit run scope (SPEC §6): target/unit id allowlists, AND-ed together. */
  scope?: { targetIds?: string[]; unitIds?: string[] };
}

/** Options for {@link createApiServer}. */
export interface ApiServerOptions {
  store: SqlAdapter;
  /** The real M4 run scheduler (`src/server/scheduler.ts`). */
  scheduler: RunScheduler;
  authTokens: AuthTokenProvider;
  /** Global daemon spend cap in micro-USD; run-create is refused (403) once
   * cumulative audited spend exceeds it. `Infinity` = unlimited (also: a
   * budgetless run-create is refused whenever this is FINITE — SPEC §16). */
  globalSpendCapMicroUsd: number;
  /** Bind host; defaults to {@link DEFAULT_BIND_HOST} (SPEC §16). */
  host?: string;
  /** When set, the server listens on `host` immediately; otherwise the
   * caller owns `.listen()`. */
  port?: number;
  /** WS event poll cadence in ms; defaults to 1000 (SPEC §18). */
  pollIntervalMs?: number;
  /** Max event rows per REST read / WS poll; defaults to 1000. */
  eventLimit?: number;
  /** Max request body bytes; defaults to 1 MiB. */
  maxBodyBytes?: number;
  /**
   * Workflow completion store for `POST`/`DELETE
   * /api/workflows/:id/completions` (SPEC §5.4). Defaults to one over
   * `store` — serve/tests only inject a custom instance to double the writer.
   */
  completions?: WorkflowCompletionStore;
  /** Agent runtime for `POST /api/analyze` (SPEC §17). Defaults to a
   * deterministic `MockAgentRuntime` with {@link DEFAULT_ANALYZE_MODEL}
   * registered.
   */
  runtime?: AgentRuntime;
  /** Max one client→server WS frame in bytes; defaults to 1 MiB. */
  wsMaxFrameBytes?: number;
  /** Server→client WS buffered-bytes cap (backpressure); defaults to 8 MiB. */
  wsMaxBufferedBytes?: number;
  /** WS idle timeout in ms (client must send something this often); 0 = off. */
  wsIdleTimeoutMs?: number;
}

/** Client-visible HTTP error carrying its status code. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch {
    res.destroy();
  }
}

/** Read the request body up to `maxBytes`; rejects with 413 when larger. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      if (err !== undefined) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(new ApiError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish();
    const onError = (err: Error): void => finish(err);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Extract the bearer secret from `Authorization: Bearer <token>`. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match === null ? null : match[1]!.trim();
}

/** Parse a non-negative integer seq query param; null → 0. */
function parseSeqParam(raw: string | null): number {
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, `invalid seq: ${raw}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new ApiError(400, `invalid seq: ${raw}`);
  return n;
}

/** Parse `POST /api/runs` body into a validated {@link CreateRunInput}. */
function parseCreateRunInput(body: unknown): CreateRunInput {
  if (!isPlainObject(body)) throw new ApiError(400, "body must be a JSON object");
  for (const field of ["pipeline", "model"] as const) {
    const value = body[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new ApiError(400, `'${field}' must be a non-empty string`);
    }
  }
  const input: CreateRunInput = {
    pipeline: body.pipeline as string,
    model: body.model as string,
  };
  if (body.selector !== undefined) {
    if (!isPlainObject(body.selector)) {
      throw new ApiError(400, "'selector' must be a JSON object");
    }
    try {
      input.selector = validateSelector(body.selector);
    } catch (err) {
      throw new ApiError(
        400,
        `invalid selector: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (body.budgetMicroUsd !== undefined) {
    const budget = body.budgetMicroUsd;
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
      throw new ApiError(400, "'budgetMicroUsd' must be a non-negative integer");
    }
    input.budgetMicroUsd = budget;
  }
  if (body.scope !== undefined) {
    if (!isPlainObject(body.scope)) {
      throw new ApiError(400, "'scope' must be a JSON object");
    }
    const scope = body.scope;
    const parsedScope: { targetIds?: string[]; unitIds?: string[] } = {};
    for (const key of ["targetIds", "unitIds"] as const) {
      const value = scope[key];
      if (value !== undefined) {
        if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
          throw new ApiError(400, `'scope.${key}' must be an array of strings`);
        }
        parsedScope[key] = value;
      }
    }
    input.scope = parsedScope;
  }
  return input;
}

interface EventRowRaw {
  seq: number | bigint;
  ts: string;
  run_id: string | null;
  work_item_id: string | null;
  type: string;
  level: string | null;
  data: string;
}

/** Parse the TEXT JSON payload; corrupt rows degrade to {} rather than throw. */
function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read `events` rows with `seq > after` (optionally for one run), ascending,
 * capped at `limit`. Shape matches {@link EventRow} so the API and the
 * daemon's read model agree.
 */
async function readEvents(
  adapter: SqlAdapter,
  opts: { runId?: string; after: number; limit: number },
): Promise<EventRow[]> {
  const where = ["seq > ?"];
  const params: unknown[] = [opts.after];
  if (opts.runId !== undefined) {
    where.push("run_id = ?");
    params.push(opts.runId);
  }
  const rows = await adapter.query<EventRowRaw>(
    `SELECT seq, ts, run_id, work_item_id, type, level, data FROM events WHERE ${where.join(
      " AND ",
    )} ORDER BY seq ASC LIMIT ?`,
    [...params, opts.limit],
  );
  return rows.map((row) => ({
    seq: Number(row.seq),
    ts: row.ts,
    runId: row.run_id ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    type: row.type,
    level: (row.level ?? "info") as EventLevel,
    data: parseData(row.data),
  }));
}

// ---------------------------------------------------------------------------
// WebSocket (RFC 6455) — hand-rolled, no dependency
// ---------------------------------------------------------------------------

/** Server frame: FIN + opcode + (possibly extended) length, unmasked. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

interface WsFrame {
  opcode: number;
  payload: Buffer;
}

interface WsParseResult {
  frame: WsFrame | null;
  consumed: number;
  /** True when the declared length exceeds `maxBytes` (protocol error). */
  tooLarge?: boolean;
}

/**
 * Try to parse exactly one frame off the front of `buf`. Returns
 * `{ frame: null, consumed: 0 }` when more bytes are needed. Handles client
 * masking (required by RFC 6455 for client frames — close/ping from the
 * client are the only ones we expect). A frame whose declared length exceeds
 * `maxBytes` is reported via `tooLarge` (never allocated — the 64-bit length
 * field must not be trusted to bound an allocation).
 */
function parseWsFrame(
  buf: Buffer,
  maxBytes: number,
): WsParseResult {
  if (buf.length < 2) return { frame: null, consumed: 0 };
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return { frame: null, consumed: 0 };
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return { frame: null, consumed: 0 };
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(maxBytes)) return { frame: null, consumed: 0, tooLarge: true };
    len = Number(big);
    offset = 10;
  }
  if (len > maxBytes) return { frame: null, consumed: 0, tooLarge: true };
  let maskKey: Buffer | null = null;
  if (masked) {
    if (buf.length < offset + 4) return { frame: null, consumed: 0 };
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return { frame: null, consumed: 0 };
  const payload = Buffer.alloc(len);
  buf.copy(payload, 0, offset, offset + len);
  if (maskKey !== null) {
    for (let i = 0; i < payload.length; i++) {
      payload[i]! ^= maskKey[i % 4]!;
    }
  }
  return { frame: { opcode, payload }, consumed: offset + len };
}

/** Write a plain-text rejection to a socket that asked for an upgrade. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const text = {
    400: "Bad Request",
    401: "Unauthorized",
    404: "Not Found",
    500: "Internal Server Error",
  }[status] ?? "Error";
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}`,
    );
  }
  socket.end();
}

/** A WS close frame payload: 2-byte status code + optional reason text. */
function closePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

/**
 * One live event stream: holds the `?after=` cursor, polls the `events`
 * table every `pollIntervalMs`, and writes each new row as one JSON-line
 * text frame. Replies to client pings with pongs and echoes close frames.
 *
 * M4 hardening: the poll has a re-entrancy guard (a slow store read never
 * overlaps the next tick), writes honor the socket's backpressure (the
 * stream is dropped with a close-frame sentinel once the buffered bytes
 * exceed `maxBufferedBytes` instead of buffering without bound), client
 * frames are capped at `maxFrameBytes` (the 64-bit length field is never
 * trusted to bound an allocation), and a client that sends nothing for
 * `idleTimeoutMs` is dropped.
 */
class WsStream {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private lastSeq: number;
  private closed = false;
  private polling = false; // re-entrancy guard
  private readonly pollTimer: NodeJS.Timeout;
  private readonly idleTimer: NodeJS.Timeout;
  /** Force-destroy backstop armed by terminate() in case the peer never drains. */
  private forceDestroyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: SqlAdapter,
    private readonly pollIntervalMs: number,
    private readonly eventLimit: number,
    private readonly socket: Duplex,
    after: number,
    private readonly maxFrameBytes: number,
    private readonly maxBufferedBytes: number,
    private readonly idleTimeoutMs: number,
  ) {
    this.lastSeq = after;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
    // Idle timeout: a client that sends nothing (not even a ping) this long
    // is dropped. Any client traffic resets it. `0` = disabled.
    this.idleTimer =
      this.idleTimeoutMs > 0
        ? setTimeout(() => {
            this.terminate("idle timeout");
          }, this.idleTimeoutMs)
        : setTimeout(() => undefined, 0); // armed-and-unref'd no-op
    this.idleTimer.unref();
    socket.on("data", (chunk) => this.onData(chunk as Buffer));
    socket.on("close", () => this.close());
    socket.on("error", () => this.close());
  }

  private async poll(): Promise<void> {
    // Re-entrancy guard: a slow store read must not overlap the next poll
    // tick (each poll is bounded by `eventLimit`, so a missed tick is fine).
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const events = await readEvents(this.store, {
        after: this.lastSeq,
        limit: this.eventLimit,
      });
      for (const event of events) {
        if (this.closed || !this.socket.writable) return;
        const frame = encodeFrame(
          OP_TEXT,
          Buffer.from(`${JSON.stringify(event)}\n`, "utf8"),
        );
        // Backpressure: once the client's buffered-but-unflushed output
        // exceeds the high-water mark, drop-with-sentinel instead of growing
        // the write buffer without bound (SPEC §18 never-dropped applies to
        // the STORE's event queue, not a stuck socket).
        if (this.socket.writableLength + frame.length > this.maxBufferedBytes) {
          this.terminate("client too slow (buffered output overflow)");
          return;
        }
        this.socket.write(frame);
        this.lastSeq = event.seq;
      }
    } catch {
      // Transient store error (e.g. mid-migration): keep the stream alive and
      // retry on the next poll rather than dropping the client.
    } finally {
      this.polling = false;
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    // Any client traffic resets the idle timer.
    this.idleTimer.refresh();
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Bounded input: never let a slow client drip a frame body past the cap.
    if (this.buffer.length > this.maxFrameBytes + 16) {
      this.terminate("frame too large");
      return;
    }
    for (;;) {
      const { frame, consumed, tooLarge } = parseWsFrame(this.buffer, this.maxFrameBytes);
      if (tooLarge) {
        this.terminate("frame too large");
        return;
      }
      if (frame === null) break;
      this.buffer = this.buffer.subarray(consumed);
      if (frame.opcode === OP_CLOSE) {
        try {
          this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0)));
        } catch {
          // Socket already gone; nothing to reply to.
        }
        this.socket.end();
        return;
      }
      if (frame.opcode === OP_PING) {
        try {
          this.socket.write(encodeFrame(OP_PONG, frame.payload));
        } catch {
          // Socket already gone.
        }
      }
    }
  }

  /** Socket closed/errored underneath us: stop timers, release everything. */
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.idleTimer);
    if (this.forceDestroyTimer !== null) clearTimeout(this.forceDestroyTimer);
  }

  /**
   * Actively kill the stream with a close-frame sentinel (protocol error,
   * idle timeout, backpressure overflow). The client sees a WS close frame
   * with a status code rather than a silent TCP reset.
   *
   * `end()` — not `destroy()` — so the sentinel (and any already-buffered
   * frames) FLUSH to the peer before the FIN; a client that reads the
   * stream to the end sees why it died. The force-destroy backstop covers
   * a peer that never drains (the buffered amount is bounded by the
   * backpressure cap, so this cannot grow without bound).
   */
  private terminate(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.idleTimer);
    try {
      if (this.socket.writable) {
        this.socket.write(encodeFrame(OP_CLOSE, closePayload(1008, reason)));
      }
    } catch {
      // Socket already gone.
    }
    this.socket.end();
    this.forceDestroyTimer = setTimeout(() => {
      this.socket.destroy();
    }, 5_000);
    this.forceDestroyTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Internal handler bundle; the public entry point is {@link createApiServer}. */
class ControlPlane {
  /**
   * Live WS event-stream sockets. Node detaches a socket from the HTTP
   * server's connection tracking the moment it is upgraded, so
   * `server.close()` can only complete once these are destroyed (see
   * {@link closeStreams}).
   */
  private readonly wsSockets = new Set<Duplex>();
  /** Set once the server is closing; in-flight upgrades then abort. */
  private closing = false;
  /**
   * Agent runtime for `POST /api/analyze` (SPEC §17). Defaults to a
   * deterministic MockAgentRuntime with the analyze model registered.
   */
  private readonly analyzeRuntime: AgentRuntime;

  constructor(private readonly opts: ApiServerOptions) {
    this.analyzeRuntime =
      opts.runtime ??
      new MockAgentRuntime({ [DEFAULT_ANALYZE_MODEL]: DEFAULT_ANALYZE_MODEL_SPEC });
  }

  /**
   * Terminate every live WS event stream so `server.close()` can complete
   * (SPEC §18: the daemon must shut down cleanly with streams open). Each
   * socket destroy fires the stream's `close` handler, which clears its
   * poll timer; the server's close callback then resolves.
   */
  closeStreams(): void {
    this.closing = true;
    for (const socket of this.wsSockets) socket.destroy();
    this.wsSockets.clear();
  }

  private get store(): SqlAdapter {
    return this.opts.store;
  }
  private get scheduler(): RunScheduler {
    return this.opts.scheduler;
  }
  private get authTokens(): AuthTokenProvider {
    return this.opts.authTokens;
  }
  /** Workflow completion store (SPEC §5.4); defaults to one over the store. */
  private completionStore: WorkflowCompletionStore | null = null;
  private get completions(): WorkflowCompletionStore {
    this.completionStore ??= this.opts.completions ?? new WorkflowCompletionStore(this.store);
    return this.completionStore;
  }
  private get pollIntervalMs(): number {
    return this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }
  private get eventLimit(): number {
    return this.opts.eventLimit ?? DEFAULT_EVENT_LIMIT;
  }
  private get maxBodyBytes(): number {
    return this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }
  private get wsMaxFrameBytes(): number {
    return this.opts.wsMaxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES;
  }
  private get wsMaxBufferedBytes(): number {
    return this.opts.wsMaxBufferedBytes ?? DEFAULT_WS_MAX_BUFFERED_BYTES;
  }
  private get wsIdleTimeoutMs(): number {
    return this.opts.wsIdleTimeoutMs ?? DEFAULT_WS_IDLE_TIMEOUT_MS;
  }

  /** Authenticate the request; `null` = no/invalid/revoked/exhausted token. */
  private async authenticate(req: IncomingMessage): Promise<TokenIdentity | null> {
    const token = bearerToken(req);
    if (token === null) return null;
    return this.authTokens.validate(token);
  }

  /** One audit_log row (SPEC §16): actor = token id, action, run, cost when known. */
  private async writeAudit(entry: {
    actor: string;
    action: string;
    runId?: string;
    costMicroUsd?: number | null;
    data?: Record<string, unknown>;
  }): Promise<void> {
    await this.store.execute(
      "INSERT INTO audit_log (id, ts, actor, action, run_id, cost_micro_usd, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        randomUUID(),
        new Date().toISOString(),
        entry.actor,
        entry.action,
        entry.runId ?? null,
        entry.costMicroUsd ?? null,
        JSON.stringify(entry.data ?? {}),
      ],
    );
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const identity = await this.authenticate(req);
      if (identity === null) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      await this.route(req, res, identity);
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error("[api] unhandled error:", err);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: "internal server error" });
    }
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    identity: TokenIdentity,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/health") {
      sendJson(res, 200, { status: "ok", now: new Date().toISOString() });
      return;
    }
    if (method === "GET" && path === "/api/metrics") {
      await this.handleMetrics(res);
      return;
    }
    if (method === "GET" && path === "/api/runs") {
      sendJson(res, 200, { runs: await this.scheduler.listRuns() });
      return;
    }
    if (method === "POST" && path === "/api/runs") {
      await this.handleCreateRun(req, res, identity);
      return;
    }
    if (method === "POST" && path === "/api/analyze") {
      await this.handleAnalyze(req, res, identity);
      return;
    }
    const workflowMatch = /^\/api\/workflows\/([^/]+)\/completions$/.exec(path);
    if (workflowMatch !== null) {
      if (method === "POST") {
        await this.handleCompleteWorkflow(req, res, identity, workflowMatch[1]!);
        return;
      }
      if (method === "DELETE") {
        await this.handleUncompleteWorkflow(req, res, identity, workflowMatch[1]!);
        return;
      }
      throw new ApiError(404, "not found");
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (runMatch !== null) {
      if (method !== "GET") throw new ApiError(404, "not found");
      const run = await this.scheduler.getRun(runMatch[1]!);
      if (run === null) throw new ApiError(404, `run not found: ${runMatch[1]}`);
      sendJson(res, 200, { run });
      return;
    }
    const actionMatch = /^\/api\/runs\/([^/]+)\/(pause|resume|cancel)$/.exec(path);
    if (actionMatch !== null) {
      if (method !== "POST") throw new ApiError(404, "not found");
      await this.handleRunAction(
        res,
        identity,
        actionMatch[1]!,
        actionMatch[2] as "pause" | "resume" | "cancel",
      );
      return;
    }
    if (method === "GET" && path === "/api/work-items") {
      await this.handleWorkItems(req, res);
      return;
    }
    if (method === "GET" && path === "/api/events") {
      await this.handleEvents(req, res);
      return;
    }
    throw new ApiError(404, "not found");
  }

  private async handleMetrics(res: ServerResponse): Promise<void> {
    const [totalRows, activeRows] = await Promise.all([
      this.store.query<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM runs"),
      this.store.query<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')",
      ),
    ]);
    sendJson(res, 200, {
      totalRuns: Number(totalRows[0]?.n ?? 0),
      activeRuns: Number(activeRows[0]?.n ?? 0),
      spendMicroUsd: await this.authTokens.spend(),
    });
  }

  private async handleCreateRun(
    req: IncomingMessage,
    res: ServerResponse,
    identity: TokenIdentity,
  ): Promise<void> {
    const body = await readBody(req, this.maxBodyBytes);
    let input: CreateRunInput;
    try {
      input = parseCreateRunInput(
        JSON.parse(body.length === 0 ? "null" : body.toString("utf8")),
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        400,
        `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Per-token pipeline allowlist (SPEC §16): non-empty = create only the
    // listed pipelines; empty = allow-all. Enforced HERE, at run-create —
    // never on reads.
    const allowlist = identity.pipelineAllowlist ?? [];
    if (allowlist.length > 0 && !allowlist.includes(input.pipeline)) {
      throw new ApiError(
        403,
        `pipeline "${input.pipeline}" is not allowed for this token (allowlist: ${allowlist.join(", ")})`,
      );
    }
    // Per-token spend cap (SPEC §16): reads always authenticate; run-create
    // is the spend gate. An exhausted token cannot start new spend.
    if (identity.exhausted === true) {
      throw new ApiError(403, "token spend cap exhausted: refusing run-create");
    }
    // Global daemon spend cap (SPEC §16): refuse once cumulative audited
    // spend exceeds the cap. Checked before touching the scheduler.
    const cumulative = await this.authTokens.spend();
    if (cumulative > this.opts.globalSpendCapMicroUsd) {
      throw new ApiError(
        403,
        `global spend cap exceeded: ${cumulative} > ${this.opts.globalSpendCapMicroUsd} micro-USD`,
      );
    }
    // A configured (finite) global cap is defeated by a run that cannot be
    // priced in advance: refuse budgetless run-create so the cap bounds the
    // ledger (Infinity = unlimited = not configured). Actual spend is folded
    // in at completion by the scheduler's audit hook.
    if (
      Number.isFinite(this.opts.globalSpendCapMicroUsd) &&
      input.budgetMicroUsd === undefined
    ) {
      throw new ApiError(
        403,
        "a budgetMicroUsd is required when a global spend cap is configured",
      );
    }
    // Map to the scheduler's RunSpec; the scheduler derives `adapter` itself.
    // `actor` is the audit identity so the completion audit row's ACTUAL cost
    // counts against the creator's per-token cap.
    const spec: RunSpec = {
      pipeline: input.pipeline,
      model: input.model,
      actor: identity.id,
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.budgetMicroUsd !== undefined
        ? { budgetMicroUsd: input.budgetMicroUsd }
        : {}),
    };
    let id: string;
    try {
      id = await this.scheduler.createRun(spec);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The scheduler's own spec validation (belt-and-braces over ours).
      if (/pipeline|model|budgetMicroUsd/.test(message)) {
        throw new ApiError(400, message);
      }
      if (/closed/.test(message)) throw new ApiError(503, "scheduler is closed");
      throw err;
    }
    await this.writeAudit({
      actor: identity.id,
      action: "run-create",
      runId: id,
      // "cost when known": the run's reserved budget on create; actuals land
      // in spans (§18) and are folded into audit on completion.
      costMicroUsd: input.budgetMicroUsd ?? null,
    });
    sendJson(res, 201, { run: await this.scheduler.getRun(id) });
  }

  private async handleRunAction(
    res: ServerResponse,
    identity: TokenIdentity,
    id: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<void> {
    const existing = await this.scheduler.getRun(id);
    if (existing === null) throw new ApiError(404, `run not found: ${id}`);
    try {
      if (action === "pause") await this.scheduler.pause(id);
      else if (action === "resume") await this.scheduler.resume(id);
      else await this.scheduler.cancel(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such run/.test(message)) throw new ApiError(404, `run not found: ${id}`);
      throw err;
    }
    await this.writeAudit({
      actor: identity.id,
      action: `run-${action}`,
      runId: id,
      costMicroUsd: null,
    });
    sendJson(res, 200, { run: await this.scheduler.getRun(id) });
  }

  /**
   * POST /api/analyze (SPEC §17): the introspection agent, authenticated and
   * audited. The prompt is BOUNDED (length-capped) so one request cannot
   * monopolize the session; `runId`/`model` are optional. Returns the
   * agent's final text.
   */
  private async handleAnalyze(
    req: IncomingMessage,
    res: ServerResponse,
    identity: TokenIdentity,
  ): Promise<void> {
    const body = await readBody(req, this.maxBodyBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.length === 0 ? "null" : body.toString("utf8"));
    } catch (err) {
      throw new ApiError(
        400,
        `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isPlainObject(parsed)) throw new ApiError(400, "body must be a JSON object");
    const prompt = parsed.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new ApiError(400, "'prompt' must be a non-empty string");
    }
    if (prompt.length > MAX_ANALYZE_PROMPT_CHARS) {
      throw new ApiError(400, `'prompt' too long (max ${MAX_ANALYZE_PROMPT_CHARS} chars)`);
    }
    const runId = parsed.runId;
    if (runId !== undefined && (typeof runId !== "string" || runId.length === 0)) {
      throw new ApiError(400, "'runId' must be a non-empty string");
    }
    const model = parsed.model;
    if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
      throw new ApiError(400, "'model' must be a non-empty string");
    }
    const tools = new AnalyzeTools(this.store);
    const result = await runAnalysis(this.analyzeRuntime, tools, prompt, {
      ...(model !== undefined ? { model } : {}),
    });
    await this.writeAudit({
      actor: identity.id,
      action: "analyze",
      runId,
      costMicroUsd: null,
      data: { promptLength: prompt.length },
    });
    sendJson(res, 200, { result });
  }

  /**
   * Parse the shared `{ targetId?, unitId? }` body shape of the completions
   * endpoints (SPEC §5.4). `requireOne` enforces the complete contract (at
   * least one id); uncomplete allows neither (clear-all, store semantics).
   */
  private parseCompletionScope(
    body: unknown,
    requireOne: boolean,
  ): { targetId?: string; unitId?: string } {
    if (!isPlainObject(body)) throw new ApiError(400, "body must be a JSON object");
    const targetId = body.targetId;
    const unitId = body.unitId;
    if (targetId !== undefined && (typeof targetId !== "string" || targetId.length === 0)) {
      throw new ApiError(400, "'targetId' must be a non-empty string");
    }
    if (unitId !== undefined && (typeof unitId !== "string" || unitId.length === 0)) {
      throw new ApiError(400, "'unitId' must be a non-empty string");
    }
    if (requireOne && targetId === undefined && unitId === undefined) {
      throw new ApiError(400, "at least one of 'targetId' or 'unitId' is required");
    }
    return {
      ...(targetId !== undefined ? { targetId } : {}),
      ...(unitId !== undefined ? { unitId } : {}),
    };
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const body = await readBody(req, this.maxBodyBytes);
    try {
      return JSON.parse(body.length === 0 ? "null" : body.toString("utf8"));
    } catch (err) {
      throw new ApiError(
        400,
        `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * POST /api/workflows/:id/completions (SPEC §5.4): insert-or-ignore a
   * completion row through the store (auth + audit). `{ promote:false }`-style
   * manual completion: the row alone marks the scope complete; no work_items
   * write (the daemon's `finalizeWorkflowItem` is the run-time writer).
   */
  private async handleCompleteWorkflow(
    req: IncomingMessage,
    res: ServerResponse,
    identity: TokenIdentity,
    workflowId: string,
  ): Promise<void> {
    const parsed = await this.readJsonBody(req);
    const { targetId, unitId } = this.parseCompletionScope(parsed, true);
    const reason = (parsed as Record<string, unknown>).reason;
    if (reason !== undefined && typeof reason !== "string") {
      throw new ApiError(400, "'reason' must be a string");
    }
    const inserted = await this.completions.complete({
      workflowId,
      actor: identity.id,
      ...(targetId !== undefined ? { targetId } : {}),
      ...(unitId !== undefined ? { unitId } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    await this.writeAudit({
      actor: identity.id,
      action: "workflow-complete",
      costMicroUsd: null,
      data: { workflowId, unitId, targetId, reason },
    });
    sendJson(res, 201, { workflowId, unitId, targetId, completed: inserted });
  }

  /**
   * DELETE /api/workflows/:id/completions (SPEC §5.4): remove matching rows
   * (target-scoped deletes the precise run-time row too). Neither id given =
   * clear ALL completion rows for the workflow. Auth + audit.
   */
  private async handleUncompleteWorkflow(
    req: IncomingMessage,
    res: ServerResponse,
    identity: TokenIdentity,
    workflowId: string,
  ): Promise<void> {
    const parsed = await this.readJsonBody(req);
    const { targetId, unitId } = this.parseCompletionScope(parsed, false);
    const removed = await this.completions.uncomplete({
      workflowId,
      ...(targetId !== undefined ? { targetId } : {}),
      ...(unitId !== undefined ? { unitId } : {}),
    });
    await this.writeAudit({
      actor: identity.id,
      action: "workflow-uncomplete",
      costMicroUsd: null,
      data: { workflowId, unitId, targetId },
    });
    sendJson(res, 200, { workflowId, unitId, targetId, removed });
  }

  private async handleWorkItems(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("selector");
    let selector: Selector;
    try {
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      selector = validateSelector(parsed);
    } catch (err) {
      throw new ApiError(
        400,
        `invalid selector: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const rows = await select(this.store, selector);
    sendJson(res, 200, { workItems: rows.map(rowToWorkItem) });
  }

  private async handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const runId = params.get("runId") ?? undefined;
    const after = parseSeqParam(params.get("after"));
    let limit = this.eventLimit;
    const limitRaw = params.get("limit");
    if (limitRaw !== null) {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
        throw new ApiError(400, `invalid limit: ${limitRaw}`);
      }
      limit = Math.min(Number(limitRaw), MAX_EVENT_LIMIT);
    }
    const events = await readEvents(this.store, { runId, after, limit });
    sendJson(res, 200, { events });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, "not found");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) {
      rejectUpgrade(socket, 400, "missing Sec-WebSocket-Key");
      return;
    }
    // Auth is validated on the HTTP request BEFORE the upgrade (SPEC §16).
    this.authenticate(req).then(
      (identity) => {
        if (identity === null) {
          rejectUpgrade(socket, 401, "unauthorized");
          return;
        }
        void this.acceptUpgrade(socket, key, url).catch((err) => {
          console.error("[api] ws upgrade failed:", err);
          rejectUpgrade(socket, 500, "internal error");
        });
      },
      (err) => {
        console.error("[api] ws auth failed:", err);
        rejectUpgrade(socket, 500, "internal error");
      },
    );
  }

  private async acceptUpgrade(socket: Duplex, key: string, url: URL): Promise<void> {
    // Seed the cursor: `?after=<seq>`, or the current max seq at connect so
    // only NEW events stream (SPEC §18 read-on-demand).
    const afterRaw = url.searchParams.get("after");
    let after: number;
    if (afterRaw === null) {
      try {
        const rows = await this.store.query<{ m: number | bigint | null }>(
          "SELECT MAX(seq) AS m FROM events",
        );
        after = Number(rows[0]?.m ?? 0);
      } catch {
        after = 0;
      }
    } else {
      after = parseSeqParam(afterRaw);
    }
    if (!socket.writable || this.closing) {
      socket.destroy();
      return;
    }
    // Track the stream so server close can terminate it (see closeStreams).
    this.wsSockets.add(socket);
    socket.on("close", () => this.wsSockets.delete(socket));
    const accept = createHash("sha1")
      .update(`${key}${WS_GUID}`, "utf8")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    new WsStream(
      this.store,
      this.pollIntervalMs,
      this.eventLimit,
      socket,
      after,
      this.wsMaxFrameBytes,
      this.wsMaxBufferedBytes,
      this.wsIdleTimeoutMs,
    );
  }
}

/**
 * Create the control-plane API server (SPEC §16). Returns a plain
 * `http.Server`; pass `opts.port` to listen immediately on `opts.host`
 * (default {@link DEFAULT_BIND_HOST} = 127.0.0.1), otherwise call
 * `.listen()` yourself. Close it with `server.close()` — open WebSocket
 * event streams are terminated first (Node detaches upgraded sockets from
 * the HTTP server's connection tracking, so they would otherwise keep the
 * close callback pending forever), or use {@link close} for a promise.
 */
export function createApiServer(opts: ApiServerOptions): HttpServer {
  const plane = new ControlPlane(opts);
  const server = createServer((req, res) => {
    void plane.handleRequest(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    plane.handleUpgrade(req, socket, head);
  });
  // Node's http.Server stops tracking a socket the moment it is upgraded to a
  // WebSocket (the connection is handed to the `upgrade` listener), so
  // `server.close()` would wait forever on a live event stream. Destroy every
  // tracked stream first; the close callback then completes. This makes plain
  // `server.close(cb)` — not just {@link close} — terminate open streams.
  const closeServer = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    plane.closeStreams();
    return closeServer(cb);
  }) as typeof server.close;
  if (opts.port !== undefined) {
    server.listen(opts.port, opts.host ?? DEFAULT_BIND_HOST);
  }
  return server;
}

/**
 * Close the API server AND every live WS event stream, resolving once the
 * server is fully closed. `server.close()` alone cannot complete while
 * WebSocket streams are open — Node detaches upgraded sockets from the HTTP
 * server's connection tracking — so this relies on the {@link HttpServer.close}
 * override in {@link createApiServer} to destroy the streams first.
 */
export function close(server: HttpServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)));
  });
}
