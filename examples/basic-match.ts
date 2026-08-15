/**
 * Reference example: `basic-match` (SPEC §C.1) — live-wired for real model
 * runs against the xenoblade adapter.
 *
 * The current flow: NOT_STARTED functions, batched 5 per agent session;
 * small functions (size < 128) route to the cheap model as a rebatch
 * fragment (default batch), the rest to the high model as a singleton
 * fragment (batch 1). `startPrompt` builds a match brief from the retail
 * asm PLUS the target's current stub source; the session toolset lets the
 * agent apply its implementation in place (`replace_function`), build+diff
 * it (`hexdiff`), and inspect the TU (`read_source`). `reprompt` splices
 * the agent's final reply (if it carries a definition) and runs the coop
 * batch-cycle tool over the still-in-play targets, splitting the verdict
 * into accepted/rejected.
 */
import { z } from "zod";
import { Workflow } from "../src/workflow/types.js";
import type { FunctionWorkItem } from "../adapters/xenoblade/workflow.js";
import {
  applyCandidate,
  extractFunctionSpan,
  getFunctionAsm,
  hexdiff,
  readSource,
} from "../adapters/xenoblade/workflow.js";

/** The single source of truth for the two route models (models.json slugs). */
export const CHEAP_MODEL = "nube-ds4-flash-low";
export const HIGH_MODEL = "nube-ds4-flash-high";

