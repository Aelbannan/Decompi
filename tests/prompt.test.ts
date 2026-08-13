/**
 * M3 tests for the prompt system (SPEC §12): templates render with context,
 * the style guide is loaded / hashed / injected, and prompt ids are stable
 * for identical inputs while changing when context, template, or style guide
 * differ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptBuilder, type PromptSpec } from "../src/prompt/builder.js";
import {
  STYLE_GUIDE_SECTION,
  injectStyleGuide,
  loadStyleGuide,
} from "../src/prompt/style-guide.js";
import { TEMPLATES, type TemplateContext } from "../src/prompt/templates.js";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Shared temp style-guide file (Markdown; the file is the source of truth). */
const GUIDE_CONTENT = "# Xenoblade style guide\n\nNever emit asm blocks.\n";
let tmpDir = "";
let guidePath = "";

test.before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "decompi-prompt-"));
  guidePath = join(tmpDir, "style-guide.md");
  await writeFile(guidePath, GUIDE_CONTENT, "utf8");
});

test.after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// templates.ts
// ---------------------------------------------------------------------------

test("match template renders with context", () => {
  const ctx: TemplateContext = {
    brief: "Match CFnMove::Update against retail bytecode.",
    priorDraft: "void CFnMove::Update() {}",
    siblings: ["CFnMove::Init", "CFnMove::Term"],
    walls: ["No asm blocks", "No __declspec"],
  };
  const rendered = TEMPLATES["match"]!(ctx);
  assert.match(rendered, /You are decompiling a function to match retail bytecode\./);
  assert.match(rendered, /CFnMove::Update against retail bytecode/);
  assert.match(rendered, /void CFnMove::Update\(\) \{\}/);
  assert.match(rendered, /CFnMove::Init/);
  assert.match(rendered, /No asm blocks/);
});

test("cleanup template renders with context", () => {
  const rendered = TEMPLATES["cleanup"]!({
    priorDraft: "int x=1;",
    walls: ["Keep the signature"],
  });
  assert.match(rendered, /Clean up the following code\./);
  assert.match(rendered, /int x=1;/);
  assert.match(rendered, /Keep the signature/);
});

test("templates render when context fields are absent", () => {
  const rendered = TEMPLATES["match"]!({});
  assert.match(rendered, /You are decompiling a function to match retail bytecode\./);
  assert.match(rendered, /\(none\)/);
  assert.equal(TEMPLATES["cleanup"]!({}).includes("Clean up the following code."), true);
});

test("templates render deterministically for identical context", () => {
  const ctx = { brief: "Match f", siblings: ["g"], walls: ["w"] };
  assert.equal(TEMPLATES["match"]!(ctx), TEMPLATES["match"]!(ctx));
});

// ---------------------------------------------------------------------------
// style-guide.ts
// ---------------------------------------------------------------------------

test("loadStyleGuide reads content and hashes it with sha256", async () => {
  const guide = await loadStyleGuide(guidePath);
  assert.equal(guide.path, guidePath);
  assert.equal(guide.content, GUIDE_CONTENT);
  assert.equal(guide.contentHash, sha256(GUIDE_CONTENT));
});

test("injectStyleGuide appends to the system portion", () => {
  const rendered = TEMPLATES["match"]!({ brief: "Match f" });
  const injected = injectStyleGuide(rendered, GUIDE_CONTENT);
  // Guide stays ahead of the task body and after the system directive.
  assert.ok(injected.indexOf(STYLE_GUIDE_SECTION) < injected.indexOf("## Task"));
  assert.ok(injected.indexOf(STYLE_GUIDE_SECTION) > rendered.indexOf("retail bytecode"));
  assert.ok(injected.includes(GUIDE_CONTENT));
  // System directive still leads the prompt.
  assert.ok(injected.startsWith("You are decompiling a function to match retail bytecode."));
});

test("injectStyleGuide appends when the template has no blank line", () => {
  const injected = injectStyleGuide("Single line directive.", "rules");
  assert.match(injected, /^Single line directive\.\n\n## Style guide\n\nrules$/);
});

// ---------------------------------------------------------------------------
// builder.ts
// ---------------------------------------------------------------------------

test("build injects and hashes the style guide", async () => {
  const builder = new PromptBuilder();
  const spec: PromptSpec = { template: "match", context: { brief: "Match f" } };
  const prompt = await builder.build(spec, { styleGuide: { path: guidePath } });

  assert.match(prompt.rendered, new RegExp(STYLE_GUIDE_SECTION));
  assert.match(prompt.rendered, /Never emit asm blocks\./);
  assert.equal(prompt.styleGuideHash, sha256(GUIDE_CONTENT));
  assert.equal(prompt.contextHash, sha256(JSON.stringify({ brief: "Match f" })));
  assert.equal(
    prompt.id,
    sha256(`match${prompt.styleGuideHash}${prompt.contextHash}`),
  );
});

test("build without a style guide leaves styleGuideHash empty", async () => {
  const builder = new PromptBuilder();
  const prompt = await builder.build({ template: "match", context: { brief: "Match f" } });
  assert.equal(prompt.styleGuideHash, "");
  assert.ok(!prompt.rendered.includes(STYLE_GUIDE_SECTION));
});

test("styleGuide: false skips injection even when a guide is provided", async () => {
  const builder = new PromptBuilder();
  const prompt = await builder.build(
    { template: "match", styleGuide: false, context: { brief: "Match f" } },
    { styleGuide: { path: guidePath } },
  );
  assert.equal(prompt.styleGuideHash, "");
  assert.ok(!prompt.rendered.includes(STYLE_GUIDE_SECTION));
});

test("id is stable for identical inputs and changes when context differs", async () => {
  const builder = new PromptBuilder();
  const ctx = { brief: "Match f", walls: ["no asm"] };
  const a = await builder.build({ template: "match", context: ctx });
  const b = await builder.build({ template: "match", context: ctx });

  assert.equal(a.id, b.id);
  assert.equal(a.contextHash, b.contextHash);
  assert.equal(a.rendered, b.rendered);

  const c = await builder.build({ template: "match", context: { ...ctx, brief: "Match g" } });
  assert.notEqual(a.id, c.id);
  assert.notEqual(a.contextHash, c.contextHash);
});

test("id changes when the template changes, context stays the same", async () => {
  const builder = new PromptBuilder();
  const ctx = { priorDraft: "int x=1;" };
  const match = await builder.build({ template: "match", context: ctx });
  const cleanup = await builder.build({ template: "cleanup", context: ctx });
  assert.notEqual(match.id, cleanup.id);
  assert.equal(match.contextHash, cleanup.contextHash);
});

test("id changes when a style guide is introduced", async () => {
  const builder = new PromptBuilder();
  const spec: PromptSpec = { template: "match", context: { brief: "Match f" } };
  const bare = await builder.build(spec);
  const guided = await builder.build(spec, { styleGuide: { path: guidePath } });
  assert.notEqual(bare.id, guided.id);
  assert.equal(bare.contextHash, guided.contextHash);
  assert.notEqual(bare.styleGuideHash, guided.styleGuideHash);
});

test("unknown template rejects", async () => {
  const builder = new PromptBuilder();
  await assert.rejects(
    builder.build({ template: "does-not-exist" }),
    /Unknown prompt template: does-not-exist/,
  );
});
