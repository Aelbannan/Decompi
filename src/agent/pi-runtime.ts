/**
 * Real pi SDK agent runtime (SPEC §11 adapter). `createSession` opens a
 * persistent on-disk pi session under `.decompi/sessions` through
 * `createAgentSession`, mapping Decompi's typed `Tool` definitions onto pi's
 * `defineTool` surface (zod `inputSchema` → JSON-schema parameters, `run` →
 * `AgentToolResult` content).
 *
 * Mirrors the reference integration in the xenoblade pi-harness
 * (`tools/pi_harness/src/session.ts` + `session-tools.ts`): model resolution
 * errors list the runtime's available models, prompts run with
 * `expandPromptTemplates: false`, the final text is the last assistant
 * message's text parts, and per-turn usage is summed from the assistant
 * messages in `session.state.messages` (input/output/cacheRead/cacheWrite).
 */
import { z } from "zod";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  type AgentSession as PiSession,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ModelSpec } from "../types.js";
import type { Tool, WorkflowCtx, WorkItemKind } from "../workflow/types.js";
import type {
  AgentResult,
  AgentRuntime,
  AgentSession,
  SessionUsage,
} from "./runtime.js";

/**
 * Stub `WorkflowCtx` handed to tool handlers while the pi transport executes
 * a tool call. The engine builds the REAL per-run `WorkflowCtx` in the
 * compiled workflow hooks (`startPrompt`/`reprompt`/`complete`); the
 * `AgentRuntime.createSession` contract does not carry it into the SDK
 * session, so the transport-side tools run against the same frozen empty ctx
 * the `MockAgentRuntime` passes to its scripted handlers. Tools that need
 * engine state (finalize/helpers) are engine-owned, not transport tools.
 */
const TOOL_CTX = Object.freeze({}) as WorkflowCtx<WorkItemKind, Record<string, unknown>>;

/**
 * Sum token usage across assistant messages in a pi session state — mirrors
 * session.ts's `sumUsage` (usage lives on assistant messages only; missing
 * buckets count as 0).
 */
function sumUsage(messages: readonly unknown[]): SessionUsage {
  const usage: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of messages) {
    if ((m as { role?: unknown }).role !== "assistant") continue;
    const u = (m as { usage?: Partial<SessionUsage> }).usage;
    if (!u) continue;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.cacheWrite += u.cacheWrite ?? 0;
  }
  return usage;
}

/**
 * Concatenated text of the LAST assistant message's text content parts —
 * mirrors session.ts's `runOnePrompt` capture logic (string content used
 * verbatim; array content keeps only `{type:"text"}` parts).
 */
function lastAssistantText(messages: readonly unknown[]): string {
  const assistant = messages.filter((m) => (m as { role?: unknown }).role === "assistant");
  const last = assistant.length > 0 ? assistant[assistant.length - 1] : undefined;
  if (!last) return "";
  const content = (last as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

/**
 * Map a Decompi `Tool` to a pi SDK `ToolDefinition` (SPEC §B.2): the zod
 * `inputSchema` becomes the tool's JSON-schema `parameters` (zod v4's
 * built-in `z.toJSONSchema` — pi's TypeBox-backed argument validation
 * accepts plain JSON schemas: validation falls back to a JSON-schema
 * coercion path when the schema lacks the TypeBox Kind marker), and
 * `execute` runs the handler and feeds its result back to the model as a
 * text content part. A throw surfaces as a tool-error result (the SDK
 * catches it); `details` stays empty — Decompi's engine reads the content.
 */
export function toPiTool(tool: Tool): ToolDefinition {
  const parameters = z.toJSONSchema(tool.inputSchema) as unknown as ToolDefinition["parameters"];
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = await tool.run(TOOL_CTX, params as z.infer<typeof tool.inputSchema>);
      return {
        content: [{ type: "text", text: String(result) }],
        details: {},
      };
    },
  });
}

