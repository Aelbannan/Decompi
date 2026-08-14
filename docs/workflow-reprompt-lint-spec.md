# Decompi — Dynamic Reprompt Policy + Linter Anti-Pattern — Spec (rev 3)

> **rev 3** — incorporates review (`docs/reviews/reprompt-lint-consolidated.md`):
> dropped `RepromptVerdict.model` (unimplementable — escalation via `routes`);
> `setup` is now a field on the compiled `foreach` (per-batch, sub-divide only);
> `ctx.StartJsonAgent` is zod-typed; `final`+feedback is a documented write-only
> turn with single routing; linter wiring specified; plus a required fix to the
> shipped workflow impl (ctx.helpers materialization + wrapped runtime).

---

## A. Dynamic reprompt policy

### A.1 `setup` — per-batch config (compiled `foreach` field)

```ts
export interface WorkflowConfig {
  rejectionRetries?: number;
  batchSize?: number;   // >=1; may only SUB-DIVIDE the current batch (spillover → next batch)
  model?: string;
}
```

- `setup?(targets, ctx): Promise<WorkflowConfig>` is a `WorkflowDef` field.
- The **compiled shape** is: `foreach` gains a `setup?` field; the engine runs
  `setup(batch, ctx)` **once per batch, before the `agentLoop`**.
- `batchSize` (integer >= 1) may only sub-divide the current batch. Queue
  semantics: the engine draws up to `batch` items from the front of the batch
  queue as the current batch; if `setup.batchSize` < current batch, the first
  `m` items are processed this iteration and the excess is pushed back on the
  front of the queue (so the next drawn window ≤ the static `batch`, and each
  processed batch is setup-evaluated once). Order/grouping is never re-shuffled;
  only window sizes vary, monotonically ≤ `batch`. (`key` grouping is not used by
  compiled workflows — `compileWorkflow` never sets `key` — so key+spillover
  interaction is out of scope for now.)
- Precedence (agentLoop model): `setup.model` > route-fragment `model` (the
  fragment's `ctx.model`) > run `defaultModel`. (Compiled workflows never set a
  `step.model`, so the engine's step-vs-ctx resolution is moot for them.) `setup`
  **re-runs inside route fragments** (fragments reuse the compiled loop, so
  "per-batch" includes fragment batches).
- `setup.batchSize < 1` is validated at the setup boundary and attributed to the
  workflow (typed config error), not an engine crash.
- Inputs: `target.size`, `target.attempts`, `target.status`, `target.meta`, and
  adapter helpers (e.g. `ctx.helpers.estimateDifficulty(target)` — declared via
  adapter module augmentation).

### A.2 `ctx.StartJsonAgent` — a separate stateless judge agent

```ts
// On WorkflowCtx. zod-typed so T is inferred from the schema (no `any`).
ctx.StartJsonAgent<S extends z.ZodType>(
  model: string,        // models.json slug (judge model, per-call)
  prompt: string,
  input: unknown,       // the context: last response + progress/verdict
  schema: S,
): Promise<z.infer<S>>;
```

- **The judge is a completely separate agent**, started fresh on each call:
  `createSession(model)` → ONE prompt fed with the last response + progress
  (`input`) → returns a JSON decision → **closed**. It is not held across turns
  and does not share the `agentLoop`'s session — a stateless side-channel.
- Model is a parameter (separate cheap judge model, chosen per call).
- **Counted**: each judge call is a model turn — it goes through the same wrapped
  runtime as `agent` steps (pacing, budget pre-check, pause checkpoint) and
  charges the run budget. (Requires the wrapped runtime to wrap `agentLoop`
  turns — see §D.)
- **Stateless**: the judge remembers nothing between turns; the workflow must
  pass everything it needs (last response + progress, and optionally prior judge
  decisions) in `input`.
- **Failure**: non-JSON or schema-invalid output → retry once, then throw a typed
  `JudgeError` the workflow catches. Each attempt is paced + charged.

### A.3 `reprompt` verdict

```ts
export interface RepromptVerdict<K> {
  accepted: WorkItemOf<K>[];
  rejected: WorkItemOf<K>[];
  feedback?: string;
  final?: boolean;   // "wrap it up": one write-only turn, then route (no model field)
}
```

- `final:false` (default): re-prompt with `feedback`.
- `final:true`: the engine sends `feedback` as **one final, write-only prompt**
  (delivered + logged for span completeness; the response is NOT re-evaluated),
  then routes whatever remains to `onReject`. Documented as write-only.
- **No `model` field** — mid-loop model escalation is out of scope (a held
  session is model-bound); escalation is expressed via `routes` fragments.

### A.4 Judge example (shape)

```ts
const JudgeOut = z.object({ shouldContinue: z.boolean(), message: z.string() });

reprompt: async (targets, ctx, lastTurn) => {
  const results = await ctx.helpers.runBatchCycle(targets);
  const j = await ctx.StartJsonAgent("nube-ds4-flash-low",
    "Is this batch converging, or going in circles?", results, JudgeOut);
  if (!j.shouldContinue) {
    return { accepted: [], rejected: targets, final: true,
             feedback: j.message ?? "Wrap it up — you're going in circles." };
  }
  return {
    accepted: results.filter(r => r.accepted).map(r => r.target),
    rejected: results.filter(r => !r.accepted).map(r => r.target),
    feedback: results.map(r => `# ${r.targetId} — ${r.status}`).join("\n"),
  };
},
```

### A.5 `agentLoop` integration

```
foreach (batch):
  cfg = setup?(batch, ctx) ?? {}
  agentLoop (retries = cfg.rejectionRetries ?? def.rejectionRetries ?? 1):
    inPlay = batch
    loop:
      out = session.prompt(prompt)       ← wrapped runtime (pacing/budget/pause)
      verdict = reprompt(inPlay, ctx, out)   ← hook may call ctx.StartJsonAgent
      inPlay = inPlay − verdict.accepted
      accepted ∪= verdict.accepted (finalize each)
      if inPlay empty → done
      if verdict.final:
          if verdict.feedback → session.prompt(feedback)   // write-only "wrap it up"
          done (return rejected = inPlay)                  // the ENCLOSING foreach routes via onReject
      if turns >= retries → done (return rejected = inPlay)
      else prompt = verdict.feedback; turns++
