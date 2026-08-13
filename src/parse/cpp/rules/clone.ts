/**
 * M1a clone/duplicate source rules (SPEC §13.1) — tree-sitter CST subtree-hash
 * similarity detection. Two rules, no Python reference (SPEC additions):
 *
 *   clone.repeated_code    identical function bodies (compound_statement of a
 *                          function_definition), normalized subtree hash
 *   clone.duplicate_class  identical class/struct definitions (whole
 *                          class_specifier / struct_specifier node), normalized
 *                          subtree hash
 *
 * Normalization collapses whitespace and strips `//` and block comments, so
 * two bodies that differ only in formatting or comments hash equal. The FIRST
 * occurrence (in file order) of each hash group is the canonical copy; every
 * later occurrence is reported as a duplicate pointing at the canonical line.
 *
 * Thresholds (documented): a candidate body/class must normalize to at least
 * `MIN_CLONE_LEN` characters — below that (empty bodies, trivial stubs) the
 * rules stay silent. `clone.repeated_code` covers whole function bodies only:
 * intra-function block duplication is deliberately out of scope for M1a.
 */
import type { SyntaxNode } from "tree-sitter";
import { descendants, nodeLoc, nodeText } from "../tree.js";
import type { Finding, SourceRule } from "../types.js";

/** Minimum normalized text length for a clone candidate (anti-noise). */
const MIN_CLONE_LEN = 12;

/** Collapse whitespace and strip comments; the subtree-hash key. */
function normalizeCloneText(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One candidate clone: node, normalized hash, and its name (classes only). */
interface CloneCandidate {
  node: SyntaxNode;
  hash: string;
  name: string;
}

/**
 * Class/struct *definitions* (body present) with a normalized hash. The class
 * NAME is normalized out (`N`): two structurally identical classes under
 * different names are duplicates — the name itself is not part of the shape.
 */
function classCandidates(root: SyntaxNode, source: string): CloneCandidate[] {
  const out: CloneCandidate[] = [];
  const visit = (specType: "class_specifier" | "struct_specifier"): void => {
    for (const spec of descendants(root, specType)) {
      if (!spec.namedChildren.some((c) => c.type === "field_declaration_list")) continue;
      const nameNode = spec.namedChildren.find((c) => c.type === "type_identifier");
      const name = nameNode === undefined ? "(anonymous)" : nodeText(nameNode, source);
      let raw = nodeText(spec, source);
      if (nameNode !== undefined) {
        raw =
          raw.slice(0, nameNode.startIndex - spec.startIndex) +
          "N" +
          raw.slice(nameNode.endIndex - spec.startIndex);
      }
      const hash = normalizeCloneText(raw);
      if (hash.length < MIN_CLONE_LEN) continue;
      out.push({ node: spec, hash, name });
    }
  };
  visit("class_specifier");
  visit("struct_specifier");
  return out;
}

/** Function bodies (compound_statement whose parent is a function_definition). */
function bodyCandidates(root: SyntaxNode, source: string): CloneCandidate[] {
  const out: CloneCandidate[] = [];
  for (const body of descendants(root, "compound_statement")) {
    if (body.parent === null || body.parent.type !== "function_definition") continue;
    const hash = normalizeCloneText(nodeText(body, source));
    if (hash.length < MIN_CLONE_LEN) continue;
    out.push({ node: body, hash, name: "" });
  }
  return out;
}

/** Report every occurrence of a hash group after the canonical (first) one. */
function reportDuplicates(
  candidates: CloneCandidate[],
  source: string,
  rule: string,
  label: string,
): Finding[] {
  const byHash = new Map<string, CloneCandidate[]>();
  for (const c of candidates) {
    const group = byHash.get(c.hash);
    if (group === undefined) byHash.set(c.hash, [c]);
    else group.push(c);
  }
  const out: Finding[] = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    // File order; the first copy is canonical.
    group.sort((a, b) => a.node.startIndex - b.node.startIndex);
    const first = group[0]!;
    const firstLoc = nodeLoc(first.node);
    for (const dup of group.slice(1)) {
      const loc = nodeLoc(dup.node);
      const who = dup.name.length > 0 ? ` '${dup.name}'` : "";
      out.push({
        rule,
        line: loc.line,
        column: loc.column,
        snippet: nodeText(dup.node, source).trim().replace(/\s+/g, " ").slice(0, 100),
        message:
          `duplicate ${label}${who} (${group.length} copies) — identical to the ` +
          `copy at line ${firstLoc.line}; extract the shared shape`,
      });
    }
  }
  return out;
}

/** Identical class/struct definitions (whole-node normalized hash). */
function collectDuplicateClass(root: SyntaxNode, source: string): Finding[] {
  return reportDuplicates(classCandidates(root, source), source, "clone.duplicate_class", "class/struct definition");
}

/** Identical function bodies (whole-body normalized hash). */
function collectRepeatedCode(root: SyntaxNode, source: string): Finding[] {
  return reportDuplicates(bodyCandidates(root, source), source, "clone.repeated_code", "function body");
}

/** The two clone/duplicate source rules (SPEC §13.1 order, ids stable). */
export const cloneRules: SourceRule[] = [
  {
    id: "clone.repeated_code",
    description:
      "identical function bodies (normalized subtree hash; first copy is canonical)",
    run: collectRepeatedCode,
  },
  {
    id: "clone.duplicate_class",
    description:
      "identical class/struct definitions (normalized subtree hash; first copy is canonical)",
    run: collectDuplicateClass,
  },
];
