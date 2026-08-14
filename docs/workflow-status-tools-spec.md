# Decompi — Workflow Status Ladder + Agent Tools — Spec (rev 2)

> **rev 2** — incorporates review (`docs/reviews/status-tools-consolidated.md`):
> Migration v1 for the shipped table; ladder-less default `["DONE"]`;
> resolve-then-test status precedence; `completionStatus` threaded to finalize;
> `tools` (allowlist) vs `customTools` (definitions) split; reserved `finish`;
> zod-typed `Tool<S>`; per-`prompt()` pacing; `finish` drain ordering; Mock script.

---

## A. Workflow status ladder

### A.1 Workflow declaration

```ts
export interface WorkflowDef<K, H> {
  // … existing …
  /** The workflow's own status ladder. Default: ["DONE"]. */
  statuses?: string[];        // default ["DONE"]
  /** Which statuses count as "done" (plan skips). Default: [last status]. */
  doneStatuses?: string[];    // default [statuses.at(-1)]
  /** Status written by run-time acceptance finalize. Default: statuses.at(-1). */
  completionStatus?: string;
}
```

### A.2 Schema (migration v1)

- **Migration v1** (a real `Migration` entry registered at the `migrate([])`
  call sites), NOT an in-place schema edit:
  1. `CREATE TABLE workflow_status (workflow_id, unit_id, target_id, status,
     updated_at, actor, reason, UNIQUE(workflow_id, unit_id, target_id))` with
     `unit_id`/`target_id TEXT NOT NULL DEFAULT ''`.
  2. Backfill from `workflow_completions`: `status := 'DONE'`, `updated_at :=
     completed_at`, actor/reason copied.
  3. Drop `workflow_completions` (or retain read-only — decide: **drop**, since
     the store is the single writer and v1 is immediately after v0).
- Fresh DBs get `workflow_status` via the v0 DDL + v1 migration (idempotent: v1
  guards `CREATE TABLE IF NOT EXISTS` / checks `schema_migrations`).

### A.3 Status resolution (resolve-then-test, not OR)

```
resolveStatus(wf, target) = row (wf, unit=target.unit, target=target.id)
                        else row (wf, unit='', target=target.id)
                        else row (wf, unit=target.unit, target='')
isDone(wf, target) = resolveStatus(wf, target)?.status ∈ doneStatuses
```

- Three exact-unique probes against the UNIQUE key (or one indexed query with
  app-side specificity ordering). "Target wins" = the more-specific row resolves
  first, never an OR that lets a LINTED unit hide a re-broken target.

### A.4 Store, engine, finalize

- `WorkflowStatusStore`: `setStatus`, `resolveStatus`, `list`, `isDone`.
- `ctx.finalize(target, { status })` / `StoreDaemon.finalizeWorkflowItem` upsert
  the resolved row; default status = `completionStatus` (threaded on the compiled
  `agentLoop` step / into the daemon). The engine **calls `complete?.(target)`**
  (fixing the shipped bypass) and finalizes with its `CompletionAction.status`.
- Emit `target-status` event on **status change** (from→to); same-status
  re-finalize = no event.

### A.5 CLI

```
decompi workflow set    <wf> <status> --unit <id> | --target <id> [--reason …]
decompi workflow status <wf> [--unit <id> | --target <id>]
```

---

## B. Agent tools

### B.1 Provisioning (three layers, reserved names)

A session's toolset = **core built-ins + adapter tools + workflow tools**, merged
with workflow > adapter > core precedence **except** reserved names: `finish`,
`select`, `status`, `lint` are **core-reserved** — a workflow/adapter declaring
the same name is a compile-time/`addWorkflow`-time error.

- **Core built-ins**: `select`, `status`, `lint`, `finish`.
- **Adapter tools**: `hexdiff`, `build`, `size`, `symbols`, `asm` (wired to the
  real helpers). Adapter declares via `registerTools()`.
