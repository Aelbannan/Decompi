/**
 * M4 serve wiring (SPEC §15, §16, §19 M4 row): `startServer` brings up the
 * whole control plane in one call — the embedded store daemon (single
 * writer), a pipeline engine with the builtin `match` pipelines, a
 * MockAgentRuntime-backed run scheduler, the bearer-auth REST/WS API, and
 * the web/ dashboard (index.html + app.js) at `/` — all on 127.0.0.1
 * (SPEC §16 default bind; the API server in api.ts is not modified).
 *
 * Workflow cut-over glue (M5): one `WorkflowStatusStore` (over the same
 * store) and one adapter-wide `HelperRegistry` (the xenoblade coop helpers
 * via `registerHelpers`) are built here and wired end-to-end — the facade
 * compiles workflows with the status store (compiled plans skip done
 * targets) and the scheduler threads BOTH into every run, so accepted
 * items record status rows (a later plan skips them) and `forwardCtx`
 * materializes `ctx.helpers` with the adapter's real helpers.
 *
 * Static-file layering: the `createServer` callback of the API server is a
 * plain `request` listener; serve.ts swaps it for a router that serves web/
 * assets on non-API paths and forwards `/api/*` + `/ws/events` through the
 * original handler (bearer auth intact). The `upgrade` listener (live WS
 * event stream) and the close() override in api.ts are left untouched, so
 * streams and clean shutdown keep working. `startServer` owns `listen()`
 * (the API server is created without a port) so the banner can report the
 * real bound port (`--port 0` = ephemeral).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import { StoreDaemon } from "../core/daemon.js";
import { SqliteAdapter } from "../core/store/sqlite.js";
import { MockAgentRuntime } from "../agent/mock.js";
import { PipelineEngine } from "../pipeline/engine.js";
import { registerMatchPipelines } from "../pipeline/builtin/match.js";
import { RunScheduler } from "./scheduler.js";
import { WorkflowStatusStore } from "../workflow/status.js";
import { HelperRegistry } from "../workflow/helpers.js";
import { Decompi } from "../workflow/facade.js";
import { registerHelpers } from "../../adapters/xenoblade/workflow.js";
import { MIGRATIONS } from "../core/store/migrations.js";
import {
  AuthTokenProvider,
  createApiServer,
  DEFAULT_BIND_HOST,
  close as closeApiServer,
} from "./api.js";

/** Default bind port for `decompi serve`. */
export const DEFAULT_SERVE_PORT = 8787;

/** Default SQLite path when `--db` is not given. */
const DEFAULT_DB_PATH = "decompi.db";

/** Default cap on concurrently ACTIVE runs (SPEC §5 "N concurrent runs"). */
const DEFAULT_MAX_PARALLEL_RUNS = 4;

/** One static asset served from web/ at the root. */
interface StaticAsset {
  body: Buffer;
  contentType: string;
}

/** Options for {@link startServer}. */
export interface StartServerOptions {
  /**
   * Bind port on 127.0.0.1 (SPEC §16 default bind). `0` = an ephemeral
   * port (the banner reports the real one). Defaults to
   * {@link DEFAULT_SERVE_PORT}.
   */
  port?: number;
  /** SQLite path (`":memory:"` allowed). Defaults to `./decompi.db`. */
  dbPath?: string;
  /**
   * Bearer tokens to provision into `auth_tokens` at startup (SPEC §16 —
   * every API endpoint requires one). Each token's id is the audit actor.
   */
  authTokens?: Array<{ id: string; secret: string }>;
  /** Cap on concurrently ACTIVE runs (SPEC §5); defaults to 4. */
  maxParallelRuns?: number;
  /**
   * Global daemon spend cap in micro-USD (SPEC §16); run-create is refused
   * once cumulative audited spend exceeds it. Defaults to unlimited.
   */
  globalSpendCapMicroUsd?: number;
}

