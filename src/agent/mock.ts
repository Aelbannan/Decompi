/**
 * Deterministic in-memory AgentRuntime (SPEC §11) for tests and dry runs.
 * The real pi SDK adapter lands later; this mock is the contract's reference
 * implementation:
 *  - model resolution against a local registry (constructor arg or register())
 *  - scripted per-session responses (FIFO queue, falls back to prompt-derived
 *    text when empty)
 *  - deterministic reply derivation: a `RESPOND: <text>` marker in the prompt,
 *    else a canned echo of the prompt's first line
 *  - per-session usage accounting (input/output measured in characters)
 *  - full call history on the runtime (`calls: {model, prompt, tools,
 *    customTools}[]`)
 *  - the SPEC §B.5 scripted tool-call hook: a FIFO `setScript()` of
 *    `{type:'tool', name, args}` / `{type:'reply', text}` entries — `prompt()`
 *    consumes entries until a `reply`, dispatching each `tool` entry to the
 *    registered handler (recorded in the session's `toolCalls` log); the
 *    `reply` text becomes the turn's `finalText`.
 */
import type { ModelSpec } from "../types.js";
import type { Tool, WorkflowCtx, WorkItemKind } from "../workflow/types.js";
import type {
  AgentResult,
  AgentRuntime,
  AgentSession,
  SessionUsage,
} from "./runtime.js";

/** Zeroed usage snapshot; seeds every session's counters. */
export function emptyUsage(): SessionUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** A recorded createSession() call on the runtime. */
export interface RuntimeCall {
  model: string;
  prompt: string;
  tools?: string[];
  /** The custom tool DEFINITIONS handed to the session (names only, for assertions). */
  customTools?: string[];
}

const RESPOND_MARKER = /RESPOND:\s*([^\n]*)/;

/**
 * Deterministic reply derived from the prompt: the text after a
 * `RESPOND: <text>` marker, else a canned echo of the first line.
 */
export function respondTo(prompt: string): string {
  const marker = prompt.match(RESPOND_MARKER);
  if (marker) return marker[1]!.trim();
  const firstLine = prompt.split("\n")[0]!.trim();
  return firstLine ? `echo: ${firstLine}` : "echo:";
}

// ── Scripted tool-call hook (SPEC §B.5) ───────────────────────────────────

/** A scripted tool call: dispatches the named registered handler with `args`. */
export interface ScriptToolEntry {
  type: "tool";
  name: string;
  args: Record<string, unknown>;
}

/** A scripted final reply: ends the prompt() turn with `text`. */
export interface ScriptReplyEntry {
  type: "reply";
  text: string;
}

/** A MockSession script entry (SPEC §B.5): tool calls until a final reply. */
export type ScriptEntry = ScriptToolEntry | ScriptReplyEntry;

/**
 * The stub ctx handed to scripted tool handlers (SPEC §B.5): the mock is a
 * pure function of its script, so handlers get a frozen empty context.
 */
const MOCK_CTX = Object.freeze({}) as WorkflowCtx<WorkItemKind, Record<string, unknown>>;

/** Mock session (SPEC §11 AgentSession) with scripted responses + usage accounting. */
export class MockSession implements AgentSession {
  /** Scripted responses consumed FIFO; when empty, replies are prompt-derived. */
  readonly responses: string[] = [];
  /** Usage counters, accumulated per prompt() call (input/output = chars). */
  readonly usage: SessionUsage = emptyUsage();
  /** Every prompt() text, in call order. */
  readonly promptHistory: string[] = [];
  /**
   * FIFO script (SPEC §B.5): `prompt()` consumes entries until a `reply`;
   * each `tool` entry invokes the registered handler synchronously.
   */
  readonly script: ScriptEntry[] = [];
  /** Every tool call executed from the script, in order (SPEC §B.5). */
  readonly toolCalls: ScriptToolEntry[] = [];
  /** Registered tool handlers by name (from the runtime's `customTools`). */
  private readonly handlers = new Map<string, Tool>();

