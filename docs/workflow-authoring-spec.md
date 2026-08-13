# Decompi Workflow Authoring API — Spec (rev 3)

A high-level, fully-typed **`Workflow` class** that compiles to the existing
`Pipeline` engine, introducing one **new step primitive** (`agentLoop`). Raw
`definePipeline`/steps remain the low-level escape hatch.

> **rev 3** — incorporates review rounds 1–2
> (`docs/reviews/workflow-spec-consolidated.md`, `workflow-spec-r2-consolidated.md`).
> Typing core proven; this rev drops the harmful `lifecycle` plan exclusion,
> specifies the acceptance writer (transactional + idempotent), defines
> `agentLoop` turn semantics, removes dead `timeoutRetries`, folds scope into the
> persisted selector, and adds the `select` surface + the package `exports` task.

---

## 1. Goals

- **TypeScript-first authoring.** A typed class with hooks, not a raw step graph.
- **Strong typing.** Kind narrowing that actually narrows; typed helpers; typed
  verdicts; no `any`.
- **Extensible `ctx`.** Helpers merge built-in + adapter + user functions, all typed.
- **Engine owns the model call.** Hooks return data; the engine runs the model,
  retries, pacing, and budget between them.
- **Completion + scope.** Per-workflow manual completion (target/unit) and
  explicit run scoping (target/unit), both typed.

---

## 2. The `Workflow` class

```ts
export type WorkItemKind = string;

export interface WorkItemKindMap {}  // core declares empty; adapters augment

// adapter (adapters/xenoblade):
declare module "decompi" {
  interface WorkItemKindMap { function: FunctionWorkItem; object: ObjectWorkItem; label: LabelWorkItem }
}

export type WorkItemOf<K extends WorkItemKind> =
  K extends keyof WorkItemKindMap ? WorkItemKindMap[K] : WorkItem & { kind: K };

export interface RepromptVerdict<K extends WorkItemKind = WorkItemKind> {
  accepted: WorkItemOf<K>[];   // removed from play this turn (finalized)
  rejected: WorkItemOf<K>[];   // stay in play; described by `feedback` for the next turn
  feedback?: string;
  final?: boolean;             // skip re-prompt; route rejected to onReject
}

export type CompletionAction =
  | { promote: false }
  | { promote: true; status?: string; evidence?: unknown }
  | { status: string };

export interface WorkflowDef<
  K extends WorkItemKind,
  H extends Record<string, unknown>,
> {
  id: string;
  accepts: K;
  canBatch?: boolean;         // false = one target per session
  defaultBatchSize?: number;  // default 5

  /** Plan selector surface: status/sort/limit (kind is always = accepts). */
  select?: { filter?: Omit<Selector["filter"], "kind" | "ids">; sort?: Selector["sort"]; limit?: number };

  /** Local helpers, typed H; merged into ctx.helpers (local shadows global). */
  helpers?: H;

  /** In-session re-prompt cap (v1 continuation). Default from engine config; per-run overridable via RunSpec.config. */
  rejectionRetries?: number;

  /** Auto `onReject` retry routes (singleton/rebatch). */
  routes?: { when?: { sizeBelow?: number; status?: string[]; attempts?: { min?: number; max?: number } };
             model: string; maxAttempts?: number }[];

  startPrompt(targets: WorkItemOf<K>[], ctx: WorkflowCtx<K, H>): Promise<string>;
  reprompt(targets: WorkItemOf<K>[], ctx: WorkflowCtx<K, H>, lastTurn: AgentTurn): Promise<RepromptVerdict<K>>;
  /** Decider: returns what "complete" means for this workflow. Engine executes via ctx.finalize. */
  complete?(target: WorkItemOf<K>, ctx: WorkflowCtx<K, H>): Promise<CompletionAction>;
}

/** `const` type params: `new Workflow({accepts:"function"})` infers K="function". */
export class Workflow<
  const K extends WorkItemKind = WorkItemKind,
  const H extends Record<string, unknown> = {},
> {
  constructor(def: WorkflowDef<K, H>);
  readonly id: string;
  readonly accepts: K;
  compile(): Pipeline;
}
```

Example (typed, compiles under `const K`):