```

Routing happens at the **foreach** level (the agentLoop returns
`{accepted, rejected}`; `runForeachStep` routes the rejected via `onReject`).
The agentLoop itself never routes — single routing is guaranteed by that
return-once/route-once boundary.

---

## B. Linter rule: `smell.define_rename_alias`

- **id**: `smell.define_rename_alias` (whole-file CST; `preproc_def`/`preproc_undef`/
  `preproc_include`).
- **Wiring**: the rule is a factory `makeDefineRenameAliasRule(patterns:
  {function,label,data}: RegExp[])` registered in `smellRules`; `lintFile` injects
  `cfg.placeholderPatterns` **compiled string→RegExp** (the adapter declares them
  as strings; `lintFile` compiles). This is a registry change — today
  `placeholderPatterns` feed only the delta gate.
- **Detection**: `preproc_def` whose name matches a placeholder pattern AND whose
  replacement is a non-placeholder identifier → one finding per `#define`;
  annotated as an alias block when a matching `preproc_undef` (same name,
  anywhere in file) exists.
- **Non-goals**: placeholder→placeholder aliases (incl. cross-family
  `func_`↔`lbl_`); plain `#define`/`#undef` with no placeholder name.
- **Metric stance**: counted in `decompi report` but NOT in the `report --check`
  regression gate initially (flag-only; add to `SMELL_METRICS` later if desired).

---

## C. Reference examples (`examples/`)

1. `basic-match.ts` — NOT_STARTED functions; foreach batch 5; routes size-route to
   rebatch (cheap) / singleton (hard, batch 1).
2. `tu-final.ts` — `unitComplete` trigger; accepts object/label (data); data-match
   agentLoop + cleanup agentLoop (linter feedback).
3. `tu-prepass.ts` — `setup` runs `ctx.helpers.structLayout(unit)` (wraps
   `struct_layout.py`-style tooling) → header scaffolding agentLoop.
4. `fakematch-detect.ts` — FULL_MATCH/EQUIVALENT_MATCH; verify emits flag events.
5. `judge-adaptive-match.ts` — basic-match + the §A.4 judge (stop-early / wrap-up).

Helpers (`getFunctionAsm`, `runBatchCycle`, `structLayout`, `estimateDifficulty`)
are adapter-augmented `WorkflowHelpers`; stubbed in the examples.

---

## D. Task breakdown

0. **Fix the shipped workflow impl** (independent of this spec): `compile.ts`
   `forwardCtx` must materialize `ctx.helpers` (built-ins + adapter + local,
   local-wins) and `ctx.store`. Note: `agentLoop` already routes its turns through
   the guarded runtime (it creates sessions via `ctx.runtime`, the same
   pacing/budget-wrapped runtime as `agent` steps) — no engine change needed
   there. "Pause" is not yet a real mechanism (run.ts has pacing + budget, no
   pause checkpoint); treat pause checkpoints as future work, not a task-0 item.
1. `src/workflow/types.ts` — `WorkflowConfig`, `setup?`, `ctx.StartJsonAgent`
   (zod-typed), drop `RepromptVerdict.model`.
2. `src/pipeline/types.ts` + `engine.ts` — `foreach.setup`, per-batch setup run,
   `final` write-only turn + single routing, `StartJsonAgent` via wrapped runtime.
3. `src/parse/cpp/rules/smell.ts` + `registry.ts` — `makeDefineRenameAliasRule`,
   `lintFile` injects compiled patterns.
4. `examples/` — the five workflows.
5. Tests: setup sub-divide + precedence; StartJsonAgent zod inference + failure;
   final write-only turn; linter per-`#define`.

---

## E. Open questions

- zod as a dependency (currently not in package.json) vs a tiny in-house schema
  type? (assume zod — it also serves `StartJsonAgent` validation.)
- Should the final write-only turn count against `rejectionRetries`? (assume no —
  it's a terminal turn, but it is a real model call that charges budget.)
