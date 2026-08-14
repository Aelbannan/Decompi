/**
 * Reference example: `judge-adaptive-match` (SPEC §C.5 + §A.4).
 *
 * `basic-match` plus a stateless judge: after each batch-cycle verdict, the
 * reprompt consults a SEPARATE cheap judge agent (`ctx.StartJsonAgent`) —
 * a fresh session per call, one JSON turn fed with the results + last reply,
 * zod-validated — and asks whether the batch is converging. When the judge
 * says stop, the reprompt returns `final: true` with the judge's message as
 * "wrap it up" feedback: the engine delivers that feedback as ONE write-only
 * turn and routes the still-in-play targets to `onReject` (SPEC §A.5).
 */
import { z } from "zod";
import { Workflow } from "../src/workflow/types.js";
import { basicMatch, CHEAP_MODEL, HIGH_MODEL } from "./basic-match.js";

/** Judge reply schema: continue, or wrap it up with a message. */
export const JudgeOut = z.object({
  shouldContinue: z.boolean(),
  message: z.string(),
});

/** The judge model slug — deliberately the cheap model (per-call parameter). */
export const JUDGE_MODEL = CHEAP_MODEL;

/**
 * `judge-adaptive-match` — `basic-match`'s flow, but the reprompt runs a
 * judge side-channel before splitting the verdict. The zod schema drives the
 * return type (`z.infer<JudgeOut>` — no `any`); a non-JSON or
 * schema-invalid judge reply retries once internally, then throws
 * `JudgeError`.
 */
export const judgeAdaptiveMatch = new Workflow({
  id: "judge-adaptive-match",
  accepts: "function",
  canBatch: true,
  defaultBatchSize: 5,
  select: {
    filter: { status: ["NOT_STARTED"] },
    sort: [{ by: "size", dir: "asc" }],
    limit: 100,
  },
  rejectionRetries: 1,
  routes: [
    { when: { sizeBelow: 128 }, model: CHEAP_MODEL },
    { model: HIGH_MODEL },
  ],
  // Reuse basic-match's brief: judge-adaptive-match IS basic-match + judge.
  startPrompt: basicMatch.definition.startPrompt,
  reprompt: async (targets, ctx, lastTurn) => {
    const results = await ctx.helpers.runBatchCycle(targets);
    const judge = await ctx.StartJsonAgent(
      JUDGE_MODEL,
      "Is this batch converging, or going in circles?",
      { results, lastReply: lastTurn.text },
      JudgeOut,
    );
    if (!judge.shouldContinue) {
      // "Wrap it up": one write-only turn with the judge's message, then the
      // still-in-play targets route via onReject (no further reprompt).
      return {
        accepted: [],
        rejected: targets,
        final: true,
        feedback: judge.message === "" ? "Wrap it up — you're going in circles." : judge.message,
      };
    }
    return {
      accepted: results.filter((r) => r.accepted).map((r) => r.target),
      rejected: results.filter((r) => !r.accepted).map((r) => r.target),
      feedback: results.map((r) => `# ${r.targetId} — ${r.status}`).join("\n"),
    };
  },
});
