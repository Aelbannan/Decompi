/**
 * Typed `Workflow` authoring API (SPEC §2): kind-narrowed hooks, the
 * `Workflow` class with `const` type params, and the execution context handed
 * to hooks.
 *
 * `Workflow.compile()` emits the `agentLoop` Pipeline via the compiler in
 * `./compile.ts` (SPEC §4); everything here is fully typed so workflows can
 * be authored before (and independently of) the compiler.
 */
import type { z } from "zod";
import type { AgentTurn } from "../pipeline/engine.js";
import type { Pipeline } from "../pipeline/types.js";
import type { Selector, WorkItem } from "../types.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { compileWorkflow } from "./compile.js";
import type { ReadonlyStore, WorkflowHelpers, WorkItemKindMap } from "./helpers.js";

/** A workflow's item kind vocabulary (e.g. "function" | "object" | "label"). */
export type WorkItemKind = string;

/**
 * Kind-narrowed WorkItem: resolves through the adapter's `WorkItemKindMap`
 * when the kind is declared, otherwise falls back to the generic
 * `WorkItem & { kind: K }` shape (undeclared kinds stay fully typed on the
 * common fields).
 */
export type WorkItemOf<K extends WorkItemKind> = K extends keyof WorkItemKindMap
  ? WorkItemKindMap[K]
  : WorkItem & { kind: K };

/**
 * In-session re-prompt verdict (SPEC §2 `agentLoop` turn semantics): only
 * `accepted` items leave play; `rejected` (and absent) items STAY in play and
 * are described by `feedback` for the next turn. `final: true` skips the next
 * re-prompt and routes `rejected` to `onReject` immediately.
 */
export interface RepromptVerdict<K extends WorkItemKind = WorkItemKind> {
  /** Removed from play this turn (finalized by the engine). */
  accepted: WorkItemOf<K>[];
  /** Stay in play; described by `feedback` for the next turn. */
  rejected: WorkItemOf<K>[];
  /** How the rejected items failed — fed back to the model next turn. */
  feedback?: string;
  /** Skip the next re-prompt; route `rejected` straight to `onReject`. */
  final?: boolean;
}

/**
 * What "complete" means for a workflow (SPEC §2, §5.2). The `complete` hook
 * (decider) returns this; the engine executes it via `ctx.finalize` (writer).
 */
export type CompletionAction =
  | { promote: false }
  | { promote: true; status?: string; evidence?: unknown }
  | { status: string };

/**
 * Per-batch config returned by a workflow's `setup` hook (SPEC §A.1). The
 * engine runs `setup(batch, ctx)` ONCE per batch, before the `agentLoop`.
 * `batchSize` (integer >= 1) may only SUB-DIVIDE the current batch — excess
 * items spill over to the next batch; the batch is never re-shuffled or
 * enlarged. Precedence for the loop's model: `setup.model` > route-fragment
 * model > run `defaultModel`.
 */
export interface WorkflowConfig {
  /** Re-prompt cap for this batch (overrides the workflow's `rejectionRetries`). */
  rejectionRetries?: number;
  /** Sub-divide the current batch; spillover returns to the front of the queue. */
  batchSize?: number;
  /** Judge/loop model for this batch (overrides route/run defaults). */
  model?: string;
}

/** Run-scope intersection (SPEC §6): target ids and/or unit ids, AND-ed together. */
export interface RunScope {
  targetIds?: string[];
  unitIds?: string[];
}

/** A workflow definition: identity, plan surface, hooks. */
export interface WorkflowDef<
  K extends WorkItemKind,
  H extends Record<string, unknown>,