```ts
const basicMatchWorkflow = new Workflow({
  id: "basic-match",
  accepts: "function",
  canBatch: true,
  defaultBatchSize: 5,
  rejectionRetries: 1,
  select: { filter: { status: ["NOT_STARTED"] }, sort: [{ by: "size", dir: "asc" }], limit: 100 },
  routes: [
    { when: { sizeBelow: 128 }, model: "nube-ds4-flash-low" },   // rebatch
    { model: "nube-ds4-flash-high" },                             // singleton
  ],
  helpers: { createUnitDossier },

  startPrompt: async (targets, ctx) => {
    const asm = await Promise.all(targets.map(t => ctx.helpers.getFunctionAsm(t)));
    const dossiers = await Promise.all(targets.map(t => ctx.helpers.createUnitDossier(t)));
    return ctx.helpers.render("match", { targets, asm, dossiers });
  },

  reprompt: async (targets, ctx, lastTurn) => {
    const results = await ctx.helpers.runBatchCycle(targets);   // BatchCycleResult[]
    return {
      accepted: results.filter(r => r.accepted).map(r => r.target),
      rejected: results.filter(r => !r.accepted).map(r => r.target),
      feedback: results.map(r => `# ${r.targetId} — ${r.status}`).join("\n"),
    };
  },
});
```

---

## 3. `ctx.helpers` — the extensible toolbox

`ctx.helpers: WorkflowHelpers & H`.

```ts
// core:
export interface WorkflowHelpers {
  select(selector: Selector): Promise<WorkItem[]>;
  render(template: string, ctx: Record<string, unknown>): string;
  emit(type: string, data: unknown): Promise<number>;
  log(level: string, msg: string): void;
  store: ReadonlyStore;   // read-only view (query only — NO execute/transaction)
}

// adapter:
declare module "decompi" {
  interface WorkflowHelpers {
    getFunctionAsm(target: FunctionWorkItem): Promise<string>;
    runBatchCycle(targets: FunctionWorkItem[]): Promise<BatchCycleResult[]>;
  }
}
```

- **Two mechanisms**: adapter module-augments `WorkflowHelpers` (adapter-wide);
  workflow `helpers?: H` (local, inferred, shadows global — shadowing is
  last-wins, detected at `addWorkflow` and logged, not an error).
- `declare module "decompi"` requires a package.json `exports` self-reference
  (§8 task) — without it, augmentation silently fails to attach (TS2664).
- `store` is a **read-only** surface (`ReadonlyStore = Pick<SqlAdapter, "query">`);
  hooks cannot reach `execute`/`transaction`, preserving single-writer discipline.

`ctx` = `WorkflowCtx<K, H>`: `{ targets, runtime, select, store, log, lastTurn,
scope, helpers, finalize }` — **`finalize(target, action)` is the writer
primitive** (distinct from the `complete` *hook*, which is the decider).

---

## 4. The engine contract — the `agentLoop` primitive

`Workflow.compile()` emits a Pipeline whose body is:

```ts
{ kind: "agentLoop"; start; reprompt; rejectionRetries?; routes?; model?; tools? }
```

The engine owns the model call and holds the `AgentSession` across turns:

```
foreach (batch = defaultBatchSize):
  agentLoop (inPlay = batch):
    turn:  session = runtime.createSession(model, start(inPlay, ctx))
           loop:
             out = session.prompt(prompt)          ← wrapped runtime (pacing/budget/pause per turn)
             verdict = reprompt(inPlay, ctx, out)
             inPlay = inPlay − verdict.accepted   // rejected + absent items STAY in play (fed back next turn)
             accepted ∪= verdict.accepted  (finalize each)
             if inPlay empty                        → done
             if verdict.final || turns >= rejectionRetries → route inPlay via onReject
             else prompt = verdict.feedback; turns++  → continue
