/**
 * The `Decompi` facade (SPEC §7): the workflow authoring entry point. Holds
 * the engine/scheduler deps (via `configure`, so tests inject doubles),
 * compiles + registers workflows onto the engine (`addWorkflow`), registers
 * named helpers (`addHelper`), and surfaces `run` / `select` / `workflow`.
 *
 * The class is module-private (the exported singleton is the facade); the
 * internal name differs from the exported `Decompi` binding so the singleton
 * can be `export const Decompi = new DecompiFacade()`. `configure({ engine,
 * scheduler })` REPLACES the whole dep set, so each test can re-point the
 * singleton deterministically.
 */
import type { PipelineEngine } from "../pipeline/engine.js";
import type { RunSpec } from "../server/scheduler.js";
import type { Selector, WorkItem } from "../types.js";
import type { WorkflowStatusStore } from "./status.js";
import { compileWorkflow } from "./compile.js";
import { HelperRegistry, type WorkflowHelpers } from "./helpers.js";
import type { Workflow } from "./types.js";
/**
 * The scheduler surface the facade needs — structural, so a test stub (or
 * the real `RunScheduler`) satisfies it.
 */
export interface RunSchedulerLike {
  /** Insert + start one run; resolves with the run id. */
  createRun(spec: RunSpec): Promise<string>;
}

/** Runtime deps for the facade (SPEC §7: `configure({ engine, scheduler })`). */
export interface DecompiDeps {
  /** Pipeline engine the compiled workflows + fragments register onto. */
  engine: PipelineEngine;
  /** Run scheduler `run()` delegates to. */
  scheduler: RunSchedulerLike;
  /** Store-backed selector resolver for `select()`; absent until wired. */
  select?: (selector: Selector) => Promise<WorkItem[]>;
  /**
   * Workflow status store (SPEC §A.3): compiled plans skip done targets.
   * Absent = plans stay fully selectable (stub-until-daemon).
   */
  statusesStore?: WorkflowStatusStore;
  /**
   * Adapter-wide helper registry (SPEC §3): compiled onto registered
   * workflows as their run default — the engine materializes it into
   * `ctx.helpers` when the run context supplies none.
   */
  helpers?: HelperRegistry;
}

class DecompiFacade {
  private deps: DecompiDeps | null = null;
  private readonly registry = new HelperRegistry();
  private readonly workflows = new Map<string, Workflow>();

  /**
   * Set the runtime deps. Replaces the whole set, so tests can re-point the
   * singleton per test.
   */
  configure(deps: DecompiDeps): this {
    this.deps = deps;
    return this;
  }

  /**
   * Compile a workflow (plan + `onReject` fragments) and register both
   * halves on the configured engine. Also records the workflow for
   * `workflow(id)` and detects local-helper shadowing (SPEC §3: last-wins,
   * logged, not an error).
   */
  addWorkflow(w: Workflow): void {
    const deps = this.requireDeps("addWorkflow");
    const { pipeline, fragments } = compileWorkflow(w, {
      ...(deps.statusesStore !== undefined ? { statusesStore: deps.statusesStore } : {}),
      ...(deps.helpers !== undefined ? { helpers: deps.helpers } : {}),
    });
    // SPEC §3: a workflow-local helper shadowing a registered global one is
    // detected at addWorkflow and logged (the engine merges last-wins).
    for (const name of Object.keys(w.definition.helpers ?? {})) {
      if (this.registry.has(name)) {
        console.log(
          `[Decompi] addWorkflow(${w.id}): local helper "${name}" shadows a global helper`,
        );
      }
    }
    deps.engine.registerPipeline(pipeline);
    for (const [id, steps] of fragments) deps.engine.registerFragment(id, steps);
    this.workflows.set(w.id, w);
  }

  /** Register a named (adapter-wide) helper into the HelperRegistry. */
  addHelper<K extends keyof WorkflowHelpers>(name: K, fn: WorkflowHelpers[K]): void {
    this.registry.register(name, fn);
  }

  /** Delegate a run to the configured scheduler; resolves with the run id. */
  run(spec: RunSpec): Promise<string> {
    return this.requireDeps("run").scheduler.createRun(spec);
  }

  /** Resolve a `Selector` through the configured store-backed resolver. */
  async select(selector: Selector): Promise<WorkItem[]> {
    const deps = this.requireDeps("select");
    if (deps.select === undefined) {
      throw new Error("Decompi: configure({ select }) before calling select()");
    }
    return deps.select(selector);
  }

  /** The workflow registered under `id`, or undefined. */
  workflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  /** The helper registry (surface for adapters/tests). */
  get helpers(): HelperRegistry {
    return this.registry;
  }

  private requireDeps(what: string): DecompiDeps {
    if (this.deps === null) {
      throw new Error(`Decompi: configure({ engine, scheduler }) before ${what}()`);
    }
    return this.deps;
  }
}

/** The shared facade singleton (SPEC §7). */
export const Decompi: DecompiFacade = new DecompiFacade();
