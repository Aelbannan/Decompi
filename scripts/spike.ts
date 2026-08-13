#!/usr/bin/env node
/**
 * M1a tree-sitter spike (SPEC §19): scan a set of C++ source trees and report
 * tree-sitter-cpp error-node statistics.
 *
 * Usage:
 *   npx tsx scripts/spike.ts <dir> [<dir> ...]
 *
 * For every `.cpp` / `.c` / `.hpp` / `.h` file under the given directories the
 * script parses the whole file with `parseCpp` and, when `root.hasError` is
 * true, counts the CONCRETE error nodes (any node whose `isError` / `isMissing`
 * is set; `hasError` ancestors are NOT counted — they would double-count). It then prints a
 * summary to stdout and writes the full report to `docs/m1a-tree-spike.md`
 * (relative to the current working directory).
 *
 * Output paths in the report are relative to the current working directory so
 * the document is stable across machines.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { SyntaxNode } from "tree-sitter";

import { nodeLoc, parseCpp } from "../src/parse/cpp/tree.js";

/** Extension set scanned by the spike (case-insensitive). */
const CPP_EXTS = new Set([".cpp", ".c", ".hpp", ".h"]);

/** Maximum number of error-node samples kept per file. */
const SAMPLES_PER_FILE = 5;

interface ErrorSample {
  line: number;
  column: number;
  text: string;
}

interface FileResult {
  /** Absolute path of the scanned file. */
  path: string;
  /** File size in bytes (raw buffer length). */
  size: number;
  /** Number of nodes matching the error predicates. */
  errorNodes: number;
  /** Total nodes in the tree (root.descendantCount). */
  totalNodes: number;
  /** Error-node text samples (first `SAMPLES_PER_FILE` matches). */
  samples: ErrorSample[];
  /** Set when `parseCpp` threw; `errorNodes` is then 0. */
  exception?: string;
}

interface Report {
  scanned: number;
  errorFiles: number;
  threwFiles: number;
  totalNodes: number;
  totalErrorNodes: number;
  files: FileResult[];
  /** exception message -> number of files that threw it */
  exceptionMessages: Map<string, number>;
  /** size of the largest file that parsed OK (bytes) */
  maxOkSize: number;
  /** size of the smallest file that threw (bytes) */
  minThrewSize: number;
}

/**
 * True when `n` is an error node per the M1a definition. Counts only
 * CONCRETE error nodes — `isError` (ERROR-type) or `isMissing` — never
 * `hasError` ancestors, which merely CONTAIN a nested error and would
 * double-count every error region once per ancestor level.
 */
function isErrorNode(n: SyntaxNode): boolean {
  return n.isError || n.type === "ERROR" || n.isMissing;
}

/**
 * Visit every node in the subtree (named and anonymous), unlike `walk` in
 * tree.ts which only visits named children: missing tokens are anonymous and
 * would otherwise be skipped.
 */
function forEveryNode(node: SyntaxNode, fn: (node: SyntaxNode) => void): void {
  fn(node);
  for (const child of node.children) {
    forEveryNode(child, fn);
  }
}

/** Recursively collect `.cpp/.c/.hpp/.h` files under `dir` (skips hidden). */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && CPP_EXTS.has(extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  visit(dir);
  return out;
}

/** Scan a single file: parse it and count error nodes. */
function scanFile(file: string): FileResult {
  const buf = readFileSync(file);
  const source = buf.toString("utf8");
  const base: FileResult = {
    path: file,
    size: buf.byteLength,
    errorNodes: 0,
    totalNodes: 0,
    samples: [],
  };
  let root: SyntaxNode;
  try {
    ({ root } = parseCpp(source));
  } catch (err) {
    base.exception = err instanceof Error ? err.message : String(err);
    return base;
  }
  base.totalNodes = root.descendantCount;
  if (!root.hasError) {
    return base;
  }
  const isError = (n: SyntaxNode): void => {
    if (!isErrorNode(n)) {
      return;
    }
    base.errorNodes += 1;
    // Keep samples only for concrete ERROR / missing nodes, not for the
    // `hasError` ancestors that merely contain a nested error.
    if (base.samples.length < SAMPLES_PER_FILE && n.isError) {
      const loc = nodeLoc(n);
      base.samples.push({ line: loc.line, column: loc.column, text: source.slice(n.startIndex, n.endIndex) });
    }
  };
  forEveryNode(root, isError);
  return base;
}

/** One-line snippet for a sample (collapses whitespace, trims). */
function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