  /**
   * Seed the scripted-response queue (the runtime's `scripted` option uses
   * this) and the session's toolset (SPEC §B.1: the definitions the script
   * can dispatch to).
   */
  constructor(initial: string[] = [], customTools: Tool[] = []) {
    this.responses.push(...initial);
    for (const tool of customTools) this.handlers.set(tool.name, tool);
  }

  /**
   * Append FIFO script entries (SPEC §B.5): the next `prompt()` consumes
   * entries until a `reply`, invoking each `tool` entry's registered handler
   * (recorded into `toolCalls`) and using the `reply` text as `finalText`.
   */
  setScript(entries: ScriptEntry[]): void {
    this.script.push(...entries);
  }

  async prompt(text: string): Promise<AgentResult> {
    this.promptHistory.push(text);
    let reply: string | undefined;
    // Consume the script FIFO until a reply (SPEC §B.5): each tool entry
    // invokes the registered handler synchronously (no nested model
    // round-trip — the script already encodes the outcome); the reply text
    // becomes the turn's final text. Exhausted script falls back to the
    // canned response queue, then to prompt-derived text.
    while (this.script.length > 0) {
      const entry = this.script.shift()!;
      if (entry.type === "reply") {
        reply = entry.text;
        break;
      }
      this.toolCalls.push(entry);
      const tool = this.handlers.get(entry.name);
      if (tool === undefined) {
        throw new Error(
          `MockSession: no handler registered for tool "${entry.name}" (session was created without it)`,
        );
      }
      await tool.run(MOCK_CTX, entry.args);
    }
    const finalText =
      reply ?? (this.responses.length > 0 ? this.responses.shift()! : respondTo(text));
    this.usage.input += text.length;
    this.usage.output += finalText.length;
    this.usage.cacheRead += text.length;
    this.usage.cacheWrite += finalText.length;
    // Snapshot so callers cannot mutate the session's live counters.
    return { finalText, usage: { ...this.usage } };
  }
}

/** Deterministic in-memory AgentRuntime (SPEC §11). */
export class MockAgentRuntime implements AgentRuntime {
  /** Registered model names → specs. */
  readonly models = new Map<string, ModelSpec>();
  /** Every createSession() call, in order (incl. rejected/unknown models). */
  readonly calls: RuntimeCall[] = [];
  /**
   * Scripted reply queues, one per created session (index = session creation
   * order). A session without a queue falls back to prompt-derived replies.
   */
  readonly scripted: string[][];
  /** Every created session, in creation order (for prompt/usage assertions). */
  readonly sessions: MockSession[] = [];

  constructor(
    models?: Record<string, ModelSpec> | Iterable<[string, ModelSpec]>,
    scripted: string[][] = [],
  ) {
    if (models) {
      const entries =
        models instanceof Map ? models : Object.entries(models);
      for (const [name, spec] of entries) this.models.set(name, spec);
    }
    this.scripted = scripted;
  }

  /** Register (or overwrite) a model spec under `name`. */
  register(name: string, spec: ModelSpec): this {
    this.models.set(name, spec);
    return this;
  }

  async resolveModel(name: string): Promise<ModelSpec | null> {
    return this.models.get(name) ?? null;
  }

  async createSession(opts: {
    model: string;
    prompt: string;
    tools?: string[];
    customTools?: Tool[];
  }): Promise<AgentSession> {
    this.calls.push({
      model: opts.model,
      prompt: opts.prompt,
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.customTools !== undefined
        ? { customTools: opts.customTools.map((t) => t.name) }
        : {}),
    });
    if (!this.models.has(opts.model)) {
      throw new Error(
        `MockAgentRuntime: unknown model "${opts.model}" (call register() first)`,
      );
    }
    const session = new MockSession(
      this.scripted[this.calls.length - 1] ?? [],
      opts.customTools ?? [],
    );
    this.sessions.push(session);
    return session;
  }
}
