/**
 * Reference example: `fakematch-detect` (SPEC §C.4).
 *
 * A detection pass over ALREADY-MATCHED functions (FULL_MATCH /
 * EQUIVALENT_MATCH): the agent reviews each match and the reprompt emits a
 * `fakematch-candidate` event flag for anything suspicious —
 * `ctx.helpers.emit(type, data)` — as a SOFT signal. The workflow NEVER
 * hard-rejects: every target is accepted as examined (completion-row only;
 * the actual demotion/recertify decision belongs to another workflow, e.g.
 * the recertify shape). `flags` stay events, never a verdict.
 */
import { Workflow } from "../src/workflow/types.js";

/** Event type for a flagged candidate (consumed by the daemon/recertify path). */
export const FAKEMATCH_EVENT = "fakematch-candidate";

/** Reply markers that suggest a match is fake (placeholder/stub residue). */
const SUSPICIOUS_MARKERS = /\b(?:stub|TODO|FIXME|unk[0-9A-Za-z_]*)\b/;

/** `fakematch-detect` — flag suspicious matches, never reject them. */
export const fakematchDetect = new Workflow({
  id: "fakematch-detect",
  accepts: "function",
  select: { filter: { status: ["FULL_MATCH", "EQUIVALENT_MATCH"] } },
  startPrompt: async (targets, ctx) => {
    const asm = await Promise.all(targets.map((t) => ctx.helpers.getFunctionAsm(t)));
    const list = targets
      .map(
        (t, i) =>
          `- ${t.id}${t.symbol ? ` (${t.symbol})` : ""} — ${t.status}\n\`\`\`\n${asm[i] ?? ""}\n\`\`\``,
      )
      .join("\n");
    return (
      `Review the following matched functions for FAKEMATCHES: matches that only ` +
      `appear correct (placeholder bodies, renamed aliases, dead code). ` +
      `Report any suspicions. Detection only — do NOT modify the targets.\n\n${list}`
    );
  },
  reprompt: async (targets, ctx, lastTurn) => {
    for (const target of targets) {
      const suspicious = SUSPICIOUS_MARKERS.test(lastTurn.text);
      if (suspicious) {
        // Soft signal only: an event flag, never a reject (SPEC §C.4).
        await ctx.helpers.emit(FAKEMATCH_EVENT, {
          targetId: target.id,
          symbol: target.symbol,
          status: target.status,
          reason: "review reply contains placeholder/stub markers",
          excerpt: lastTurn.text.slice(0, 400),
        });
      }
    }
    // Everything is accepted as examined — flags, no hard reject.
    return {
      accepted: targets,
      rejected: [],
      feedback: `Review complete; ${FAKEMATCH_EVENT} flags emitted for suspicious candidates.`,
    };
  },
});
