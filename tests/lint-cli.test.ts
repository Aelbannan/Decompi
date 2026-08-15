/**
 * CI-usable lint/report CLI tests (SPEC §13.4, §15): exit-code semantics
 * (findings → 1, clean → 0), `--rule` filtering, the flat `--json` schema,
 * the `--markdown` report table, `--delta` (`.orig` gating), and the
 * `report --check` gate's stale → 1 exit code. Exit codes are exercised both
 * through `main`'s return value and through real CLI subprocesses (the bin
 * entry maps the return value onto `process.exitCode`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { main, runLint, runReport, type Output } from "../src/cli/index.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, "src/cli/index.ts");
/** Absolute tsx loader path: `--import` resolves it regardless of cwd. */
const TSX_LOADER = join(
  dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
  "dist/loader.mjs",
);

/** In-memory `Output` collector. */
function collect(): { out: Output; text: () => string } {
  let buffer = "";
  return {
    out: { write(chunk: string): unknown { buffer += chunk; return true; } },
    text: () => buffer,
  };
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `decompi-lint-cli-${prefix}-`));
}

/** A file with three different smell families (void_ptr, class_in_cpp, ptr_arith). */
const SMELLY = "void* p = 0;\nclass Foo { int x; };\nvoid f(char* q) { char* r = q + 4; }\n";
/** A clean TU: no rule should fire. */
const CLEAN = "int x = 1;\n";

// ─── exit-code semantics ────────────────────────────────────────────────────