/** A running control plane: the HTTP server plus an idempotent shutdown. */
export interface StartServerHandle {
  server: HttpServer;
  /**
   * Stop the API server (live WS streams included), cancel runs in the
   * scheduler, stop the store daemon's reap timer, and close the store.
   * Idempotent; resolves once everything has settled.
   */
  close(): Promise<void>;
}

/**
 * Resolve the web/ directory. In the source tree (tsx / tests) it sits
 * beside `src/`; `npm run build` does not copy web/ into `dist/`, so the
 * compiled CLI resolves it against the cwd instead.
 */
function resolveWebDir(): string {
  const candidates = [
    fileURLToPath(new URL("../../web/", import.meta.url)),
    join(process.cwd(), "web"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  throw new Error(
    `serve: web/ static dir not found (looked in: ${candidates.join(", ")})`,
  );
}

/**
 * Read the dashboard assets once at startup (fail fast when web/ is
 * absent). Only the files that exist in web/ are served: `/` and
 * `/index.html` → index.html, `/app.js` → app.js.
 */
function loadStaticAssets(): Map<string, StaticAsset> {
  const webDir = resolveWebDir();
  const assets = new Map<string, StaticAsset>();
  const indexHtml = readFileSync(join(webDir, "index.html"));
  assets.set("/", { body: indexHtml, contentType: "text/html; charset=utf-8" });
  assets.set("/index.html", { body: indexHtml, contentType: "text/html; charset=utf-8" });
  assets.set("/app.js", {
    body: readFileSync(join(webDir, "app.js")),
    contentType: "application/javascript; charset=utf-8",
  });
  return assets;
}

/** URL pathname of a request; degrades to "/" on a malformed URL. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

/** Serve one static asset, or a plain 404 for any other path. */
function serveAsset(req: IncomingMessage, res: ServerResponse, assets: Map<string, StaticAsset>): void {
  const asset = assets.get(pathOf(req));
  if (asset === undefined) {
    sendPlain(res, 404, "not found");
    return;
  }
  res.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": asset.body.length,
  });
  res.end(asset.body);
}

/** A `request` listener as attached by `http.createServer(callback)`. */
type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/** Paths owned by the API server; everything else is web/ static. */
const API_PATH_PREFIX = "/api/";
const WS_PATH = "/ws/events";

/**
 * Layer the web/ dashboard over the API server without touching api.ts:
 * replace the server's `request` listeners with a router — web/ assets on
 * non-API paths, the original API handler(s) for `/api/*` and `/ws/events`
 * (bearer auth intact). The `upgrade` listener (live WS event stream) and
 * the close() override in api.ts are left alone.
 */
function attachWebRouting(apiServer: HttpServer, assets: Map<string, StaticAsset>): HttpServer {
  const apiHandlers = apiServer.listeners("request") as RequestListener[];
  apiServer.removeAllListeners("request");
  apiServer.on("request", (req, res) => {
    const path = pathOf(req);
    if (path.startsWith(API_PATH_PREFIX) || path === WS_PATH) {
      for (const handler of apiHandlers) handler(req, res);
      return;
    }
    serveAsset(req, res, assets);
  });
  return apiServer;
}

/**
 * Listen on 127.0.0.1 (SPEC §16 default bind) and resolve with the actual
 * bound port (useful for `--port 0`). Rejects on a listen error (e.g. the
 * port is already taken) instead of leaving the caller awaiting forever.
 */
function listen(server: HttpServer, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(address !== null && typeof address === "object" ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, DEFAULT_BIND_HOST);
  });
}