/** Renders the markdown report body (data sections). */
function render(report: Report, roots: string[]): string {
  const percent = (part: number, whole: number): string =>
    whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;
  const errorRatePer1k = report.totalNodes === 0 ? 0 : (report.totalErrorNodes / report.totalNodes) * 1000;
  const errorRatePerFile = report.scanned === 0 ? 0 : report.totalErrorNodes / report.scanned;

  const lines: string[] = [];
  lines.push("# M1a tree-sitter spike report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Scanned roots: ${roots.map((r) => `\`${r}\``).join(", ")}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  lines.push(`| files scanned | ${report.scanned} |`);
  lines.push(`| files with error nodes (\`root.hasError\`) | ${report.errorFiles} (${percent(report.errorFiles, report.scanned)}) |`);
  lines.push(`| parse exceptions | ${report.threwFiles} |`);
  lines.push(`| total nodes (all files, \`descendantCount\`) | ${report.totalNodes} |`);
  lines.push(`| total error-node matches | ${report.totalErrorNodes} |`);
  lines.push(`| error-node rate (per 1k nodes) | ${errorRatePer1k.toFixed(2)} |`);
  lines.push(`| error-node rate (per file) | ${errorRatePerFile.toFixed(2)} |`);
  lines.push("");
  lines.push("## Top 20 offenders");
  lines.push("");
  lines.push("Sorted by error-node count (desc), then size (desc), then path.");
  lines.push("");
  lines.push("| file | errors | size (bytes) |");
  lines.push("| --- | ---: | ---: |");

  const top = [...report.files].sort((a, b) => {
    if (a.errorNodes !== b.errorNodes) {
      return b.errorNodes - a.errorNodes;
    }
    if (a.size !== b.size) {
      return b.size - a.size;
    }
    return a.path.localeCompare(b.path);
  });
  for (const f of top.slice(0, 20)) {
    lines.push(`| ${relative(process.cwd(), f.path)} | ${f.errorNodes} | ${f.size} |`);
  }

  const withSamples = top.filter((f) => f.samples.length > 0);
  if (withSamples.length > 0) {
    lines.push("");
    lines.push("## Error-node samples");
    lines.push("");
    lines.push("First samples from the worst offenders (`line:col` of the first error node per file, snippet truncated to 100 chars).");
    lines.push("");
    for (const f of withSamples.slice(0, 5)) {
      lines.push(`### ${relative(process.cwd(), f.path)}`);
      lines.push("");
      for (const s of f.samples) {
        lines.push(`- \`${s.line}:${s.column}\` — \`${snippet(s.text)}\``);
      }
      lines.push("");
    }
  }

  const thrownFiles = report.files.filter((f) => f.exception !== undefined);
  if (thrownFiles.length > 0) {
    lines.push("## Parse exceptions");
    lines.push("");
    lines.push("Files that threw from `parseCpp` (no tree produced) are not part of the error-node counts above.");
    lines.push("");
    lines.push(`| metric | value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| files that threw | ${thrownFiles.length} |`);
    lines.push(`| largest file parsed OK | ${report.maxOkSize} bytes |`);
    lines.push(`| smallest file that threw | ${report.minThrewSize} bytes |`);
    lines.push("");
    if (report.exceptionMessages.size > 0) {
      lines.push("Exception messages:");
      lines.push("");
      for (const [msg, count] of [...report.exceptionMessages.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`- \`${msg}\`: ${count} file${count === 1 ? "" : "s"}`);
      }
      lines.push("");
    }
    lines.push("First thrown files:");
    lines.push("");
    for (const f of thrownFiles.slice(0, 8)) {
      lines.push(`- ${relative(process.cwd(), f.path)} (${f.size} bytes)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    process.stderr.write("usage: npx tsx scripts/spike.ts <dir> [<dir> ...]\n");
    process.exitCode = 1;
    return;
  }
  const roots: string[] = [];
  for (const dir of dirs) {
    const abs = resolve(dir);
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
      process.stderr.write(`not a directory: ${dir}\n`);
      process.exitCode = 1;
      return;
    }
    roots.push(abs);
  }

  const files = roots.flatMap(collectFiles);
  const report: Report = {
    scanned: 0,
    errorFiles: 0,
    threwFiles: 0,
    totalNodes: 0,
    totalErrorNodes: 0,
    files: [],
    exceptionMessages: new Map(),
    maxOkSize: 0,
    minThrewSize: Number.POSITIVE_INFINITY,
  };
  for (const file of files) {
    const res = scanFile(file);
    report.scanned += 1;
    report.files.push(res);
    report.totalNodes += res.totalNodes;
    report.totalErrorNodes += res.errorNodes;
    if (res.errorNodes > 0) {
      report.errorFiles += 1;
    }
    if (res.exception !== undefined) {
      report.threwFiles += 1;
      report.minThrewSize = Math.min(report.minThrewSize, res.size);
      report.exceptionMessages.set(res.exception, (report.exceptionMessages.get(res.exception) ?? 0) + 1);
    } else {
      report.maxOkSize = Math.max(report.maxOkSize, res.size);
    }
  }

  const md = render(report, roots);
  const outPath = resolve("docs/m1a-tree-spike.md");
  mkdirSync(resolve("docs"), { recursive: true });
  writeFileSync(outPath, md);

  // Console summary.
  const pct = report.scanned === 0 ? "0.0%" : `${((report.errorFiles / report.scanned) * 100).toFixed(1)}%`;
  process.stdout.write(
    [
      `files scanned: ${report.scanned}`,
      `files with error nodes: ${report.errorFiles} (${pct})`,
      `parse exceptions: ${report.threwFiles}`,
      `total error-node matches: ${report.totalErrorNodes}`,
      `report written: ${outPath}`,
    ].join("\n") + "\n",
  );
}

main();
