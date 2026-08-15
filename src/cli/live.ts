/**
 * Live CLI wiring (SPEC §15/§19): `decompi run` self-configuration. When the
 * `Decompi` facade has no deps (no embedding harness / serve wired it), the
 * run command builds the full live stack itself:
 *
 *   - a SQLite store (migrated) with the xenoblade targets imported
 *     (live `importWorkItems` read of the worktree's tools/coop/targets.json),
 *   - a `PipelineEngine` with the `basic-match` workflow compiled on
 *     (status store + helper registry threaded),
 *   - the REAL pi SDK agent runtime (`PiAgentRuntime` over `ModelRuntime`)
 *     resolving model names from `models.json` (cwd; `--models` overrides),
 *   - a `RunScheduler` (cap 1) with the xenoblade diff verifier,
 *   - the `Decompi` facade configured over the whole thing.
 *
 * The stack is host-owned: `close()` cancels in-flight runs, closes the
 * scheduler, and closes the store.
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SqliteAdapter } from "../core/store/sqlite.js";
import { MIGRATIONS } from "../core/store/migrations.js";
import { PipelineEngine } from "../pipeline/engine.js";
import { RunScheduler, type RunRecord } from "../server/scheduler.js";
import { WorkflowStatusStore } from "../workflow/status.js";
import { HelperRegistry } from "../workflow/helpers.js";
import { Decompi } from "../workflow/facade.js";
import { PiAgentRuntime } from "../agent/pi-runtime.js";
import { loadModels } from "../models/directory.js";
import { importRegistry } from "../target/registry.js";
import { WorkItemRepo } from "../target/work-item.js";
import type { AdapterCtx } from "../adapter/types.js";
import xenobladeAdapter from "../../adapters/xenoblade/adapter.js";
import { registerHelpers } from "../../adapters/xenoblade/workflow.js";
import { basicMatch } from "../../examples/basic-match.js";

/** A configured live stack plus its teardown. */
export interface LiveStack {
  adapter: SqliteAdapter;
  scheduler: RunScheduler;
  runtime: PiAgentRuntime;
  /** Cancel in-flight runs, close scheduler + runtime, close the store. */
  close(): Promise<void>;
}

/**
 * Configure the `Decompi` facade over a live xenoblade stack. Idempotent per
 * process: a second call returns the existing stack (the facade is a
 * singleton). `dbPath` — SQLite path (`":memory:"` allowed); `modelsPath` —
 * models.json to load (default `<cwd>/models.json`).
 */
export async function configureLiveDecompi(opts: {
  dbPath?: string;
  modelsPath?: string;
}): Promise<LiveStack> {
  const modelsPath = opts.modelsPath ?? "models.json";
  if (!existsSync(modelsPath)) {
    throw new Error(
      `models file not found: ${modelsPath} (create a models.json with your provider/model entries)`,
    );
  }
  const modelEntries = loadModels(JSON.parse(readFileSync(modelsPath, "utf-8")));
  const models = new Map(modelEntries.map((e) => [e.name, e.spec]));

  // Store + registry import (the xenoblade targets, live read). targets.json
  // is the live registry source (SPEC §6.4), so the imported rows are
  // rebuilt from scratch each wiring — a re-run on the same db must not
  // trip the PK on the stable target ids.
  const adapter = new SqliteAdapter(opts.dbPath ?? "decompi.db");
  await adapter.migrate([...MIGRATIONS]);
  const workItems = await xenobladeAdapter.importWorkItems({} as AdapterCtx);
  await adapter.transaction(async (tx) => {
    await tx.execute("DELETE FROM work_item_capabilities", []);
    await tx.execute("DELETE FROM work_item_deps", []);
    await tx.execute("DELETE FROM work_items", []);
    await importRegistry(tx, { workItems, deps: [], capabilities: [] });
  });

  // Engine + status store + helpers.
  const engine = new PipelineEngine();
  const statusesStore = new WorkflowStatusStore(adapter);
  const helpers = new HelperRegistry();
  registerHelpers(helpers);

  // Real pi SDK agent runtime (models resolved from models.json).
  const piRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  const runtime = new PiAgentRuntime({ runtime: piRuntime, models });

  const repo = new WorkItemRepo(adapter);
  const scheduler = new RunScheduler({
    store: adapter,
    engine,
    maxParallelRuns: 1,
    runtime,
    statusesStore,
    helpers,
    verifiers: {
      diff: { id: "diff", verify: (item) => xenobladeAdapter.verify({} as AdapterCtx, item) },
    },
  });

  Decompi.configure({
    engine,
    scheduler,
    select: (selector) => repo.list(selector),
    statusesStore,
    helpers,
  });
  Decompi.addWorkflow(basicMatch);

  return {
    adapter,
    scheduler,
    runtime,
    close: async () => {
      await scheduler.close();
      adapter.close();
    },
  };
}

/** Poll a run until it settles (done/failed/cancelled), then resolve its record. */
export async function waitForRun(
  scheduler: RunScheduler,
  runId: string,
  opts: { timeoutMs?: number; pollMs?: number; onTick?: (record: RunRecord) => void } = {},
): Promise<RunRecord> {
  const timeoutMs = opts.timeoutMs ?? 6 * 60 * 60 * 1000; // default 6h
  const pollMs = opts.pollMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await scheduler.getRun(runId);
    if (record === null) throw new Error(`run ${runId}: no such run row`);
    const terminal = record.status === "done" || record.status === "failed" || record.status === "cancelled";
    opts.onTick?.(record);
    if (terminal) return record;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId}: timed out after ${timeoutMs} ms (status ${record.status})`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Join a run id with its pipeline id, for error messages. */
export function runLabel(runId: string, record: RunRecord): string {
  return `${record.pipeline}/${runId}`;
}
