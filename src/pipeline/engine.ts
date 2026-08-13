/**
 * Pipeline engine (SPEC §10): registers pipelines and steps-only fragments and
 * executes `plan()` + `steps` with this model:
 *
 *  - bare `steps` run once per run against the items produced by `plan()`;
 *  - `foreach` groups its items (by `key` first when set: "unit"/"status"/…)
 *    into batches of `batch` and runs its child `steps` once PER batch (one
 *    agent session per batch — v1's `batchSize`); `foreach.from` pulls the
 *    items from a `select`-produced binding (default: current scope items);
 *  - `verify` looks up `verifiers.get(name)` and splits items into
 *    accepted (finalized) / rejected (still in play: the next step sees them);
 *  - `gate` false aborts the CURRENT scope: remaining steps are skipped and
 *    the scope's items surface in the run outcome as `skipped` (they are
 *    never routed through `onReject` — a gate is a skip, not a failure);
 *  - `onReject` evaluates the ordered routes' `when` predicates per rejected
 *    item and routes it to a steps-only fragment (registered via
 *    `registerFragment`), run under the route's `model` with a per-item
 *    `maxAttempts` budget (items past the cap stay rejected); items matching
 *    no route stay rejected. Route graphs must be acyclic — a route whose
 *    target is (transitively) an ancestor is rejected at register time.
 *
 * Item flow: after each step the scope's current items become the step's
 * rejected set (accepted items are finalized and never re-enter the scope).
 * `RunOutcome` reports three disjoint sets: `accepted` (verified by a
 * verifier), `rejected` (verify-failed / unroutable), `skipped` (gate-abort).
 * Lifecycle/status transitions are store-owned (M2); this engine partitions
 * items and lets verifiers set `status`/`evidence` themselves.
 */
import type { Selector, Verifier, WorkItem } from "../types.js";
import type { AgentResult, AgentRuntime, SessionUsage } from "../agent/runtime.js";
import { PromptBuilder, type PromptSpec } from "../prompt/builder.js";
import type { Pipeline, Route, Step, StepCtx, StepOutcome, Trigger } from "./types.js";

/** One executed agent turn: resolved model, final text, and token usage. */
export interface AgentTurn {
  model: string;
  text: string;
  usage: SessionUsage;
  /** sha256 of the injected style guide ("" when none); part of the prompt id (SPEC §12). */
  styleGuideHash: string;
}

/** Base context for a run (`ctx0` passed to `runPipeline`). */
export interface RunContext {
  runtime: AgentRuntime;
  /** Verifiers by id; accepts a Map, a Record, or an array (keyed by `Verifier.id`). */
  verifiers?: Map<string, Verifier> | Record<string, Verifier> | Verifier[];
  /** Default model for agent steps that do not override (a step/route `model` wins). */
  defaultModel: string;
  /** Resolve a `Selector` to WorkItems (store-backed in production; required by `plan`/`select` steps). */
  select?: (selector: Selector) => Promise<WorkItem[]>;
  /** Run logger; defaults to a no-op. */
  log?: (level: string, msg: string) => void;
  /** Adapter style guide (Markdown file); injected + hashed into every agent prompt (SPEC §12). */
  styleGuidePath?: string;
}

/** Terminal outcome of a run. `accepted`/`rejected`/`skipped` are disjoint. */
export interface RunOutcome {
  /** Items finalized by a verifier (or by a fragment's verifier). */
  accepted: WorkItem[];
  /** Verify-failed items that matched no route, or exhausted their route budget. */
  rejected: WorkItem[];
  /** Items whose scope was aborted by a `gate` (never routed through `onReject`). */
  skipped: WorkItem[];
}

/**
 * Identity helper: `definePipeline({...})` returns the same object typed as a
 * `Pipeline`. Pipeline files (`pipelines/*.ts`) export `definePipeline({...})`
 * so the engine gets a statically typed definition.
 */
export function definePipeline(pipeline: Pipeline): Pipeline {
  return pipeline;
}

/** Per-run mutable state (route budgets, shared bindings, last agent turn). */
interface RunState {
  runtime: AgentRuntime;
  verifiers: Map<string, Verifier>;
  select: (selector: Selector) => Promise<WorkItem[]>;
  bindings: Map<string, WorkItem[]>;
  log: (level: string, msg: string) => void;
  defaultModel: string;
  /** routeBudgetKey -> itemId -> routing count (route `maxAttempts` budget; key = `index:to`). */
  attempts: Map<string, Map<string, number>>;
  /** Adapter style guide (Markdown file) injected + hashed into agent prompts. */
  styleGuidePath?: string;
  /** Most recent agent turn in the run, shared across scopes (foreach/fragments). */
  lastAgentResult?: AgentTurn;
}

