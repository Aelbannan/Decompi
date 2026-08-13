/**
 * PromptBuilder (SPEC §12): turns a `PromptSpec` into a versioned, hashable
 * `Prompt`. The template renders the system directive + task scaffolding,
 * the adapter's style guide (Markdown; the file is the source of truth) is
 * loaded, hashed and injected into the system portion, and the prompt is
 * identified by `sha256(template + styleGuideHash + contextHash)` so
 * identical inputs replay identical prompts (`spans.prompt_id` links each
 * agent-turn span for replay/audit).
 */
import { createHash } from "node:crypto";
import { injectStyleGuide, loadStyleGuide } from "./style-guide.js";
import { TEMPLATES, type TemplateContext } from "./templates.js";

/** Input to a prompt build (SPEC §12). */
export interface PromptSpec {
  template: string;
  model?: string;
  /** Default true; `false` skips style-guide injection even when one is provided. */
  styleGuide?: boolean;
  /** Template context: brief, prior draft, siblings, walls… */
  context?: Record<string, unknown>;
}

/** Versioned, hashable prompt artifact (SPEC §12). */
export interface Prompt {
  /** sha256(template + styleGuideHash + contextHash). */
  id: string;
  rendered: string;
  styleGuideHash: string;
  contextHash: string;
}

export interface BuildOptions {
  /** Adapter style guide (Markdown file). */
  styleGuide?: { path: string };
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Builds versioned prompts from specs (SPEC §12). */
export class PromptBuilder {
  async build(spec: PromptSpec, opts: BuildOptions = {}): Promise<Prompt> {
    const render = TEMPLATES[spec.template];
    if (!render) {
      throw new Error(`Unknown prompt template: ${spec.template}`);
    }
    const context = spec.context ?? {};
    let rendered = render(context as TemplateContext);
    let styleGuideHash = "";
    if (spec.styleGuide !== false && opts.styleGuide?.path) {
      const guide = await loadStyleGuide(opts.styleGuide.path);
      rendered = injectStyleGuide(rendered, guide.content);
      styleGuideHash = guide.contentHash;
    }
    const contextHash = sha256(JSON.stringify(context));
    const id = sha256(`${spec.template}${styleGuideHash}${contextHash}`);
    return { id, rendered, styleGuideHash, contextHash };
  }
}