> {
  /** Workflow id, unique across the engine's registry. */
  id: string;
  /** The item kind this workflow operates on (`WorkItemOf<K>` narrows to it). */
  accepts: K;
  /** false = one target per session; defaults to true. */
  canBatch?: boolean;
  /** Batch size for foreach batching; defaults to 5. */
  defaultBatchSize?: number;

  /** Plan selector surface: status/sort/limit (kind is always = `accepts`). */
  select?: {
    filter?: Omit<Selector["filter"], "kind" | "ids">;
    sort?: Selector["sort"];
    limit?: number;
  };

  /** Local helpers, typed `H`; merged into `ctx.helpers` (local shadows global). */
  helpers?: H;

  /**
   * Per-batch config hook (SPEC §A.1): the engine runs it ONCE per batch,
   * before the `agentLoop`. Returns a `WorkflowConfig` (batch sub-division /
   * model / rejectionRetries overrides); the engine consumes it — this field
   * is compiled onto the `foreach` step.
   */
  setup?(targets: WorkItemOf<K>[], ctx: WorkflowCtx<K, H>): Promise<WorkflowConfig>;

  /** In-session re-prompt cap (v1 continuation). Default from engine config; per-run overridable. */
  rejectionRetries?: number;

  /** Auto `onReject` retry routes (singleton/rebatch). */
  routes?: {
    when?: { sizeBelow?: number; status?: string[]; attempts?: { min?: number; max?: number } };
    model: string;
    maxAttempts?: number;
  }[];

  /** Build the first user prompt for a batch of in-play targets. */
  startPrompt(targets: WorkItemOf<K>[], ctx: WorkflowCtx<K, H>): Promise<string>;
  /** Decide the verdict after the model's turn (see `RepromptVerdict`). */
  reprompt(
    targets: WorkItemOf<K>[],
    ctx: WorkflowCtx<K, H>,
    lastTurn: AgentTurn,
  ): Promise<RepromptVerdict<K>>;
  /** Decider: returns what "complete" means; the engine executes via `ctx.finalize`. */
  complete?(target: WorkItemOf<K>, ctx: WorkflowCtx<K, H>): Promise<CompletionAction>;
}

/**
 * Thrown by `ctx.StartJsonAgent` (SPEC §A.2) when the judge replies with
 * non-JSON or schema-invalid output on every attempt. The workflow catches it
 * and decides (e.g. treat as non-converging). `attempts` = how many fresh
 * judge sessions were tried before giving up (2 = initial + one retry).
 */
export class JudgeError extends Error {
  readonly attempts: number;

  constructor(message: string, attempts: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JudgeError";
    this.attempts = attempts;
  }
}

/**
 * Execution context handed to workflow hooks. `finalize` is the WRITER
 * primitive (daemon transition, transactional + idempotent); everything else
 * is read-only (`store` exposes `query` only) — hooks cannot reach the
 * engine's `execute`/`transaction`, preserving single-writer discipline.
 */
export interface WorkflowCtx<
  K extends WorkItemKind,
  H extends Record<string, unknown>,
> {
  /** Built-in + adapter + local helpers (local shadows global). */
  helpers: WorkflowHelpers & H;
  /** Persist a completion: completion row (insert-or-ignore) + action write + event. */
  finalize(target: WorkItemOf<K>, action: CompletionAction): Promise<void>;
  /** Run scope intersection (targetIds ∩ unitIds). */
  scope: RunScope;
  /** The most recent agent turn (model reply + usage + style-guide hash). */
  lastTurn: AgentTurn;
  /** Agent runtime: model resolution + session creation (engine-owned call). */
  runtime: AgentRuntime;
  /** Store-backed selector resolver (same surface as `helpers.select`). */
  select(selector: Selector): Promise<WorkItem[]>;
  /** Read-only store view (query only). */
  store: ReadonlyStore;
  /**
   * Separate stateless judge agent (SPEC §A.2): a FRESH session per call,
   * ONE JSON-mode turn fed with `input`, zod-validated reply. Non-JSON or
   * schema-invalid output retries once (fresh session), then throws
   * `JudgeError`. Each attempt is a normal runtime turn (pacing/budget).
   */
  StartJsonAgent<S extends z.ZodType>(
    model: string,
    prompt: string,
    input: unknown,
    schema: S,
  ): Promise<z.infer<S>>;
  /** Run logger. */
  log(level: string, msg: string): void;
}

/**
 * A typed workflow (SPEC §2). `const` type params: `new Workflow({ accepts:
 * "function" })` infers `K = "function"` and narrows every hook's `targets` /
 * verdict to `WorkItemOf<"function">`; `H` is inferred from `helpers`.
 */
export class Workflow<
  const K extends WorkItemKind = WorkItemKind,
  const H extends Record<string, unknown> = {},
> {
  /** Workflow id (registered on the engine). */
  readonly id: string;
  /** The item kind this workflow accepts (inferred literal). */
  readonly accepts: K;

  constructor(private readonly def: WorkflowDef<K, H>) {
    this.id = def.id;
    this.accepts = def.accepts;
  }

  /**
   * The workflow's definition (private in the class). The compiler reads it
   * via this getter; hooks/adapters can too.
   */
  get definition(): WorkflowDef<K, H> {
    return this.def;
  }

  /**
   * Compile to the engine's `Pipeline` (SPEC §4: `plan` + `agentLoop` +
   * `onReject` fragments). The full compiler output (fragments included) is
   * `compileWorkflow(this)`; the pipeline is the half the engine runs.
   */
  compile(): Pipeline {
    return compileWorkflow(this).pipeline;
  }
}
