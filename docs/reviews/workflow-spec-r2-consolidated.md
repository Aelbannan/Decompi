# Workflow Authoring API — Round 2 Consolidated

kimi-k3 + glm-5.2 (high). Verdict: **BLOCKED** (structural, not typing).

## Typing core: FIXED (proven)
`const K/H` narrowing, `WorkItemKindMap`, generic `addHelper`, bivariant
`addWorkflow` all verified by actually compiling the example + negatives.

## Remaining blockers (converged)

1. **Drop the `lifecycle IN (accepted,rejected)` plan exclusion.** Lifecycle is
   global; it breaks multi-workflow flows (fakematch-detect/recertify operate on
   already-accepted items) and makes `uncomplete` inert. Completion-row
   subtraction is the only per-workflow guard.
2. **Specify the acceptance writer's write path.** RunContext needs a store/daemon
   handle; the daemon needs a `finalizeWorkflowItem` transition; completion-row +
   lifecycle write must be ONE transaction; idempotent via `insertIgnore`; define
   the row form `(wf, unit-of-target, target)`.
3. **Define `agentLoop` turn semantics.** Targets narrow to the still-in-play set
   each turn; items absent from a verdict stay in play; accepted items are
   removed from play (no double-finalization).
4. **`timeoutRetries` is dead config** (the watchdog isn't built) — remove it;
   re-add with the §11 silence watchdog.
5. **Scope must survive restart** — fold `scope` into the persisted selector
   (`targetIds→filter.ids`, `unitIds→filter.unit`).
6. **Prompt-system bypass** — `startPrompt` returns a raw string, skipping
   PromptBuilder/style-guide hashing. Specify the engine's hash/id story for
   hook-built strings (or require a `PromptSpec`).
7. **No selector surface on `WorkflowDef`** — add `select?: {filter, sort, limit}`
   so workflows express status/sort/limit (the builtin match's NOT_STARTED+size+limit).
8. **`declare module "decompi"` needs a package.json `exports` self-reference** —
   currently absent (TS2664). Add a task.

## MEDIUM/LOW
- `ctx.helpers.store` must be a read-only type, not `SqlAdapter` (hooks would
  otherwise get arbitrary SQL write access, voiding single-writer).
- Two `complete`s collide: rename the writer primitive to `ctx.finalize`,
  distinct from the `complete` hook (the decider).
- Example inconsistency: `runBatchCycle` returns an array, not a singular result.
- `targetIds`+`unitIds` both given: AND or OR (say it); `--target` repeatable.
- Route `when` should include the `attempts` predicate; `agentLoop` should carry
  `model`/`tools` like the `agent` step.
- Fragment registration for compiled routes unstated.
- §9 stale "hook vs policy" question (already answered by §5.2).
