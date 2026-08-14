/**
 * Workflow helper toolbox (SPEC §3): the built-in `WorkflowHelpers` surface,
 * the adapter-extensible `WorkItemKindMap`, and the runtime `HelperRegistry`.
 *
 * Two extensibility mechanisms:
 *  - **adapter-wide**: adapters `declare module "decompi"` to augment
 *    `WorkflowHelpers` and `WorkItemKindMap` (resolves via the package
 *    `exports` self-reference in package.json — see `src/index.ts`);
 *  - **workflow-local**: a workflow's `helpers?: H` merges into `ctx.helpers`
 *    at the engine (local shadows global, last-wins, detected at
 *    `addWorkflow` — not an error).
 *
 * `store` is deliberately **read-only** (`query` only): hooks never reach
 * `execute`/`transaction`, preserving the engine's single-writer discipline
 * (SPEC §3, §5.3).
 */
import { toJSONSchema } from "zod";
import type { z } from "zod";
import type { AgentRuntime } from "../agent/runtime.js";
import type { SqlAdapter } from "../core/store/adapter.js";
import type { Selector, WorkItem } from "../types.js";
import { JudgeError } from "./types.js";

/**
 * Read-only store surface exposed to workflow hooks — `query` only, no
 * `execute`/`transaction`/`insertIgnore`/`migrate`. A `SqlAdapter` is
 * assignable to this; the narrow type is what hooks compile against.
 */
export type ReadonlyStore = Pick<SqlAdapter, "query">;

/**
 * Built-in helper surface. Core declares the empty shape; adapters augment it
 * via `declare module "decompi" { interface WorkflowHelpers { ... } }` and a
 * workflow's local `helpers?: H` is intersected in by the engine.
 */
export interface WorkflowHelpers {
  /** Run a declarative `Selector` against the store (same surface as `plan`). */
  select(selector: Selector): Promise<WorkItem[]>;
  /** Tiny template-literal renderer: `${path}` with dot paths into `ctx` (missing → ""). */
  render(template: string, ctx: Record<string, unknown>): string;
  /**
   * Emit a workflow event (row id returned). The built-in stub resolves `0` —
   * the daemon path wires the real INSERT into `events` later; the stub keeps
   * workflows authorable and testable without a live daemon. Override by
   * passing `emitFn` to `makeBuiltinHelpers`.
   */
  emit(type: string, data: unknown): Promise<number>;
  /** Run logger (defaults to `console`). */
  log(level: string, msg: string): void;
  /** Read-only store view (query only — NO execute/transaction). */
  store: ReadonlyStore;
}

/**
 * Adapter vocab map: `kind` → the specialized WorkItem shape.
 * Core declares it EMPTY; adapters augment it:
 *
 * ```ts
 * declare module "decompi" {
 *   interface WorkItemKindMap { function: FunctionWorkItem; object: ObjectWorkItem }
 * }
 * ```
 *
 * `WorkItemOf<K>` narrows through this map (falling back to
 * `WorkItem & { kind: K }` for undeclared kinds).
 */
export interface WorkItemKindMap {}

/** Runtime helper registry: named functions looked up by the engine/daemon at run time. */
export class HelperRegistry {
  private readonly fns = new Map<string, unknown>();

  /** Register a named helper; a later `register` with the same name overwrites (last wins). */
  register(name: string, fn: unknown): this {
    this.fns.set(name, fn);
    return this;
  }

  /** Look up a helper by name; `undefined` when not registered. */
  get(name: string): unknown {
    return this.fns.get(name);
  }

  /** Whether a helper with this name is registered. */
  has(name: string): boolean {
    return this.fns.has(name);
  }

  /**
   * Every registered helper as a name→fn record — the engine merges this
   * into `ctx.helpers` (adapter-wide registration, before workflow-local
   * `helpers`).
   */
  toObject(): Record<string, unknown> {
    return Object.fromEntries(this.fns);
  }
}

const INTERPOLATION = /\$\{([^}]+)\}/g;

