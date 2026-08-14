/**
 * Reference example: `tu-final` (SPEC §C.2).
 *
 * Translation-unit finalization for DATA objects/labels (the "object" kind —
 * not declared in `WorkItemKindMap`, so hooks see the generic
 * `WorkItem & { kind: "object" }` fallback shape, fully typed on the common
 * fields; the label kind follows the same shape). One target per session
 * (`canBatch: false` → batch 1).
 *
 * The single `agentLoop` does double duty: the data-match turn, then the
 * CLEANUP turns — each `reprompt` runs the real linter (`lintFile`) over the
 * model's candidate and feeds the violations back as `feedback` until the
 * candidate is clean (or the retry cap is hit). `complete` decides what
 * acceptance means for a data target.
 */
import { Workflow } from "../src/workflow/types.js";
import { lintFile } from "../src/parse/cpp/registry.js";
import type { WorkItem } from "../src/types.js";

/**
 * Run the linter over a candidate data definition. `path` feeds the
 * TU-sensitive smell gates (class/struct-in-cpp); the model's reply is the
 * candidate source.
 */
function lintCandidate(target: WorkItem & { kind: "object" }, source: string) {
  return lintFile(target.source ?? `${target.symbol ?? target.id}.c`, source);
}

/** `tu-final` — data-matching + linter-driven cleanup for one object/label. */
export const tuFinal = new Workflow({
  id: "tu-final",
  accepts: "object",
  canBatch: false,
  startPrompt: async (targets, ctx) => {
    const target = targets[0]!;
    return (
      `Produce the data definition for ${target.id}${target.symbol ? ` (${target.symbol})` : ""}. ` +
      `This is a translation-unit finalization pass: output ONLY the definition ` +
      `(plain C, no markdown fences) for path ${target.source ?? `${target.symbol ?? target.id}.c`}. ` +
      `The definition will be linted before acceptance.`
    );
  },
  reprompt: async (targets, ctx, lastTurn) => {
    const target = targets[0]!;
    const violations = lintCandidate(target, lastTurn.text);
    if (violations.length === 0) {
      return { accepted: targets, rejected: [], feedback: "lint clean — accepted" };
    }
    // Cleanup loop: feed the violations back so the next turn fixes them.
    return {
      accepted: [],
      rejected: targets,
      feedback:
        `The candidate failed lint with ${violations.length} violation(s):\n` +
        `${violations.map((v) => `- ${v.rule} @${v.line}: ${v.message}`).join("\n")}\n` +
        `Resubmit the definition with every violation fixed.`,
    };
  },
  complete: async (target) => ({
    promote: true,
    status: "MATCHED",
    evidence: { workflow: "tu-final", data: true, lint: "clean", targetId: target.id },
  }),
});
