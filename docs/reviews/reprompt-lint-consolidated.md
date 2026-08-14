# Dynamic Reprompt + Linter — Consolidated Review

kimi-k3 + glm-5.2 (high). Verdict: **BLOCKED**.

## CRITICAL (converged)

1. **`RepromptVerdict.model` is unimplementable.** The `agentLoop` holds ONE
   `AgentSession` bound to one model; there's no mid-loop model swap, and §A.5
   never even wires `model`. Escalation needs a fresh session + transcript replay
   (no such API). → **drop `model` from the verdict**; escalation goes through
   `routes` (already model-parameterized per fragment).
2. **`setup` has no reach.** The compiler emits a static `foreach`; there's no
   `setup` field on `Step`/`foreach`/`agentLoop`, and `batchSize` re-bucketing is
   incoherent with the engine's up-front partition. → `setup` becomes a field on
   the compiled `foreach` (runs per batch before agentLoop; `batchSize` only
   sub-divides, spillover joins the next batch).
3. **`ctx.helpers` is never materialized** — `forwardCtx` casts a hole; every
   `ctx.helpers.*` / `ctx.StartJsonAgent` call throws at runtime. This is a bug
   in the SHIPPED workflow implementation, not just the new spec. → fix
   `forwardCtx` to merge built-in + adapter + local helpers before forwarding.

## HIGH (converged)

4. **`ctx.StartJsonAgent` has no home + no pacing identity.** Not on
   `WorkflowCtx`/`StepCtx`; the "wrapped runtime" (pacing/budget/pause) is
   claimed but not actually present in the engine's `agentLoop` (it calls
   `session.prompt` directly). → type it on ctx; implement the wrapped runtime.
5. **`JsonShape<T>` doesn't constrain T** (the `{shouldContinue:"boolean"}` object
   is a non-inferring DSL). → zod-style `StartJsonAgent<S extends ZodType>(model,
   prompt, input, schema: S): Promise<z.infer<S>>`.
6. **`final:true`+feedback = an unobserved final turn** (response discarded),
   and the pseudocode has a double-route on `final`∧`cap`. → document the final
   turn is write-only (delivered + logged, response discarded), route once.

## MEDIUM
- `setup.model` vs route-fragment `model` precedence; setup re-runs in fragments.
- `setup.batchSize < 1` validation at the setup boundary.
- Linter rule: needs wiring into `lintFile` (placeholder patterns currently feed
  ONLY the delta gate), `SMELL_METRICS` stance, string→RegExp compilation,
  `#undef` matching semantics.

## Implementation fix required (existing code, independent of the new spec)
`src/workflow/compile.ts` `forwardCtx` must materialize `ctx.helpers`
(built-ins + adapter + local) and `ctx.store`; `agentLoop`'s `session.prompt`
must route through the wrapped runtime (pacing/budget/pause) that `run.ts`
provides for `agent` steps but the `agentLoop` currently bypasses.
