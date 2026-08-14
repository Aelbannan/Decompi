/**
 * Reference example: `basic-match` (SPEC §C.1).
 *
 * The current flow: NOT_STARTED functions, batched 5 per agent session;
 * small functions (size < 128) route to the cheap model as a rebatch
 * fragment (default batch), the rest to the high model as a singleton
 * fragment (batch 1). `startPrompt` builds a match brief from the retail
 * asm; `reprompt` runs the coop batch-cycle tool over the still-in-play
 * targets and splits the verdict into accepted/rejected.
 */
import { Workflow } from "../src/workflow/types.js";

/** The single source of truth for the two route models (models.json slugs). */
export const CHEAP_MODEL = "nube-ds4-flash-low";
export const HIGH_MODEL = "nube-ds4-flash-high";

/**
 * `basic-match` — the canonical matching workflow. `accepts: "function"`
 * narrows every hook's `targets` to `FunctionWorkItem` (via the examples'
 * `WorkItemKindMap` augmentation), so `ctx.helpers.getFunctionAsm(t)` /
 * `runBatchCycle(t)` typecheck against the stub vocabulary.
 */
export const basicMatch = new Workflow({
  id: "basic-match",
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
    // Small functions → cheap model, rebatch fragment (default batch size).
    { when: { sizeBelow: 128 }, model: CHEAP_MODEL },
    // Everything else → high model, singleton fragment (batch 1).
    { model: HIGH_MODEL },
  ],
  startPrompt: async (targets, ctx) => {
    const asm = await Promise.all(targets.map((t) => ctx.helpers.getFunctionAsm(t)));
    const diffs = await Promise.all(targets.map((t) => ctx.helpers.estimateDifficulty(t)));
    const briefs = targets
      .map(
        (t, i) =>
          `- ${t.id}${t.symbol ? ` (${t.symbol})` : ""} — size ${t.size ?? "?"}, difficulty ` +
          `${diffs[i] ?? "?"}\n\`\`\`\n${asm[i] ?? ""}\n\`\`\``,
      )
      .join("\n");
    return (
      `Match the following ${targets.length} function(s): produce high-level C that ` +
      `recompiles to the retail asm. Reply with one implementation per function.\n\n${briefs}`
    );
  },
  reprompt: async (targets, ctx, lastTurn) => {
    const results = await ctx.helpers.runBatchCycle(targets);
    return {
      accepted: results.filter((r) => r.accepted).map((r) => r.target),
      rejected: results.filter((r) => !r.accepted).map((r) => r.target),
      feedback:
        `Batch-cycle results for the previous attempt:\n` +
        `${results.map((r) => `# ${r.targetId} — ${r.status}`).join("\n")}\n` +
        `Fix the rejected functions and resubmit. Your last reply began: ` +
        `${lastTurn.text.slice(0, 120)}…`,
    };
  },
});
