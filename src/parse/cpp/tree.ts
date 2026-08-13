/**
 * Thin wrapper over tree-sitter + tree-sitter-cpp (M1a): parsing a C++
 * translation unit into a syntax tree, plus small traversal / text / position
 * helpers used by the source-rule gate.
 */
import Parser from "tree-sitter";
import Cpp from "tree-sitter-cpp";
import type { SyntaxNode, Tree } from "tree-sitter";

/** Parse `source` as C++, returning the tree and its root node. */
export function parseCpp(source: string): { tree: Tree; root: SyntaxNode } {
  const parser = new Parser();
  parser.setLanguage(Cpp);
  const tree = parser.parse(source);
  return { tree, root: tree.rootNode };
}

/** Pre-order traversal: visits `node` itself, then each child recursively. */
export function walk(node: SyntaxNode, fn: (node: SyntaxNode) => void): void {
  fn(node);
  for (const child of node.namedChildren) {
    walk(child, fn);
  }
}

/** All named descendant nodes with the given node type (excludes `node` itself). */
export function descendants(node: SyntaxNode, type: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode): void => {
    for (const child of n.namedChildren) {
      if (child.type === type) {
        out.push(child);
      }
      visit(child);
    }
  };
  visit(node);
  return out;
}

/** The exact source text spanned by `node`. */
export function nodeText(node: SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

/** `node`'s start position as 1-indexed line / column. */
export function nodeLoc(node: SyntaxNode): { line: number; column: number } {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}