/**
 * Bring up the M4 control plane (SPEC §15 `decompi serve`, §16 security):
 * migrate the store, start the embedded store daemon (single writer +
 * continuous lease reaping), register the builtin match pipelines on a
 * fresh engine, wire a MockAgentRuntime-backed run scheduler, provision the
 * requested auth tokens, create the bearer-auth API server, layer web/ at
 * `/`, and bind 127.0.0.1:<port>. Prints
 * `decompi: serving on http://127.0.0.1:<port>` once listening.
 *
 * A failed start tears down whatever came up — a partial startup never
 * leaks a listener, timer, or open store handle.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<StartServerHandle> {
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
  const adapter = new SqliteAdapter(dbPath);
  let daemon: StoreDaemon | null = null;
  let scheduler: RunScheduler | null = null;
  let apiServer: HttpServer | null = null;
  try {
    // Store: canonical schema (§6.2) + versioned migrations (v1 status
    // ladder) on the host-owned adapter.
    await adapter.migrate([...MIGRATIONS]);

    // Embedded store daemon: single writer + continuous reap (§5, §6.3).
    daemon = new StoreDaemon(adapter);
    await daemon.start();

    // Pipeline engine with the builtin match pipelines (§10, §19 M3).
    const engine = new PipelineEngine();
    registerMatchPipelines(engine);

    // Workflow status store (SPEC §A): compiled workflow plans subtract
    // done targets (`isDone(wf, ·, doneStatuses)`), and run-accepted items
    // record precise `(workflow, unit, target)` status rows through the
    // scheduler's default finalize (status = the pipeline's compiled
    // `completionStatus`), so a later plan skips them. One instance shared
    // by the facade (compile-time) and the scheduler (run-time writer).
    const statusesStore = new WorkflowStatusStore(adapter);

    // Adapter-wide helper registry (SPEC §3): the xenoblade coop-tool helpers
    // (getFunctionAsm / runBatchCycle / structLayout). Registering touches no
    // filesystem; the helpers resolve the repo only when invoked. Threaded
    // into every run so `forwardCtx` materializes `ctx.helpers`.
    const helpers = new HelperRegistry();
    registerHelpers(helpers);

    // Run scheduler on the deterministic mock runtime (the real pi SDK
    // agent adapter lands in M5).
    scheduler = new RunScheduler({
      store: adapter,
      engine,
      maxParallelRuns: opts.maxParallelRuns ?? DEFAULT_MAX_PARALLEL_RUNS,
      runtime: new MockAgentRuntime(),
      daemon,
      statusesStore,
      helpers,
    });

    // Facade wiring: workflows added through `Decompi.addWorkflow` compile
    // with the SAME status store + helper registry — compiled plans skip
    // done targets, and the compiled pipeline carries the registry as its
    // run default (the scheduler also threads both into every run).
    Decompi.configure({ engine, scheduler, statusesStore, helpers });

    // Control-plane API with bearer auth (§16). Created WITHOUT a port:
    // serve.ts owns listen() so it can layer web/ over the same server and
    // report the real bound port.
    const authTokens = new AuthTokenProvider(adapter);
    for (const token of opts.authTokens ?? []) {
      await authTokens.issue(token.id, token.secret);
    }
    const server = createApiServer({
      store: adapter,
      scheduler,
      authTokens,
      // Infinity = unlimited (not configured): a budgetless run-create is
      // only refused when a FINITE cap is configured (SPEC §16).
      globalSpendCapMicroUsd: opts.globalSpendCapMicroUsd ?? Infinity,
    });
    apiServer = server;

    attachWebRouting(server, loadStaticAssets());

    const boundPort = await listen(server, opts.port ?? DEFAULT_SERVE_PORT);
    process.stdout.write(`decompi: serving on http://127.0.0.1:${boundPort}\n`);

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await closeApiServer(server);
      await scheduler!.close();
      await daemon!.close();
      adapter.close();
    };
    return { server, close };
  } catch (err) {
    // A failed start must never leak handles: tear down whatever came up.
    if (apiServer !== null) await closeApiServer(apiServer).catch(() => undefined);
    if (scheduler !== null) await scheduler.close().catch(() => undefined);
    if (daemon !== null) await daemon.close().catch(() => undefined);
    adapter.close();
    throw err;
  }
}
