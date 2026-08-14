/**
 * Agent execution abstraction (SPEC §11): model resolution, session creation,
 * and per-session prompting. `pi` is the default adapter; oh-my-pi is optional
 * (decided by A/B, not this spec). The real SDK wiring lands later — this
 * module defines the interface consumers compile against.
 */
import type { ModelSpec } from "../types.js";
import type { Tool } from "../workflow/types.js";

/** Token-count snapshot for one session (SPEC §14 cost-model buckets). */
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Outcome of a single `prompt` turn. */
export interface AgentResult {
  finalText: string;
  usage: SessionUsage;
}

/** A long-lived agent conversation; `prompt` appends a turn and awaits the reply. */
export interface AgentSession {
  /**
   * One agentic turn (SPEC §B.3): the model may make 0+ tool calls; the
   * harness/session runs each registered handler and feeds the result back
   * until the model emits a final answer. Resolves with that final result;
   * `usage` is CUMULATIVE across the whole turn (every sub-request).
   */
  prompt(text: string): Promise<AgentResult>;
}

/** AgentRuntime abstraction (SPEC §11): `createSession`, model resolution, tool wiring. */
export interface AgentRuntime {
  /** Resolve a models.json name to its ModelSpec, or null if unknown. */
  resolveModel(name: string): Promise<ModelSpec | null>;
  /**
   * Open a fresh session bound to a model, seeded with an initial prompt.
   * `tools` is the NAME allowlist (unchanged shipped meaning); `customTools`
   * carries the tool DEFINITIONS the session may invoke (SPEC §B.1/B.2).
   */
  createSession(opts: {
    model: string;
    prompt: string;
    tools?: string[];
    customTools?: Tool[];
  }): Promise<AgentSession>;
}
