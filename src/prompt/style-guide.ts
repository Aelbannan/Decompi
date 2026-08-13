/**
 * Style-guide loader/injector (SPEC §12): the adapter's style guide is a
 * Markdown file that is the *source of truth* — the `style_guides` table is
 * only a UI/replay cache. `loadStyleGuide` reads the file and hashes its
 * bytes (sha256); `injectStyleGuide` appends the guide to the system portion
 * of a rendered template (the opening paragraph block, i.e. the system
 * directive) so it reads as system context ahead of the task body.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** A loaded style guide: original path, byte content, and its sha256 hash. */
export interface StyleGuide {
  path: string;
  contentHash: string;
  content: string;
}

/** Heading used when a style guide is injected into a rendered prompt. */
export const STYLE_GUIDE_SECTION = "## Style guide";

/**
 * Loads a style guide file and hashes its content with sha256 (hex digest).
 * The file is the source of truth; callers may cache the result keyed by
 * `contentHash` (e.g. in the `style_guides` UI/replay table).
 */
export async function loadStyleGuide(path: string): Promise<StyleGuide> {
  const content = await readFile(path, "utf8");
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  return { path, contentHash, content };
}

/**
 * Appends a style guide to the system portion of a rendered template. The
 * system portion is everything up to the first blank line (the template's
 * opening directive paragraph); the guide is inserted right after it as its
 * own section, staying ahead of the task body. A template with no blank
 * lines (single-paragraph system) gets the guide appended at the end.
 */
export function injectStyleGuide(rendered: string, styleGuide: string): string {
  const sep = "\n\n";
  const at = rendered.indexOf(sep);
  if (at === -1) {
    return `${rendered}${sep}${STYLE_GUIDE_SECTION}\n\n${styleGuide}`;
  }
  return (
    rendered.slice(0, at + sep.length) +
    `${STYLE_GUIDE_SECTION}\n\n${styleGuide}\n\n` +
    rendered.slice(at + sep.length)
  );
}
