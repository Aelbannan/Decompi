/**
 * Builtin `match` pipeline (SPEC §10, §19 M3 acceptance — the reference impl):
 * `plan` selects unmatched work items, then a `foreach` batches them five at a
 * time through one shared agent session per batch; the agent's draft is then
 * checked by the `diff` verifier, so accepted drafts finalize right in the
 * body. Items the diff rejects are routed by size through the ordered
 * `onReject` routes: small items (size < `MATCH_REBATCH_SIZE_BELOW`) go to a
 * cheap `rebatch` fragment, larger items to a hard `singleton` fragment whose
 * `foreach batch: 1` retries them ONE PER SESSION — the v1 two-branch
 * asymmetry expressed as ordered routes. Route models win over the run default
 * (engine semantics); fragments end with the `diff` verifier so their
 * acceptances finalize.
 *
 * Register via {@link registerMatchPipelines}; the runtime must resolve the
 * two model names and the caller must supply a `diff` verifier.
 */
import { definePipeline, type PipelineEngine } from "../engine.js";

/** Pipeline id of the builtin match pipeline. */
export const MATCH_PIPELINE_ID = "match";
/** `foreach` batch size: N items → one shared agent session (SPEC §10). */
export const MATCH_BATCH_SIZE = 5;
/** Fragment id re-batching small rejected items on the cheap model. */
export const MATCH_REBATCH_FRAGMENT = "match-rebatch";
/** Fragment id retrying large rejected items one at a time on the hard model. */
export const MATCH_SINGLETON_FRAGMENT = "match-singleton";
/** Model name for the rebatch route (cheap). */
export const MATCH_REBATCH_MODEL = "nube-ds4-flash-low";
/** Model name for the singleton route (hard). */
export const MATCH_SINGLETON_MODEL = "nube-ds4-flash-high";
/**
 * Items with `size <` this value route to rebatch; larger items route to
 * singleton (the `sizeBelow` route predicate is strict).
 */
export const MATCH_REBATCH_SIZE_BELOW = 128;

/** Shared match prompt spec (template registry `match`). */
export const MATCH_PROMPT = { template: "match" } as const;

/**
 * Register the `match` pipeline plus its two retry fragments on `engine`.
 * Route graphs are validated acyclic at register time (fragments have no
 * routes, so the graph is a plain fan-out).
 */
export function registerMatchPipelines(engine: PipelineEngine): void {
  engine.registerFragment(MATCH_REBATCH_FRAGMENT, [
    { kind: "agent", prompt: MATCH_PROMPT },
    { kind: "verify", verifier: "diff" },
  ]);
  // The singleton fragment batches ONE item per session: large items get an
  // isolated hard-model retry instead of sharing a session with each other.
  engine.registerFragment(MATCH_SINGLETON_FRAGMENT, [
    {
      kind: "foreach",
      batch: 1,
      steps: [
        { kind: "agent", prompt: MATCH_PROMPT },
        { kind: "verify", verifier: "diff" },
      ],
    },
  ]);
  engine.registerPipeline(
    definePipeline({
      id: MATCH_PIPELINE_ID,
      adapter: "xenoblade",
      plan: async (ctx) =>
        ctx.select({
          filter: { status: ["NOT_STARTED"] },
          sort: [{ by: "size", dir: "asc" }],
          limit: 100,
        }),
      steps: [
        {
          kind: "foreach",
          batch: MATCH_BATCH_SIZE,
          steps: [
            { kind: "agent", prompt: MATCH_PROMPT },
            { kind: "verify", verifier: "diff" },
          ],
          onReject: [
            {
              when: { sizeBelow: MATCH_REBATCH_SIZE_BELOW },
              to: MATCH_REBATCH_FRAGMENT,
              model: MATCH_REBATCH_MODEL,
            },
            { to: MATCH_SINGLETON_FRAGMENT, model: MATCH_SINGLETON_MODEL },
          ],
        },
      ],
    }),
  );
}