/** Extract one function's current source span for the brief (best effort). */
function currentFunctionSource(t: FunctionWorkItem, source: string): string {
  if (!t.symbol) return `(no symbol for ${t.id})`;
  const span = extractFunctionSpan(source, t.symbol);
  if (!span) return `(definition of ${t.symbol} not located in ${t.source})`;
  const lines = source.slice(span.start, span.end).split("\n");
  const window =
    lines.length > 14
      ? [...lines.slice(0, 7), `# ... ${lines.length - 11} lines ...`, ...lines.slice(-4)]
      : lines;
  return window.join("\n");
}

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
  // Status ladder: accepted functions are FULL_MATCH (byte-identical diff).
  statuses: ["FULL_MATCH"],
  doneStatuses: ["FULL_MATCH"],
  completionStatus: "FULL_MATCH",
  routes: [
    // Small functions → cheap model, rebatch fragment (default batch size).
    { when: { sizeBelow: 128 }, model: CHEAP_MODEL },
    // Everything else → high model, singleton fragment (batch 1).
    { model: HIGH_MODEL },
  ],
  // Session tools (SPEC §B.1): the agent applies its own implementation and
  // iterates against fresh hexdiff feedback before the harness re-checks.
  customTools: [
    {
      name: "read_source",
      description:
        "Read the CURRENT source text of a function's translation unit. Call " +
        "this before replace_function to see the existing stub, its signature, " +
        "`extern \"C\"` prefix, and surrounding helper functions.",
      inputSchema: z.object({
        unit: z.string().describe("translation unit id, e.g. kyoshin/CSaveLoad"),
        symbol: z.string().describe("the target symbol, e.g. func_80291204"),
      }),
      run: async (_ctx, args: { unit: string; symbol: string }) =>
        readSource({ id: `${args.unit}:${args.symbol}`, unitId: args.unit, symbol: args.symbol } as FunctionWorkItem),
    },
    {
      name: "replace_function",
      description:
        "Replace a function's existing definition in its source file with your " +
        "proposed implementation. `code` must be ONE complete function " +
        "definition (plain C/C++, no markdown fences, no prose). Keep the " +
        "existing signature shape and any `extern \"C\"` prefix. Returns the " +
        "updated source. Call hexdiff afterwards to check the diff.",
      inputSchema: z.object({
        unit: z.string().describe("translation unit id"),
        symbol: z.string().describe("the target symbol"),
        code: z.string().describe("the complete replacement function definition"),
      }),
      run: async (_ctx, args: { unit: string; symbol: string; code: string }) => {
        const updated = await applyCandidate(
          { id: `${args.unit}:${args.symbol}`, unitId: args.unit, symbol: args.symbol } as FunctionWorkItem,
          args.code,
        );
        return `Applied ${args.symbol} (source now ${updated.length} chars). ` +
          `Run hexdiff(${args.unit}, ${args.symbol}) to check the diff.`;
      },
    },
    {
      name: "hexdiff",
      description:
        "Build the unit and diff one function's decompiled bytes against " +
        "retail. Returns mismatch/structural/reg_swap counts plus per-" +
        "instruction diffs and fix suggestions. Use for the iteration loop: " +
        "replace_function, hexdiff, repeat until mismatch: 0.",
      inputSchema: z.object({
        unit: z.string().describe("translation unit id"),
        symbol: z.string().describe("the target symbol"),
      }),
      run: async (_ctx, args: { unit: string; symbol: string }) =>
        hexdiff(args.unit, args.symbol),
    },
  ],
  startPrompt: async (targets, ctx) => {
    const asm = await Promise.all(targets.map((t) => ctx.helpers.getFunctionAsm(t)));
    const sources = await Promise.all(
      targets.map((t) => ctx.helpers.readSource(t).catch(() => "(source unreadable)")),
    );
    const briefs = targets
      .map((t, i) => {
        const cur = currentFunctionSource(t, sources[i] ?? "");
        return (
          `- ${t.id}${t.symbol ? ` (${t.symbol})` : ""} — size ${t.size ?? "?"}, ` +
          `unit ${t.unitId}, source ${t.source}\n` +
          `  Current stub in source:\n\`\`\`c\n${cur}\n\`\`\`\n` +
          `  Retail asm:\n\`\`\`\n${asm[i] ?? "(asm unavailable)"}\n\`\`\``
        );
      })
      .join("\n");
    return (
      `Match the following ${targets.length} function(s): produce high-level C that ` +
      `recompiles to the retail asm.\n\n` +
      `WORKFLOW: (1) read_source to see the file, (2) replace_function with your ` +
      `implementation (ONE complete definition, keep the signature shape and any ` +
      `extern "C" prefix), (3) hexdiff to check, (4) iterate until mismatch: 0, ` +
      `then reply with a short summary. Do NOT call the finish tool — the harness ` +
      `re-verifies every function itself.\n` +
      `If hexdiff shows ONLY reg_swap mismatches (0 structural), the codegen is ` +
      `right but register allocation differs — read docs/register_mapping.md in ` +
      `the repo: MWCC allocates locals by declaration order (volatile low→high, ` +
      `saved high→low), so reordering local declarations usually fixes it.\n\n${briefs}`
    );
  },
  reprompt: async (targets, ctx, lastTurn) => {
    // Splice the agent's final reply when it carries a definition (it may
    // already have applied it via replace_function — splicing is idempotent).
    for (const t of targets) {
      try {
        await ctx.helpers.applyCandidate(t, lastTurn.text);
      } catch (err) {
        ctx.log("warn", `basic-match: no candidate spliced for ${t.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const results = await ctx.helpers.runBatchCycle(targets);
    const accepted: FunctionWorkItem[] = [];
    const rejected: FunctionWorkItem[] = [];
    const lines: string[] = [];
    for (const r of results) {
      if (r.accepted) {
        accepted.push(r.target);
        lines.push(`# ${r.targetId} — ${r.status} (cycle)`);
        continue;
      }
      // Cycle rejected/errored: the SPEC §9 diff verifier (hexdiff, fresh
      // build) gets the final say — byte-identity is decisive.
      const v = await ctx.helpers.diffVerify(r.target);
      if (v.accepted) {
        accepted.push(r.target);
        lines.push(`# ${r.targetId} — FULL_MATCH (diff verifier, ${String(v.total_instructions)} insns)`);
      } else {
        rejected.push(r.target);
        lines.push(
          `# ${r.targetId} — cycle ${r.status}, diff ${v.mismatch_count ?? "n/a"}/` +
            `${v.total_instructions ?? "n/a"} mismatches`,
        );
      }
    }
    return {
      accepted,
      rejected,
      feedback:
        `Batch-cycle + diff results for the previous attempt:\n` +
        `${lines.join("\n")}\n` +
        `Fix the rejected functions (read_source + replace_function + hexdiff) ` +
        `and resubmit. Your last reply began: ` +
        `${lastTurn.text.slice(0, 120)}…`,
    };
  },
});
