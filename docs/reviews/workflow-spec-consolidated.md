# Workflow Authoring API — Consolidated Review

kimi-k3 + glm-5.2, both high thinking. Verdict: **BLOCKED** (typing + engine
contract). Findings deduplicated; **[converged]** = both found it.

## CRITICAL

1. **`reprompt` does not map to the existing `verify` step.** **[converged]**
   `verify` is per-item (`Verifier.verify(item)`), `reprompt` is per-batch
   (`(targets, ctx) => {accepted, rejected}`). `agent` creates+dismisses the
   session before the next step; there is no continuation surface. → Requires a
   **new `agentLoop` step kind** (session-holding, per-batch, cap-aware), not a
   composition of `agent`+`verify`. The §4 compilation map is wrong as written.

2. **`UNIQUE(workflow_id, unit_id, target_id)` is a no-op for the two primary
   row forms.** NULLs are distinct under SQLite UNIQUE, so `(wf,U,NULL)` and
   `(wf,NULL,T)` insert unlimited duplicates. → `unit_id`/`target_id` `NOT NULL
   DEFAULT ''` (or partial unique indexes).

3. **Acceptance finalization has no writer.** `reprompt`-accepted items never
   touch lifecycle/status/events; default `complete() = {promote:false}` means
   auto-accepted items are re-planned forever. → The engine is the writer: on
   accept, write a `workflow_completions` row + execute the `CompletionAction`
   (promote → lifecycle accepted + status/evidence + event) through the daemon
   path; run-time acceptance defaults to `promote:true`.

## HIGH

4. **`new Workflow({accepts:"function"})` infers K=`string`, not `"function"`.**
   **[converged — the user's top priority]** TS widens object-literal property
   inference unless the type param is `const`. As declared, `targets` is
   `WorkItem[]`, no narrowing, and `ctx.helpers.getFunctionAsm(t)` doesn't
   typecheck. → `class Workflow<const K, const H>` (TS 5.0+) or a factory fn.

5. **`WorkItemOf<K> = WorkItem & {kind:K}` narrows nothing but the literal.**
   No function-specific members; nothing binds `"function"` to an adapter type.
   → declaration-merged `WorkItemKindMap` (core `interface WorkItemKindMap {}`,
   adapters augment `{ function: FunctionWorkItem }`).

6. **`addHelper(name:string, fn:(...a:any[])=>unknown)` leaks `any`; the
   "type-error at registration" claim is impossible.** → generic
   `addHelper<K extends keyof WorkflowHelpers>(name:K, fn:WorkflowHelpers[K])`.

7. **Three competing helper mechanisms (module augmentation + `addHelper` +
   per-workflow `helpers`), no precedence, global leakage.** → local
   `helpers?: H` is primary for user helpers; adapter module-augments
   `WorkflowHelpers` for adapter-wide helpers; local shadows global; drop the
   duplicated user-augmentation block.

8. **`rejectionRetries`/`timeoutRetries` have no config surface.** → add to
   `WorkflowDef` (+ per-run override).

9. **Auto `onReject` has no configurability — bakes model names into core.** →
   `routes`/`retryPolicy` on `WorkflowDef` (sizeBelow/model/maxAttempts).

## MEDIUM / LOW

- `WorkflowDef` typing of `RepromptVerdict`/`CompletionAction` should be
  `WorkItemOf<K>` not bare `WorkItem`.
- `Decompi` facade singleton + `addWorkflow` erases K/H at the boundary — use
  method-bivariance (method-syntax hooks) so `addWorkflow(w: Workflow)` works.
- Module augmentation inside the same repo needs a package self-name reference
  (`declare module "decompi"` resolves via package.json `name`+`exports`).
- Multi-kind `accepts` (union) is an open extension.

## Sound

Hook-based authoring over the step engine · engine-owns-the-model-call ·
`ctx.helpers` toolbox · completion table with both unit+target ids ·
scope-intersect · the overall shape.