```

**Turn semantics (explicit):** the hook receives the *still-in-play* set each
turn (not the original batch); **only `accepted` items are removed** — `rejected`
and absent items both stay in play for the next turn (the `feedback` string
describes the rejected items so the model knows what to fix).

**The engine is the acceptance writer.** On `accepted`, the engine calls
`ctx.finalize(target, action)` where `action = await complete?.(target) ?? {promote:true}`.
`finalize` (a daemon transition, §5.3) runs ONE transaction:
`INSERT OR IGNORE workflow_completions (wf, unit-of-target, target)` +
the `CompletionAction` write (`promote:true` → `lifecycle=accepted` +
`status`/`evidence`) + a `target-accepted` event on the daemon's event path.
`INSERT OR IGNORE` makes it idempotent (a manual complete racing mid-run, or a
stable accepted item, does not double-finalize). A `complete()` throw aborts the
transaction (row rolled back) and fails the run.

**Prompt system**: `startPrompt` returns a user prompt string; the engine still
appends the adapter style guide (loaded + hashed) and records the prompt id
(`sha256(template="workflow", styleGuideHash, hash(startPromptOutput))`) for
`spans.prompt_id` replay — the workflow does not bypass the style-guide hash.

**Compilation map:**

| Workflow | Pipeline |
|---|---|
| `accepts: K` + `select` | `plan()` = `{ kind: [K], ...select }` ∩ `scope` − `isComplete(wf, ·)` |
| `canBatch` / `defaultBatchSize` | `foreach.batch` |
| `startPrompt` / `reprompt` | `agentLoop` |
| `routes` | `onReject` → compiled self-fragments (singleton = agentLoop batch 1) |
| `complete` | decider; `ctx.finalize` executes the action |

**No `lifecycle` exclusion in `plan()`.** Completion is per-workflow; the global
`lifecycle` is not consulted (an item accepted by workflow A remains selectable
by workflow B — the `fakematch-detect`/`recertify` shape). The completion-row
subtraction is the only per-workflow guard; `uncomplete` removes the row and
the item becomes re-selectable.

---

## 5. Workflow completion

### 5.1 Schema

```sql
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
```

- `(wf, U, '')` unit-scoped · `(wf, '', T)` target-scoped · `(wf, U, T)` precise.
- Run-time finalize writes the **precise** form `(wf, unit-of-target, target)` so
  `uncomplete --target T` reliably removes it.
- `isComplete(wf, target)` = `(wf, target)` **or** `(wf, unit-of-target)`.

### 5.2 Semantics

`complete?(target, ctx)` (hook) returns a `CompletionAction`; `ctx.finalize`
(writer) persists it transactionally. Run-time default is `promote:true`;
manual CLI completion defaults to `promote:false`.

### 5.3 Daemon transition

`StoreDaemon.finalizeWorkflowItem({workflowId, target, action, actor})` —
single transaction: completion row (insert-or-ignore) + lifecycle/status/evidence
+ event. This is the only writer; hooks get the read-only `store` only.

### 5.4 CLI / API

```
decompi workflow complete <wf> --target <id> | --unit <id> [--reason …]
decompi workflow uncomplete <wf> --target <id> | --unit <id>
decompi workflow status <wf> [--unit <id>]
POST   /api/workflows/:id/completions   { targetId?, unitId?, reason }
DELETE /api/workflows/:id/completions   { targetId?, unitId? }
```

---

## 6. Run scope (feature 2)

- `Selector.filter.ids?: string[]` added; `filter.unit` exists.
- `RunSpec.scope?: { targetIds?: string[]; unitIds?: string[] }` — **intersect**.
- **Persistence**: `scope` is folded into the persisted `runs.selector`
  (`targetIds → filter.ids`, `unitIds → filter.unit`) so a restarted run keeps
  its scope. Both `targetIds` and `unitIds` given = **AND** (unit filter AND id
  filter). CLI `--target` is repeatable.

---

## 7. The `Decompi` facade

```ts
class Decompi {
  addWorkflow(w: Workflow): void;   // compile + register + record kind (bivariant, no `any`)
  addHelper<K extends keyof WorkflowHelpers>(name: K, fn: WorkflowHelpers[K]): void;
  run(spec: RunSpec): Promise<string>;
  select(selector: Selector): Promise<WorkItem[]>;
  workflow(id: string): Workflow | undefined;
}
export const Decompi: Decompi;
```

---

## 8. Task breakdown

1. `package.json` — add `exports` (`.`) + `types` self-reference so
   `declare module "decompi"` resolves (prerequisite for the typing).
2. `src/workflow/helpers.ts` — `WorkflowHelpers` + `WorkItemKindMap` + built-ins +
   `ReadonlyStore` + helper registry.
3. `src/workflow/types.ts` — `Workflow` (const K/H), `WorkflowDef`, `WorkflowCtx`,
   `RepromptVerdict`, `CompletionAction`, `WorkItemOf`.
4. `src/workflow/compile.ts` — `Workflow.compile()` → Pipeline.
5. `src/pipeline/engine.ts` — add `agentLoop` (session-holding, turn semantics,
   finalize-on-accept, routes) + `RunContext.store`/`finalize` handles.
6. `src/core/daemon.ts` — add `finalizeWorkflowItem` transition (transactional).
7. `src/workflow/completions.ts` — `WorkflowCompletionStore`.
8. `src/workflow/scope.ts` — `RunSpec.scope` intersect + `filter.ids` + persistence.
9. `src/workflow/facade.ts` — `Decompi`.
10. CLI + API wiring (`run --target/--unit`, `workflow complete/uncomplete/status`,
    `/api/workflows/:id/completions`, `/api/runs` scope).
11. Adapter: `registerHelpers()` + xenoblade `WorkflowHelpers`/`WorkItemKindMap`.
12. Tests: `basicMatchWorkflow` end-to-end (MockAgentRuntime + fake diff), plus a
    compile-time narrowing check.

---

## 9. Open questions

- Multi-kind `accepts` (union) — deferred.
- `timeoutRetries` — removed until the §11 silence watchdog exists; re-add then.
- `targetIds`+`unitIds` both given = AND (decided in §6); revisit if OR is wanted.