test("lint exit code: findings → 1, clean → 0, --no-fail forces 0", async () => {
  const dir = tmpDir("exit");
  try {
    const smelly = join(dir, "a.cpp");
    const clean = join(dir, "clean.cpp");
    writeFileSync(smelly, SMELLY);
    writeFileSync(clean, CLEAN);

    assert.equal(await main(["lint", smelly]), 1, "findings must exit 1");
    assert.equal(await main(["lint", clean]), 0, "clean must exit 0");
    assert.equal(
      await main(["lint", smelly, "--no-fail"]),
      0,
      "--no-fail forces exit 0 despite findings",
    );
    // An empty directory is clean → exit 0.
    const emptyDir = join(dir, "empty");
    mkdirSync(emptyDir);
    assert.equal(await main(["lint", emptyDir]), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint exit codes are real process exit codes (spawned CLI)", () => {
  const dir = tmpDir("spawn");
  try {
    const smelly = join(dir, "a.cpp");
    const clean = join(dir, "clean.cpp");
    writeFileSync(smelly, SMELLY);
    writeFileSync(clean, CLEAN);

    const bad = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "lint", smelly],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(bad.status, 1, "findings must exit 1 in the real process");
    assert.match(bad.stdout, /smell\.void_ptr: 1/);
    // No node:sqlite ExperimentalWarning on the lint path (lazy store import).
    assert.doesNotMatch(bad.stderr, /ExperimentalWarning/);

    const ok = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "lint", clean],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(ok.status, 0, "clean must exit 0 in the real process");
    assert.match(ok.stdout, /clean: no findings in 1 file\(s\)/);

    const noFail = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "lint", smelly, "--no-fail"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(noFail.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── --rule filtering ───────────────────────────────────────────────────────

test("lint --rule filters findings to one rule id (text + json)", async () => {
  const dir = tmpDir("rule");
  try {
    const file = join(dir, "a.cpp");
    writeFileSync(file, SMELLY);

    const c = collect();
    await runLint([file], { format: "json", rule: "smell.void_ptr" }, c.out);
    const parsed = JSON.parse(c.text()) as Array<{ rule: string }>;
    assert.ok(parsed.length > 0, "the filtered rule still fires");
    assert.ok(parsed.every((f) => f.rule === "smell.void_ptr"), "only smell.void_ptr");

    // Text output carries the rule header and no other rules.
    const t = collect();
    await runLint([file], { format: "text", rule: "smell.class_in_cpp" }, t.out);
    assert.match(t.text(), /smell\.class_in_cpp: 1/);
    assert.doesNotMatch(t.text(), /smell\.void_ptr/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint --rule with an unknown id warns on stderr and is clean (exit 0)", async () => {
  const dir = tmpDir("badrule");
  try {
    const file = join(dir, "a.cpp");
    writeFileSync(file, SMELLY);
    const chunks: string[] = [];
    const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
    const original = stderr.write.bind(process.stderr);
    stderr.write = (chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      assert.equal(await main(["lint", file, "--rule", "no.such.rule"]), 0);
    } finally {
      stderr.write = original;
    }
    assert.match(chunks.join(""), /no known rule/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── --json / --markdown output shapes ──────────────────────────────────────

test("lint --json emits ONE JSON array across files with the stable schema", async () => {
  const dir = tmpDir("json");
  try {
    const a = join(dir, "a.cpp");
    const b = join(dir, "b.cpp");
    writeFileSync(a, SMELLY);
    writeFileSync(b, CLEAN);
    const c = collect();
    await runLint([a, b], { format: "json" }, c.out);
    const parsed = JSON.parse(c.text());
    assert.ok(Array.isArray(parsed), "one JSON array document");
    const keys = ["rule", "line", "column", "snippet", "message", "path"];
    for (const entry of parsed) {
      for (const key of keys) assert.ok(key in entry, `missing schema key "${key}"`);
      assert.ok(entry.path === a || entry.path === b);
    }
    const voidPtr = parsed.find((f) => f.rule === "smell.void_ptr");
    assert.ok(voidPtr, "a.cpp has a smell.void_ptr finding");
    assert.equal(voidPtr.line, 1);
    assert.equal(voidPtr.column, 5);
    assert.equal(typeof voidPtr.message, "string");
    assert.equal(voidPtr.path, a);
    // Clean file contributes nothing.
    assert.ok(!parsed.some((f) => f.path === b));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint --markdown emits a per-file report table", async () => {
  const dir = tmpDir("md");
  try {
    const file = join(dir, "a.cpp");
    writeFileSync(file, SMELLY);
    const c = collect();
    await runLint([file], { format: "markdown" }, c.out);
    const md = c.text();
    assert.match(md, new RegExp(`## ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(md, /\| rule \| line \| column \| snippet \| message \|/);
    assert.match(md, /\| smell\.void_ptr \| 1 \| 5 \| `[^`]+` \| .+ \|/);
    assert.match(md, /\| smell\.class_in_cpp \| 2 \| 1 \| .+ \| .+ \|/);

    // Empty result: a single "No findings." line.
    const clean = join(dir, "clean.cpp");
    writeFileSync(clean, CLEAN);
    const c2 = collect();
    await runLint([clean], { format: "markdown" }, c2.out);
    assert.equal(c2.text().trim(), "No findings.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── --delta (added-lines gate) ─────────────────────────────────────────────

test("lint --delta lints only added lines vs <path>.orig; no .orig → whole file", async () => {
  const dir = tmpDir("delta");
  try {
    // The .orig already contains the smell; the new file adds clean lines.
    const withOrig = join(dir, "delta.cpp");
    writeFileSync(`${withOrig}.orig`, "void* p = 0;\n");
    writeFileSync(withOrig, "void* p = 0;\nint fine = 1;\n");
    const c1 = collect();
    await runLint([withOrig], { delta: true, format: "json" }, c1.out);
    assert.deepEqual(JSON.parse(c1.text()), [], "pre-existing smells are not flagged");

    // A NEW smell on an added line is flagged.
    writeFileSync(`${withOrig}.orig`, "int fine = 1;\n");
    writeFileSync(withOrig, "int fine = 1;\nvoid* p = 0;\n");
    const c2 = collect();
    await runLint([withOrig], { delta: true, format: "json" }, c2.out);
    const findings = JSON.parse(c2.text()) as Array<{ rule: string; line: number }>;
    assert.ok(findings.some((f) => f.rule === "no_void_ptr" && f.line === 2));

    // No .orig at all → the whole file is treated as added.
    const noOrig = join(dir, "noorig.cpp");
    writeFileSync(noOrig, "void* p = 0;\n");
    const c3 = collect();
    await runLint([noOrig], { delta: true, format: "json" }, c3.out);
    assert.ok((JSON.parse(c3.text()) as unknown[]).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── clear errors / no raw crashes ──────────────────────────────────────────

test("lint missing file fails with a clear error, not a raw crash", async () => {
  const dir = tmpDir("missing");
  try {
    const missing = join(dir, "nope.cpp");
    await assert.rejects(main(["lint", missing]), /cannot read .*nope\.cpp/);
    const spawned = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "lint", missing],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(spawned.status, 1);
    assert.match(spawned.stderr, /cannot read .*nope\.cpp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint --help and report --help print usage and exit 0", async () => {
  const lintChunks: string[] = [];
  const reportChunks: string[] = [];
  const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const original = stdout.write.bind(process.stdout);
  stdout.write = (chunk: unknown): boolean => {
    lintChunks.push(String(chunk));
    return true;
  };
  try {
    assert.equal(await main(["lint", "--help"]), 0);
  } finally {
    stdout.write = original;
  }
  stdout.write = (chunk: unknown): boolean => {
    reportChunks.push(String(chunk));
    return true;
  };
  try {
    assert.equal(await main(["report", "--help"]), 0);
  } finally {
    stdout.write = original;
  }
  assert.match(lintChunks.join(""), /decompi lint <paths…>/);
  assert.match(lintChunks.join(""), /--no-fail/);
  assert.match(lintChunks.join(""), /exit codes:/);
  assert.match(reportChunks.join(""), /decompi report \[paths…\]/);
  assert.match(reportChunks.join(""), /--check/);
  assert.match(reportChunks.join(""), /--json/);
});

// ─── report gate + summary ──────────────────────────────────────────────────

test("report --check: stale doc → exit 1, fresh → 0 (via main exit code)", async () => {
  const dir = tmpDir("check");
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const file = join(dir, "a.cpp");
    writeFileSync(file, SMELLY);

    assert.equal(await main(["report", "--write", file]), 0);
    assert.ok(existsSync(join(dir, "docs/smells.md")), "--write generates docs/smells.md");

    assert.equal(await main(["report", "--check", file]), 0, "fresh doc passes");
    // Make the TU smellier: the committed doc is now stale → exit 1.
    writeFileSync(file, SMELLY + "void* g2 = 0;\n");
    assert.equal(await main(["report", "--check", file]), 1, "stale doc must exit 1");
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report --check --json emits the {ok, problems} verdict and still exits 1", async () => {
  const dir = tmpDir("checkjson");
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const file = join(dir, "a.cpp");
    writeFileSync(file, SMELLY);
    await main(["report", "--write", file]);
    writeFileSync(file, SMELLY + "void* g2 = 0;\n");

    const chunks: string[] = [];
    const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
    const original = stdout.write.bind(process.stdout);
    stdout.write = (chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      assert.equal(await main(["report", "--check", "--json", file]), 1);
    } finally {
      stdout.write = original;
    }
    const verdict = JSON.parse(chunks.join(""));
    assert.equal(verdict.ok, false);
    assert.ok(Array.isArray(verdict.problems) && verdict.problems.length > 0);
    assert.match(verdict.problems[0], /stale/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report --json emits the per-rule / per-file summary object", async () => {
  const dir = tmpDir("summary");
  try {
    const file = join(dir, "a.cpp");
    writeFileSync(file, SMELLY);
    const c = collect();
    await runReport([file], { json: true }, c.out);
    const summary = JSON.parse(c.text()) as {
      rules: Record<string, number>;
      files: Record<string, number>;
      total: number;
    };
    assert.ok(summary.total > 0);
    assert.ok(summary.rules["smell.void_ptr"] >= 1);
    assert.ok(summary.rules["smell.class_in_cpp"] >= 1);
    assert.equal(summary.files[file], summary.total);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