/** Engine-internal context: `StepCtx` + the scope's model + run state. */
interface RunCtx extends StepCtx {
  /** Model inherited by agent steps that do not set their own. */
  model: string;
  state: RunState;
  /** Most recent agent turn in this context (set by `agent` steps). */
  lastAgentResult?: AgentTurn;
}

/** Step execution result. `skipped` = gate-aborted items; `aborted` = a gate fired false. */
interface StepExec {
  accepted: WorkItem[];
  rejected: WorkItem[];
  skipped: WorkItem[];
  aborted: boolean;
}

/** Scope-level result: `rejected` = items in play at scope end, `skipped` = gate-aborted. */
interface ScopeResult {
  accepted: WorkItem[];
  rejected: WorkItem[];
  skipped: WorkItem[];
}

/** Fold any of the accepted `verifiers` shapes into a Map keyed by verifier id. */
function normalizeVerifiers(input: RunContext["verifiers"]): Map<string, Verifier> {
  const map = new Map<string, Verifier>();
  if (input === undefined) return map;
  if (input instanceof Map) {
    for (const [id, verifier] of input) map.set(id, verifier);
    return map;
  }
  if (Array.isArray(input)) {
    for (const verifier of input) map.set(verifier.id, verifier);
    return map;
  }
  for (const [id, verifier] of Object.entries(input)) map.set(id, verifier);
  return map;
}

const NOOP_LOG = (_level: string, _msg: string): void => {};

/** Append every `foreach.onReject[].to` reachable in `steps` (nested foreach included). */
function collectRouteTargets(steps: readonly Step[], out: string[]): void {
  for (const step of steps) {
    if (step.kind !== "foreach") continue;
    for (const route of step.onReject ?? []) out.push(route.to);
    collectRouteTargets(step.steps, out);
  }
}

