/**
 * Reference example: `tu-prepass` (SPEC §C.3 + §A.1).
 *
 * Header-scaffolding prepass over a translation unit's functions, driven by
 * the per-batch `setup` hook: `setup` runs ONCE per drawn batch, before the
 * batch's `agentLoop`, and calls `ctx.helpers.structLayout(unit)` to fetch
 * the TU's struct layout; it returns a `WorkflowConfig` (cheap model + a
 * higher re-prompt cap for this batch).
 *
 * `setup → startPrompt` data flow: `WorkflowConfig` is the ONLY output
 * channel of `setup`, so the example carries the fetched layout through a
 * module-scoped slot. The engine guarantees `setup` runs once per drawn
 * batch BEFORE the batch's `agentLoop` (SPEC §A.1), so the slot is always
 * fresh when `startPrompt` embeds it.
 */
import { Workflow } from "../src/workflow/types.js";
import { CHEAP_MODEL } from "./basic-match.js";

/** Module-scoped slot carrying the current batch's layout from `setup` to `startPrompt`. */
let pendingLayout = "";

/** `tu-prepass` — struct-layout-driven header scaffolding for a TU's functions. */
export const tuPrepass = new Workflow({
  id: "tu-prepass",
  accepts: "function",
  setup: async (targets, ctx) => {
    // Layout the FIRST target's unit — prepasses are unit-scoped, so every
    // target in the batch shares the unit (batch sub-division is optional).
    const unit = targets[0]?.unitId ?? "";
    pendingLayout = await ctx.helpers.structLayout(unit);
    return { rejectionRetries: 2, model: CHEAP_MODEL };
  },
  startPrompt: async (targets, ctx) => {
    const layout =
      pendingLayout === "" ? await ctx.helpers.structLayout(targets[0]?.unitId ?? "") : pendingLayout;
    const list = targets
      .map((t) => `- ${t.id}${t.symbol ? ` (${t.symbol})` : ""}`)
      .join("\n");
    return (
      `Scaffold header declarations for the following ${targets.length} function(s) of ` +
      `${targets[0]?.unitId ?? "(unknown unit)"}, using the struct layout:\n\n` +
      `${layout}\n\nFunctions:\n${list}`
    );
  },
  reprompt: async (targets, _ctx, lastTurn) => ({
    // Stub verdict: the layout-driven scaffold is generated in the first turn,
    // so the batch is accepted as scaffolded (the per-batch retries/model
    // overrides matter once the real scaffolding agent lands).
    accepted: targets,
    rejected: [],
    feedback: `Scaffolding drafted from the struct layout (draft length ${lastTurn.text.length}).`,
  }),
});
