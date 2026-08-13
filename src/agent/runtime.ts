/**
 * Agent execution abstraction (SPEC §11): model resolution, session creation,
 * and per-session prompting. `pi` is the default adapter; oh-my-pi is optional
 * (decided by A/B, not this spec). The real SDK wiring lands later — this
 * module defines the interface consumers compile against.
 */
import type { ModelSpec } from "../types.js";

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
  prompt(text: string): Promise<AgentResult>;
}

/** AgentRuntime abstraction (SPEC §11): `createSession`, model resolution, tool wiring. */
export interface AgentRuntime {
  /** Resolve a models.json name to its ModelSpec, or null if unknown. */
  resolveModel(name: string): Promise<ModelSpec | null>;
  /** Open a fresh session bound to a model, seeded with an initial prompt. */
  createSession(opts: {
    model: string;
    prompt: string;
    tools?: string[];
  }): Promise<AgentSession>;
}