/**
 * One live pi SDK session wrapped as a Decompi {@link AgentSession}. The pi
 * session owns the tool-call loop (the model may make 0+ tool calls per
 * prompt; pi runs each handler and feeds the result back until the model
 * emits a final answer).
 */
export class PiAgentSession implements AgentSession {
  private disposed = false;

  constructor(private readonly session: PiSession) {}

  /**
   * One agentic turn (SPEC §B.3): mirror session.ts — subscribe for the
   * final assistant text (the `agent_end` event carries the session's final
   * messages; a later `agent_end`, e.g. after an auto-retry, overwrites the
   * earlier capture), `await session.prompt(...)` with prompt templates
   * disabled, then sum usage from the post-prompt `session.state.messages`.
   * The post-prompt state is authoritative (session.ts's `runOnePrompt`
   * reads it the same way), so a prompt that settled without an
   * `agent_end` event (abort / hard timeout) still yields its last
   * assistant text.
   */
  async prompt(text: string): Promise<AgentResult> {
    if (this.disposed) throw new Error("PiAgentSession: session is disposed");
    let finalText = "";
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "agent_end") {
        finalText = lastAssistantText(event.messages);
      }
    });
    try {
      await this.session.prompt(text, { expandPromptTemplates: false });
    } finally {
      unsubscribe();
    }
    if (finalText === "") {
      finalText = lastAssistantText(this.session.state.messages);
    }
    return { finalText, usage: sumUsage(this.session.state.messages) };
  }

  /** Release the pi session (persistence + subscriptions + agent hooks). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
  }
}

/**
 * Real pi SDK {@link AgentRuntime} (SPEC §11): resolves model names against
 * a name → {@link ModelSpec} map (loaded from the `models` table /
 * models.json by the wiring) and opens live sessions via
 * `createAgentSession`. Construction is cheap — no network or auth
 * happens until a session is actually created.
 */
export class PiAgentRuntime implements AgentRuntime {
  private readonly runtime: ModelRuntime;
  private readonly models: Map<string, ModelSpec>;

  constructor(opts: { runtime: ModelRuntime; models: Map<string, ModelSpec> }) {
    this.runtime = opts.runtime;
    this.models = opts.models;
  }

  /** Resolve a models.json name to its ModelSpec, or null if unknown. */
  async resolveModel(name: string): Promise<ModelSpec | null> {
    return this.models.get(name) ?? null;
  }

  /**
   * Open a fresh pi session bound to the named model, seeded with `prompt`.
   * The session toolset = the name allowlist (`tools`, unchanged shipped
   * meaning) plus the custom tool DEFINITIONS (`customTools`, SPEC §B.1/B.2)
   * — mirroring session.ts, every custom definition's name is also added to
   * the allowlist so the SDK actually exposes it.
   */
  async createSession(opts: {
    model: string;
    prompt: string;
    tools?: string[];
    customTools?: Tool[];
  }): Promise<AgentSession> {
    const spec = this.models.get(opts.model);
    if (!spec) {
      throw new Error(
        `PiAgentRuntime: unknown model "${opts.model}" (not in the models map)`,
      );
    }
    // Canonical model/auth runtime resolves the spec's provider/model id.
    const model = this.runtime.getModel(spec.provider, spec.model);
    if (!model) {
      // Mirror session.ts: surface the runtime's configured models so the
      // caller can see what provider/model ids are actually available.
      const available = await this.runtime.getAvailable();
      const names = available.map((m) => `${m.provider}/${m.id}`).join(", ");
      throw new Error(
        `Model "${spec.provider}/${spec.model}" not found. ` +
          `Available models: ${names || "(none configured)"}.`,
      );
    }

    const { session } = await createAgentSession({
      model,
      thinkingLevel: spec.thinkingLevel,
      modelRuntime: this.runtime,
      sessionManager: SessionManager.create(process.cwd(), ".decompi/sessions"),
      tools: [...(opts.tools ?? []), ...(opts.customTools ?? []).map((t) => t.name)],
      customTools: (opts.customTools ?? []).map((t) => toPiTool(t)),
    });
    return new PiAgentSession(session);
  }
}
