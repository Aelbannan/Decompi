/**
 * Real pi SDK agent runtime tests (SPEC §11 adapter): model resolution and
 * the Decompi `Tool` → pi `ToolDefinition` mapping. The LIVE
 * `createSession`/`prompt` path needs provider auth and an on-disk session,
 * so it is NOT exercised here (the structure mirrors the xenoblade pi-harness
 * `session.ts`); `resolveModel` and `toPiTool` are pure functions of the
 * fake runtime / the tool definition and run with zero credentials.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSpec } from "../src/types.js";
import type { Tool } from "../src/workflow/types.js";
import { PiAgentRuntime, toPiTool } from "../src/agent/pi-runtime.js";

const SPEC: ModelSpec = {
  provider: "nube",
  model: "ds4-flash",
  thinkingLevel: "low",
  maxTokens: 0,
  rpm: 20,
  cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
};

/**
 * A fake ModelRuntime: no network, no auth, no model catalog — just enough
 * surface for the PiAgentRuntime constructor to typecheck and for the
 * resolveModel path to run (createSession is not exercised here).
 */
function fakeRuntime(): ModelRuntime {
  return {
    getModel: () => undefined,
    getAvailable: async () => [],
  } as unknown as ModelRuntime;
}

/** A spy hexdiff tool: records every invocation and returns a canned diff. */
function hexdiffTool(seen: Array<{ unit: string; symbol: string }>): Tool {
  return {
    name: "hexdiff",
    description: "diff one function against retail",
    inputSchema: z.object({ unit: z.string(), symbol: z.string() }),
    run: async (_ctx, args: { unit: string; symbol: string }) => {
      seen.push(args);
      return { mismatch_count: 3, unit: args.unit, symbol: args.symbol };
    },
  };
}

// ---------------------------------------------------------------------------
// (a) resolveModel: name → ModelSpec from the constructor's models map
// ---------------------------------------------------------------------------

test("PiAgentRuntime.resolveModel: returns the registered spec, null for unknown names", async () => {
  const rt = new PiAgentRuntime({
    runtime: fakeRuntime(),
    models: new Map([["default", SPEC]]),
  });

  assert.deepEqual(await rt.resolveModel("default"), SPEC);
  assert.equal(await rt.resolveModel("nope"), null);
});

// ---------------------------------------------------------------------------
// (b) toPiTool: zod inputSchema → JSON schema parameters, execute → content
// ---------------------------------------------------------------------------

test("toPiTool: maps name/description and converts the zod schema to a JSON schema", () => {
  const seen: Array<{ unit: string; symbol: string }> = [];
  const piTool = toPiTool(hexdiffTool(seen));

  assert.equal(piTool.name, "hexdiff");
  assert.equal(piTool.label, "hexdiff");
  assert.equal(piTool.description, "diff one function against retail");

  // zod v4's z.toJSONSchema output: a plain JSON schema object.
  const params = piTool.parameters as Record<string, unknown>;
  assert.equal(params.type, "object");
  assert.deepEqual(params.required, ["unit", "symbol"]);
  const properties = params.properties as Record<string, { type: string }>;
  assert.equal(properties.unit.type, "string");
  assert.equal(properties.symbol.type, "string");
});

test("toPiTool.execute: runs the handler with the parsed args and returns text content", async () => {
  const seen: Array<{ unit: string; symbol: string }> = [];
  const piTool = toPiTool(hexdiffTool(seen));

  const exec = piTool.execute as (
    toolCallId: string,
    params: { unit: string; symbol: string },
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
  const result = await exec("call-1", { unit: "kyoshin/CGame", symbol: "func_80000000" });

  // The handler ran with the pi call's parsed args (a real side effect).
  assert.deepEqual(seen, [{ unit: "kyoshin/CGame", symbol: "func_80000000" }]);
  // The handler's return value is fed back to the model as a text part.
  assert.deepEqual(result.content, [
    { type: "text", text: String({ mismatch_count: 3, unit: "kyoshin/CGame", symbol: "func_80000000" }) },
  ]);
  assert.deepEqual(result.details, {});
});

test("toPiTool.execute: a throwing handler surfaces as a rejected promise (SDK turns it into a tool error)", async () => {
  const boom: Tool = {
    name: "boom",
    description: "always throws",
    inputSchema: z.object({}),
    run: async () => {
      throw new Error("nope");
    },
  };
  const piTool = toPiTool(boom);
  const exec = piTool.execute as (toolCallId: string, params: Record<string, never>) => Promise<unknown>;
  await assert.rejects(exec("call-1", {}), /nope/);
});
