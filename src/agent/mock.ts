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
 *  - full call history on the runtime (`calls: {model, prompt, tools}[]`)
 */
import type { ModelSpec } from "../types.js";
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

/** Mock session (SPEC §11 AgentSession) with scripted responses + usage accounting. */
export class MockSession implements AgentSession {
  /** Scripted responses consumed FIFO; when empty, replies are prompt-derived. */
  readonly responses: string[] = [];
  /** Usage counters, accumulated per prompt() call (input/output = chars). */
  readonly usage: SessionUsage = emptyUsage();
  /** Every prompt() text, in call order. */
  readonly promptHistory: string[] = [];

  /** Seed the scripted-response queue (the runtime's `scripted` option uses this). */
  constructor(initial: string[] = []) {
    this.responses.push(...initial);
  }

  prompt(text: string): Promise<AgentResult> {
    this.promptHistory.push(text);
    const finalText =
      this.responses.length > 0 ? this.responses.shift()! : respondTo(text);
    this.usage.input += text.length;
    this.usage.output += finalText.length;
    this.usage.cacheRead += text.length;
    this.usage.cacheWrite += finalText.length;
    // Snapshot so callers cannot mutate the session's live counters.
    return Promise.resolve({ finalText, usage: { ...this.usage } });
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
  }): Promise<AgentSession> {
    this.calls.push({
      model: opts.model,
      prompt: opts.prompt,
      ...(opts.tools ? { tools: opts.tools } : {}),
    });
    if (!this.models.has(opts.model)) {
      throw new Error(
        `MockAgentRuntime: unknown model "${opts.model}" (call register() first)`,
      );
    }
    const session = new MockSession(this.scripted[this.calls.length - 1] ?? []);
    this.sessions.push(session);
    return session;
  }
}