- **Workflow tools**: `WorkflowDef.customTools`.

Judge sessions (`ctx.StartJsonAgent`) get **no** tools (they are single-JSON
calls).

### B.2 Tool type (zod-typed, allowlist split)

```ts
export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;                       // zod schema → JSON schema for the SDK
  run(ctx: WorkflowCtx<WorkItemKind, Record<string, unknown>>, args: z.infer<S>): Promise<unknown>;
}

// AgentRuntime.createSession({ model, prompt, tools?: string[], customTools?: Tool[] })
// `tools` = NAME allowlist (unchanged shipped meaning); `customTools` = definitions.
// WorkflowDef.customTools?: Tool[];  (compiled onto the agentLoop step's customTools)
```

- `Tool<S>` is typed (args = `z.infer<S>`), consistent with `StartJsonAgent`.
- The pi adapter maps `Tool` → pi's `defineTool` (TypeBox `parameters` from the
  zod schema; `execute` returns content blocks; throw → tool-error result).

### B.3 `AgentSession` tool-call loop

```ts
interface AgentSession {
  /** One agentic turn: the model may make 0+ tool calls; the harness/session runs
   *  each handler and feeds the result back until the model emits a final answer.
   *  Returns the final result; usage is CUMULATIVE across the turn. */
  prompt(text: string): Promise<AgentResult>;
}
```

- Pacing + budget are **per `prompt()` turn** (the loop lives inside one turn;
  the pi adapter aggregates all sub-request usage into `AgentResult.usage`).
- Note: the pi SDK's native `prompt()` returns `void` and streams events; the
  adapter reconciles the event stream into `AgentResult` (final text + cumulative
  usage). This is an adapter concern, not an engine change.

### B.4 Built-in `finish` tool + drain ordering

- `finish(targetIds: string[])` — engine-owned handler recording ids into per-turn
  state.
- **Drain order**: after EVERY `prompt()` (including the `final` write-only turn),
  the engine unions `finished` ids into `accepted` (finalizing with
  `completionStatus`), removes them from `inPlay`, and THEN runs the empty/final/
  cap checks. Unknown ids are logged and ignored. `finish` behaves identically in
  routed fragments (they reuse the compiled loop).

### B.5 Mock scripted-tool-call hook

`MockSession` holds a FIFO script of `{type:'tool', name, args} | {type:'reply',
text}` entries. `prompt()` consumes entries until a `reply`: each `tool` entry
invokes the registered handler synchronously (result recorded into the call log);
the `reply` text becomes `finalText`. This makes `finish` deterministically
testable.

---

## C. Task breakdown

1. Migration v1 (rename + backfill + drop) registered at all `migrate([])` sites.
2. `src/workflow/status.ts` — `WorkflowStatusStore` (setStatus/resolveStatus/isDone/list),
   replacing `WorkflowCompletionStore`; CLI/API migrated to `workflow set/status`.
3. `src/workflow/types.ts` — `statuses`/`doneStatuses`/`completionStatus`,
   `customTools?: Tool<S>[]`, `CompletionAction.status`, `Tool<S>`.
4. `src/core/daemon.ts` — `finalizeWorkflowItem` sets the resolved status (upsert),
   emits on status change.
5. `src/agent/runtime.ts` + `mock.ts` — `createSession({ tools, customTools })`;
   `prompt()` runs the loop (cumulative usage); Mock script hook.
6. `src/pipeline/engine.ts` — `agentLoop` calls `complete?`, drains `finish` after
   each prompt, finalizes with `completionStatus`; core tools + `finish` reserved.
7. `src/workflow/compile.ts` — compile statuses/customTools/completionStatus; plan
   subtracts `isDone`.
8. Tests.

---

## D. Open questions

- Drop vs retain `workflow_completions` after migration — assumed drop.
- `finish` with no args (finish all remaining) — assumed explicit ids, empty = no-op.
- `completionStatus` per-workflow vs per-run override — assume per-workflow for now.
