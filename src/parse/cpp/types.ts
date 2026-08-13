/**
 * Shared types for the C++ parse layer (M1a): findings produced by rules and
 * the rule interfaces consumed by the source-rule and delta gates.
 */

/** A single rule hit: which rule fired, where (1-indexed line/col), and why. */
export interface Finding {
  rule: string;
  line: number;
  column?: number;
  snippet?: string;
  message: string;
}

/** A rule over a parsed syntax tree (source-rule gate; M1b). */
export interface SourceRule {
  id: string;
  description: string;
  run(root: import("tree-sitter").SyntaxNode, source: string): Finding[];
}

/**
 * Minimal per-file context threaded through the delta gate's line loop.
 * Carries the source path plus a mutable bag for cross-line state; the delta
 * agent extends this interface with its own typed state.
 */
export interface DeltaCtx {
  /** Path of the source file being scanned. */
  sourcePath: string;
  /** Cross-line state shared across lines of a single file scan. */
  state: Record<string, unknown>;
}

/** A rule over raw source lines (delta gate). */
export interface DeltaRule {
  id: string;
  description: string;
  check(line: { line: number; text: string }, ctx: DeltaCtx): Finding | undefined;
}