/** Resolve a dot path (`a.b.c`) against a ctx object; `undefined` when any hop is missing. */
function lookupPath(path: string, ctx: Record<string, unknown>): unknown {
  let value: unknown = ctx;
  for (const key of path.split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Stringify a resolved value for interpolation: "" for null/undefined, JSON for objects. */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Tiny template-literal renderer: replaces `${path}` (dot path into `ctx`)
 * with the resolved value; unresolvable paths render as `""`. Objects are
 * JSON-stringified; no control flow, no escaping — deliberately minimal.
 */
export function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(INTERPOLATION, (_match, expr: string) =>
    stringify(lookupPath(expr.trim(), ctx)),
  );
}

/**
 * Build the built-in helper set for a workflow engine.
 *
 * @param store  the engine's read-only store view (`query` only — surfaced
 *   as `helpers.store`; the same surface hooks see as `ctx.store`).
 * @param select the store-backed `Selector` resolver (same one `plan` uses).
 * @param emitFn optional event writer override (e.g. a daemon-backed INSERT
 *   into `events`). Defaults to a **no-op stub resolving `0`** — the daemon
 *   path wires the real writer later; the stub keeps workflows authorable and
 *   testable without a live daemon.
 */
export function makeBuiltinHelpers(
  store: ReadonlyStore,
  select: (s: Selector) => Promise<WorkItem[]>,
  emitFn?: (type: string, data: unknown) => Promise<number>,
): WorkflowHelpers {
  return {
    select,
    render: renderTemplate,
    // Stub until the daemon event path lands: resolves 0, documents intent.
    emit: emitFn ?? (async () => 0),
    log: (level, msg) => console.log(`[${level}] ${msg}`),
    // Wrap so even a cast-escape can't reach execute/transaction (type AND runtime guard).
    store: {
      query: (sql, params) => store.query(sql, params),
    },
    // Adapters augment `WorkflowHelpers` with members this factory does not
    // build (SPEC §3). The cast documents that contract: this is the CORE
    // subset, and the engine completes the surface (adapter registrations +
    // local `helpers`) before hooks ever see `ctx.helpers`. The literal
    // itself stays fully typed — every member is written out explicitly.
  } as WorkflowHelpers;
}

// --------------------------------------------------------------------------
// ctx.StartJsonAgent — the stateless judge agent (SPEC §A.2)
// --------------------------------------------------------------------------

/**
 * `ctx.StartJsonAgent` — a separate, stateless judge agent. The schema type
 * param drives the return: `z.infer<S>` with NO `any`.
 */
export type StartJsonAgent = <S extends z.ZodType>(
  model: string,
  prompt: string,
  input: unknown,
  schema: S,
) => Promise<z.infer<S>>;

/** Retry cap: the initial attempt plus ONE retry (SPEC §A.2 "retry once"). */
const MAX_JUDGE_ATTEMPTS = 2;

/** The JSON-mode turn instruction (SPEC §A.2): a single JSON object, schema-constrained. */
function jsonModeInstruction(schemaText: string): string {
  return `Respond with a single JSON object matching this schema: ${schemaText}`;
}

/**
 * Render a zod schema for the JSON-mode instruction. Prefers a proper JSON
 * Schema via `toJSONSchema` (zod v4); falls back to the raw schema's JSON,
 * then `String(schema)` — the instruction must never throw.
 */
function describeSchema(schema: z.ZodType): string {
  try {
    return JSON.stringify(toJSONSchema(schema));
  } catch {
    try {
      return JSON.stringify(schema);
    } catch {
      return String(schema);
    }
  }
}

/** Stringify `input` for the judge turn: strings pass through, else JSON. */
function renderInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * Bind `ctx.StartJsonAgent` to a runtime (SPEC §A.2): each call opens a
 * FRESH session (`createSession({ model, prompt })`), feeds ONE JSON-mode
 * turn with `input`, and zod-parses the reply. Non-JSON / schema-invalid
 * output retries once with a fresh session, then throws `JudgeError`. Every
 * attempt is a normal runtime turn — pacing, budget pre-checks, and charging
 * are handled by the (wrapped) runtime, exactly like `agent` steps.
 */
export function makeStartJsonAgent(runtime: AgentRuntime): StartJsonAgent {
  return async (model, prompt, input, schema) => {
    const schemaText = describeSchema(schema);
    let attempts = 0;
    for (;;) {
      attempts++;
      // Stateless judge: never shares the agentLoop's session; each attempt
      // is a fresh session so a failed reply cannot poison the next one.
      const session = await runtime.createSession({ model, prompt });
      const turn = jsonModeInstruction(schemaText);
      const payload = input === undefined ? turn : `${turn}\n\nInput:\n${renderInput(input)}`;
      const reply = await session.prompt(payload);
      try {
        return schema.parse(JSON.parse(reply.finalText));
      } catch (cause) {
        if (attempts >= MAX_JUDGE_ATTEMPTS) {
          throw new JudgeError(
            `StartJsonAgent: judge output was not valid JSON for the schema after ${attempts} attempt(s)`,
            attempts,
            { cause },
          );
        }
        // Retry once with a fresh session.
      }
    }
  };
}
