/**
 * Prompt template registry (SPEC §12): `TEMPLATES` maps a template name to a
 * plain-text renderer taking a context object. Rendering is fully
 * deterministic — no timestamps, no randomness, no model output — so
 * `PromptBuilder` hashes are stable across identical inputs.
 *
 * Convention: the first paragraph of a rendered template is the *system
 * directive*. `style-guide.ts`'s `injectStyleGuide` inserts the adapter's
 * Markdown guide directly after that block, keeping it in system context
 * ahead of the task body.
 */

/** Context passed to template renderers (SPEC §12: brief, prior draft, siblings, walls). */
export interface TemplateContext {
  /** Task brief: the function/object to match or clean, plus any specifics. */
  brief?: string;
  /** Prior draft from an earlier attempt (revise it — don't start over). */
  priorDraft?: string;
  /** Sibling work items (other functions in the same unit, related objects…). */
  siblings?: unknown[];
  /** Constraint walls: do-nots / invariants the agent must respect. */
  walls?: string[];
}

/** A template renderer: context in, plain-text prompt out. */
export type Template = (ctx: TemplateContext) => string;

const NONE = "(none)";

/** Formats an arbitrary context value for inclusion in a plain-text prompt. */
function fmt(value: unknown): string {
  if (value === undefined || value === null) return NONE;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function bulletList(items: unknown[] | undefined): string {
  if (!items || items.length === 0) return NONE;
  return items.map((item) => `- ${fmt(item)}`).join("\n");
}

/** Full prompt templates (SPEC §12). */
export const TEMPLATES: Record<string, Template> = {
  /** Decompile/match a function so the compiled output matches retail bytecode. */
  match(ctx) {
    return [
      "You are decompiling a function to match retail bytecode.",
      section("Task", fmt(ctx.brief)),
      section("Prior draft", fmt(ctx.priorDraft)),
      section("Sibling functions", bulletList(ctx.siblings)),
      section("Walls", bulletList(ctx.walls)),
    ].join("\n\n");
  },

  /** Mechanical cleanup of code that is already close. */
  cleanup(ctx) {
    return [
      "Clean up the following code.",
      section("Code", fmt(ctx.priorDraft ?? ctx.brief)),
      section("Walls", bulletList(ctx.walls)),
    ].join("\n\n");
  },
};