function chunk(items: WorkItem[], size: number): WorkItem[][] {
  const out: WorkItem[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** The pipeline/fragment step executor (SPEC §10). */
export class PipelineEngine {
  private readonly pipelines = new Map<string, Pipeline>();
  private readonly fragments = new Map<string, Step[]>();
  /** Route-graph edges: nodeId -> route targets (nodes = pipeline + fragment ids). */
  private readonly routeTargets = new Map<string, string[]>();
  private readonly builder = new PromptBuilder();
  /**
   * Exactly-once unitComplete markers, keyed `pipelineId:unitId` (SPEC §10
   * "deduped per (unit, pipeline)"). In-memory for M3 — the durable marker
   * in the `events` table lands in M4. Entries are added BEFORE the target
   * run starts, so a trigger firing its own pipeline cannot re-enter.
   */
  private readonly firedTriggers = new Set<string>();

  /** Register a full pipeline (plan + steps) and validate its route graph. */
  registerPipeline(pipeline: Pipeline): this {
    if (!pipeline || typeof pipeline.id !== "string" || pipeline.id.length === 0) {
      throw new Error("registerPipeline: pipeline.id must be a non-empty string");
    }
    if (typeof pipeline.plan !== "function") {
      throw new Error(`registerPipeline(${pipeline.id}): plan must be a function`);
    }
    if (!Array.isArray(pipeline.steps)) {
      throw new Error(`registerPipeline(${pipeline.id}): steps must be an array`);
    }
    this.pipelines.set(pipeline.id, pipeline);
    const targets: string[] = [];
    collectRouteTargets(pipeline.steps, targets);
    this.routeTargets.set(pipeline.id, targets);
    this.rejectCycle(pipeline.id);
    return this;
  }

  /** Register a steps-only fragment (no `plan`) usable as an `onReject` route target. */
  registerFragment(id: string, steps: Step[]): this {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("registerFragment: id must be a non-empty string");
    }
    if (!Array.isArray(steps)) {
      throw new Error(`registerFragment(${id}): steps must be an array`);
    }
    this.fragments.set(id, steps);
    const targets: string[] = [];
    collectRouteTargets(steps, targets);
    this.routeTargets.set(id, targets);
    this.rejectCycle(id);
    return this;
  }

  /**
   * Run a registered pipeline: `plan()` produces the initial items, then
   * `steps` execute against them. Route attempt budgets are per-run.
   */
  async runPipeline(id: string, ctx0: RunContext): Promise<RunOutcome> {
    const pipeline = this.pipelines.get(id);
    if (!pipeline) throw new Error(`runPipeline: pipeline "${id}" is not registered`);
    const state: RunState = {
      runtime: ctx0.runtime,
      verifiers: normalizeVerifiers(ctx0.verifiers),
      select:
        ctx0.select ??
        (() => {
          throw new Error(
            "runPipeline: no select() provided in the run context (required by plan()/select steps)",
          );
        }),
      bindings: new Map(),
      log: ctx0.log ?? NOOP_LOG,
      defaultModel: ctx0.defaultModel,
      attempts: new Map(),
      ...(ctx0.styleGuidePath !== undefined ? { styleGuidePath: ctx0.styleGuidePath } : {}),
    };
    state.log("info", `run ${id}: start (model=${ctx0.defaultModel})`);
    const ctx = this.makeCtx(state, ctx0.defaultModel);
    const initial = await pipeline.plan(ctx);
    state.log("info", `run ${id}: plan produced ${initial.length} item(s)`);
    const res = await this.runScope(ctx, pipeline.steps, initial);
    state.log(
      "info",
      `run ${id}: done (accepted=${res.accepted.length} rejected=${res.rejected.length} skipped=${res.skipped.length})`,
    );
    const outcome: RunOutcome = {
      accepted: res.accepted,
      rejected: res.rejected,
      skipped: res.skipped,
    };
    await this.dispatchTriggers(pipeline, ctx0, outcome);
    return outcome;
  }

  // -- trigger dispatch (SPEC §10) --

  /**
   * Evaluate `unitComplete` triggers after a run: for every unit that reached
   * zero non-accepted items (every item the run saw from that unit is
   * accepted), run each unitComplete trigger's target pipeline once. Firing
   * is deduped per (pipeline, unit) by an in-memory set on the engine —
   * exactly-once per engine lifetime; the durable `events` marker lands in
   * M4. `runStart`/`runEnd` triggers are typed but not dispatched yet.
   */
  private async dispatchTriggers(
    pipeline: Pipeline,
    ctx0: RunContext,
    outcome: RunOutcome,
  ): Promise<void> {
    const triggers: Trigger[] = pipeline.triggers ?? [];
    const unitComplete = triggers.filter((t) => t.when === "unitComplete");
    if (unitComplete.length === 0) return;

    // Group the run's items by unit; a unit is complete when none of its
    // items is non-accepted (rejected or skipped). Items without a unitId are
    // outside the trigger's scope.
    const nonAccepted = new Map<string, number>();
    const units = new Set<string>();
    const all = [...outcome.accepted, ...outcome.rejected, ...outcome.skipped];
    for (const item of all) {
      if (!item.unitId) continue;
      units.add(item.unitId);
      if (outcome.rejected.includes(item) || outcome.skipped.includes(item)) {
        nonAccepted.set(item.unitId, (nonAccepted.get(item.unitId) ?? 0) + 1);
      }
    }

    for (const unitId of units) {
      if ((nonAccepted.get(unitId) ?? 0) > 0) continue; // unit not complete
      const key = `${pipeline.id}:${unitId}`;
      if (this.firedTriggers.has(key)) continue; // exactly-once per (pipeline, unit)
      this.firedTriggers.add(key);
      for (const trigger of unitComplete) {
        ctx0.log?.("info", `trigger: ${pipeline.id} unit ${unitId} complete -> ${trigger.to}`);
        await this.runPipeline(trigger.to, ctx0);
      }
    }
  }

  // -- cycle validation (route graphs must be acyclic, checked at register) --

  private rejectCycle(node: string): void {
    const cycle = this.findCycle(node);
    if (cycle) {
      throw new Error(
        `pipeline route cycle: ${cycle.join(" -> ")} (a route target may not be an ancestor of its source)`,
      );
    }
  }

  /** DFS (white/gray/black) from `node`; returns the first cycle path containing `node`, if any. */
  private findCycle(node: string): string[] | null {
    const color = new Map<string, number>(); // 0 white, 1 gray (on stack), 2 black
    const path: string[] = [];
    const dfs = (n: string): string[] | null => {
      color.set(n, 1);
      path.push(n);
      for (const target of this.routeTargets.get(n) ?? []) {
        const c = color.get(target) ?? 0;
        if (c === 1) return [...path.slice(path.indexOf(target)), target];
        if (c === 0) {
          const cycle = dfs(target);
          if (cycle) return cycle;
        }
      }
      path.pop();
      color.set(n, 2);
      return null;
    };
    return dfs(node);
  }

  // -- context plumbing --

  private makeCtx(state: RunState, model: string): RunCtx {
    const ctx: RunCtx = {
      runtime: state.runtime,
      verifiers: state.verifiers,
      select: (selector: Selector) => state.select(selector),
      items: [],
      bindings: state.bindings,
      run: async (step: Step, items: WorkItem[]): Promise<StepOutcome> => {
        const exec = await this.runStep(step, this.forkCtx(ctx, items));
        return { accepted: exec.accepted, rejected: [...exec.rejected, ...exec.skipped] };
      },
      log: state.log,
      model,
      state,
      lastAgentResult: state.lastAgentResult,
    };
    return ctx;
  }

  /** A child context over the given items (shares runtime/verifiers/bindings/state). */
  private forkCtx(parent: RunCtx, items: WorkItem[]): RunCtx {
    const ctx = this.makeCtx(parent.state, parent.model);
    ctx.items = items;
    return ctx;
  }

  /**
   * Run a scope (top-level steps, a `foreach` batch body, or a fragment's
   * steps) over `items`. Accepted items accumulate; after each step the scope
   * continues with the step's rejected set. A `gate` abort returns the scope's
   * current items as `skipped`.
   */
  private async runScope(ctx: RunCtx, steps: readonly Step[], items: WorkItem[]): Promise<ScopeResult> {
    ctx.items = items;
    const accepted: WorkItem[] = [];
    const skipped: WorkItem[] = [];
    for (const step of steps) {
      const exec = await this.runStep(step, ctx);
      accepted.push(...exec.accepted);
      if (exec.aborted) {
        // A gate fired false: the gate's items are skipped, remaining steps are not run.
        skipped.push(...exec.skipped);
        ctx.log("info", `scope aborted by gate: ${exec.skipped.length} item(s) skipped`);
        return { accepted, rejected: [], skipped };
      }
      // Skipped items from nested scopes (foreach bodies / fragments) bubble up.
      skipped.push(...exec.skipped);
      ctx.items = exec.rejected;
    }
    return { accepted, rejected: ctx.items, skipped };
  }

  // -- step dispatch --

  private async runStep(step: Step, ctx: RunCtx): Promise<StepExec> {
    switch (step.kind) {
      case "agent":
        return this.runAgentStep(step, ctx);
      case "shell":
        return this.runShellStep(step, ctx);
      case "verify":
        return this.runVerifyStep(step, ctx);
      case "transform":
        return this.runTransformStep(step, ctx);
      case "select":
        return this.runSelectStep(step, ctx);
      case "foreach":
        return this.runForeachStep(step, ctx);
      case "gate":
        return this.runGateStep(step, ctx);
    }
  }

  private async runAgentStep(
    step: Extract<Step, { kind: "agent" }>,
    ctx: RunCtx,
  ): Promise<StepExec> {
    const items = ctx.items;
    if (items.length === 0) {
      return { accepted: [], rejected: [], skipped: [], aborted: false };
    }
    const model = step.model ?? ctx.model;
    const { text: prompt, styleGuideHash } = await this.renderPrompt(step.prompt, items, ctx.state);
    const session = await ctx.runtime.createSession({
      model,
      prompt,
      ...(step.tools !== undefined ? { tools: step.tools } : {}),
    });
    const result: AgentResult = await session.prompt(prompt);
    const turn: AgentTurn = { model, text: result.finalText, usage: result.usage, styleGuideHash };
    // Written to both the local ctx and the shared run state so scopes forked
    // later (foreach bodies, fragments) and transforms after a foreach both see it.
    ctx.lastAgentResult = turn;
    ctx.state.lastAgentResult = turn;
    ctx.log("info", `agent: ${items.length} item(s) on ${model}`);
    // An agent turn is not a verifier: every item stays in play.
    return { accepted: [], rejected: items, skipped: [], aborted: false };
  }

  private async runShellStep(
    step: Extract<Step, { kind: "shell" }>,
    ctx: RunCtx,
  ): Promise<StepExec> {
    const lines = await step.run(ctx);
    for (const line of lines) ctx.log("info", line);
    return { accepted: [], rejected: ctx.items, skipped: [], aborted: false };
  }

  private async runVerifyStep(
    step: Extract<Step, { kind: "verify" }>,
    ctx: RunCtx,
  ): Promise<StepExec> {
    const verifier = ctx.verifiers.get(step.verifier);
    if (!verifier) throw new Error(`verify: unknown verifier "${step.verifier}"`);
    const accepted: WorkItem[] = [];
    const rejected: WorkItem[] = [];
    for (const item of ctx.items) {
      const verdict = await verifier.verify(item, ctx);
      ctx.log(
        "info",
        `verify(${step.verifier}): ${item.id} -> ${verdict.accepted ? "accepted" : "rejected"}`,
      );
      (verdict.accepted ? accepted : rejected).push(item);
    }
    return { accepted, rejected, skipped: [], aborted: false };
  }

  private async runTransformStep(
    step: Extract<Step, { kind: "transform" }>,
    ctx: RunCtx,
  ): Promise<StepExec> {
    await step.fn(ctx);
    // The transform may mutate ctx.items in place; remaining items stay in play.
    return { accepted: [], rejected: ctx.items, skipped: [], aborted: false };
  }

  private async runSelectStep(
    step: Extract<Step, { kind: "select" }>,
    ctx: RunCtx,
  ): Promise<StepExec> {
    const items = await ctx.select(step.selector);
    ctx.bindings.set(step.into, items);
    ctx.log("info", `select: ${step.into} <- ${items.length} item(s)`);
    return { accepted: [], rejected: ctx.items, skipped: [], aborted: false };
  }

  private async runGateStep(
    step: Extract<Step, { kind: "gate" }>,
    ctx: RunCtx,
  ): Promise<StepExec> {
    const pass = await step.when(ctx);
    ctx.log("info", `gate: ${pass ? "pass" : "skip (aborts remaining steps in this scope)"}`);
    return pass
      ? { accepted: [], rejected: ctx.items, skipped: [], aborted: false }
      : { accepted: [], rejected: [], skipped: ctx.items, aborted: true };
  }

  private async runForeachStep(
    step: Extract<Step, { kind: "foreach" }>,
    ctx: RunCtx,
  ): Promise<StepExec> {
    if (!Number.isInteger(step.batch) || step.batch < 1) {
      throw new Error(`foreach: batch must be a positive integer (got ${String(step.batch)})`);
    }
    const source = step.from === undefined ? ctx.items : ctx.bindings.get(step.from);
    if (step.from !== undefined && source === undefined) {
      throw new Error(
        `foreach: no binding "${step.from}" (a select step with into: "${step.from}" must run first)`,
      );
    }

    const accepted: WorkItem[] = [];
    const rejected: WorkItem[] = [];
    const skipped: WorkItem[] = [];
    const routed = new Map<string, { model?: string; items: WorkItem[] }>();
    // When `from` targets a binding, items in the current scope that are NOT in
    // the binding are untouched by this phase and stay in play (they continue to
    // the next step / surface as rejected at scope end).
    const sourceIds = new Set(source!.map((i) => i.id));
    const unchanged: WorkItem[] =
      step.from === undefined ? [] : ctx.items.filter((i) => !sourceIds.has(i.id));

    for (const batch of this.partition(source!, step.batch, step.key)) {
      ctx.log("info", `foreach: batch of ${batch.length} item(s)`);
      const body = this.forkCtx(ctx, batch);
      const res = await this.runScope(body, step.steps, batch);
      accepted.push(...res.accepted);
      skipped.push(...res.skipped);
      for (const item of res.rejected) {
        const matched = this.matchRoute(step.onReject ?? [], item);
        if (!matched) {
          rejected.push(item);
          continue;
        }
        const { route, index } = matched;
        // Budgets are keyed per route (index within the onReject array), so
        // different routes to the same fragment keep independent maxAttempts.
        const budgetKey = `${index}:${route.to}`;
        if (this.routeBudgetExceeded(ctx.state, budgetKey, item.id, route.maxAttempts)) {
          ctx.log(
            "info",
            `onReject: ${item.id} past ${route.to} maxAttempts=${String(route.maxAttempts)} -> stays rejected`,
          );
          rejected.push(item);
          continue;
        }
        this.bumpAttempt(ctx.state, budgetKey, item.id);
        let bucket = routed.get(route.to);
        if (!bucket) {
          bucket = { model: route.model, items: [] };
          routed.set(route.to, bucket);
        }
        bucket.items.push(item);
        ctx.log(
          "info",
          `onReject: ${item.id} -> ${route.to}${route.model ? ` on ${route.model}` : ""}`,
        );
      }
    }

    for (const [target, bucket] of routed) {
      const fragSteps = this.fragments.get(target);
      if (!fragSteps) {
        throw new Error(
          `onReject: route target "${target}" is not a registered fragment (registerFragment first)`,
        );
      }
      const model = bucket.model ?? ctx.model;
      const frag = this.makeCtx(ctx.state, model);
      const res = await this.runScope(frag, fragSteps, bucket.items);
      accepted.push(...res.accepted);
      rejected.push(...res.rejected);
      skipped.push(...res.skipped);
    }

    // The last agent turn happened inside a forked body/fragment scope: write
    // it back to the outer ctx so a transform after the foreach can see it.
    ctx.lastAgentResult = ctx.state.lastAgentResult;

    return { accepted, rejected: [...unchanged, ...rejected], skipped, aborted: false };
  }

  // -- foreach helpers --

  /** Group by `key` first (when set), then chunk each group into batches of `batch`. */
  private partition(items: WorkItem[], batch: number, key?: string): WorkItem[][] {
    if (key === undefined) return chunk(items, batch);
    const groups = new Map<string, WorkItem[]>();
    for (const item of items) {
      const k = this.groupKey(item, key);
      let group = groups.get(k);
      if (!group) {
        group = [];
        groups.set(k, group);
      }
      group.push(item);
    }
    const out: WorkItem[][] = [];
    for (const group of groups.values()) out.push(...chunk(group, batch));
    return out;
  }

  /** Resolve a grouping key: "unit" is an alias for `unitId`; other keys read the item field. */
  private groupKey(item: WorkItem, key: string): string {
    if (key === "unit") return item.unitId ?? "";
    const value = (item as unknown as Record<string, unknown>)[key];
    return value === undefined || value === null ? "" : String(value);
  }

  /** First route (in order) whose `when` predicate matches the item, if any. */
  private matchRoute(
    routes: readonly Route[],
    item: WorkItem,
  ): { route: Route; index: number } | undefined {
    for (let i = 0; i < routes.length; i++) {
      if (this.routeMatches(routes[i]!.when, item)) return { route: routes[i]!, index: i };
    }
    return undefined;
  }

  private routeMatches(when: Route["when"], item: WorkItem): boolean {
    if (!when) return true;
    if (when.sizeBelow !== undefined && !(item.size !== undefined && item.size < when.sizeBelow)) {
      return false;
    }
    // An empty status list is an empty predicate: it matches nothing (never a
    // silent catch-all; use `when: {}` for that).
    if (
      when.status !== undefined &&
      (when.status.length === 0 || !when.status.includes(item.status))
    ) {
      return false;
    }
    if (when.attempts !== undefined) {
      if (when.attempts.min !== undefined && item.attempts < when.attempts.min) return false;
      if (when.attempts.max !== undefined && item.attempts > when.attempts.max) return false;
    }
    return true;
  }

  private routeBudgetExceeded(
    state: RunState,
    budgetKey: string,
    itemId: string,
    maxAttempts: number | undefined,
  ): boolean {
    if (maxAttempts === undefined) return false;
    return (state.attempts.get(budgetKey)?.get(itemId) ?? 0) >= maxAttempts;
  }

  private bumpAttempt(state: RunState, budgetKey: string, itemId: string): void {
    let byItem = state.attempts.get(budgetKey);
    if (!byItem) {
      byItem = new Map();
      state.attempts.set(budgetKey, byItem);
    }
    byItem.set(itemId, (byItem.get(itemId) ?? 0) + 1);
  }

  // -- prompt rendering --

  /**
   * Render an agent prompt: `PromptBuilder` renders the template with the
   * batch's items merged into the context (plus the run's style guide, if
   * configured), then a compact item list is appended so the agent always
   * sees what it is working on.
   */
  private async renderPrompt(
    spec: PromptSpec,
    items: WorkItem[],
    state: RunState,
  ): Promise<{ text: string; styleGuideHash: string }> {
    const context = { ...(spec.context ?? {}), items };
    const prompt = await this.builder.build(
      { ...spec, context },
      state.styleGuidePath === undefined ? {} : { styleGuide: { path: state.styleGuidePath } },
    );
    const list = items.map((i) => `- ${i.id}${i.symbol ? ` (${i.symbol})` : ""}`).join("\n");
    return {
      text: `${prompt.rendered}\n\n## Work items\n\n${list}`,
      styleGuideHash: prompt.styleGuideHash,
    };
  }
}
