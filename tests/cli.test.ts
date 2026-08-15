/**
 * M0 CLI integration tests: `SqliteAdapter` + canonical migrations +
 * `FixtureAdapter` (file-backed and in-memory) driving `runStatus` /
 * `runSelect`, plus `main` wiring (SPEC §7, §15).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../src/core/store/sqlite.js";
import { FixtureAdapter, type FixtureWorkItem } from "../src/adapter/fixture.js";
import {
  compileConfig,
  main,
  parseArgs,
  parseSelector,
  runLint,
  runReportCheck,
  runAnalyze,
  runSelect,
  runStatus,
  type Output,
} from "../src/cli/index.js";
import type { Selector, WorkItem } from "../src/types.js";

/** In-memory `Output` collector. */
function collect(): { out: Output; text: () => string } {
  let buffer = "";
  return {
    out: { write(chunk: string): unknown { buffer += chunk; return true; } },
    text: () => buffer,
  };
}

/** Fresh `:memory:` SqliteAdapter, migrated, fixture imported. */
async function openImported(
  fixture: FixtureAdapter,
): Promise<{ adapter: SqliteAdapter; imported: WorkItem[] }> {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.migrate([]);
  const imported = await fixture.importWorkItems({ store: adapter });
  return { adapter, imported };
}

test("runStatus prints a per-unit summary with lenient fixture defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-cli-"));
  try {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        workItems: [
          // no attempts/lifecycle/ready/meta → lenient defaults must kick in
          {
            id: "wi_0001",
            kind: "function",
            status: "NOT_STARTED",
            unitId: "kyoshin/CGame",
            symbol: "fn_0001",
            size: 128,
          },
          {
            id: "wi_0002",
            kind: "function",
            status: "FULL_MATCH",
            unitId: "kyoshin/CGame",
            symbol: "fn_0002",
            size: 256,
          },
          { id: "wi_0003", kind: "function", status: "NOT_STARTED", unitId: "kyoshin/CGame", size: 512 },
          { id: "wi_0004", kind: "object", status: "EQUIVALENT_MATCH", unitId: "kyoshin/CChar", size: 96 },
        ],
      }),
    );

    const { adapter, imported } = await openImported(new FixtureAdapter(fixturePath));
    try {
      assert.equal(imported.length, 4);
      assert.equal(imported[0]?.attempts, 0);
      assert.equal(imported[0]?.lifecycle, "pending");
      assert.equal(imported[0]?.exhausted, false);
      assert.equal(imported[0]?.ready, false);
      assert.deepEqual(imported[0]?.meta, {});

      const c = collect();
      await runStatus(adapter, c.out);
      const text = c.text();

      assert.match(text, /unit\s+total\s+remaining/);
      const cgame = text.split("\n").find((line) => line.startsWith("kyoshin/CGame"));
      const cchar = text.split("\n").find((line) => line.startsWith("kyoshin/CChar"));
      assert.ok(cgame, "expected a kyoshin/CGame row");
      assert.ok(cchar, "expected a kyoshin/CChar row");
      // unit | total | remaining
      assert.deepEqual(cgame!.trim().split(/\s+/).slice(1, 3), ["3", "2"]);
      assert.deepEqual(cchar!.trim().split(/\s+/).slice(1, 3), ["1", "0"]);
      // per-status counts, status columns sorted alphabetically:
      // EQUIVALENT_MATCH | FULL_MATCH | NOT_STARTED
      assert.deepEqual(cgame!.trim().split(/\s+/).slice(3), ["0", "1", "2"]);
      assert.deepEqual(cchar!.trim().split(/\s+/).slice(3), ["1", "0", "0"]);
    } finally {
      adapter.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSelect honors filters, meta post-filter, sort and limit", async () => {
  const fixture = FixtureAdapter.fromArray([
    {
      id: "wi_0001",
      kind: "function",
      status: "NOT_STARTED",
      unitId: "kyoshin/CGame",
      symbol: "fn_0001",
      size: 128,
      meta: { priority: "high" },
    },
    {
      id: "wi_0002",
      kind: "function",
      status: "FULL_MATCH",
      unitId: "kyoshin/CGame",
      symbol: "fn_0002",
      size: 256,
    },
    {
      id: "wi_0003",
      kind: "function",
      status: "NOT_STARTED",
      unitId: "kyoshin/CGame",
      symbol: "fn_0003",
      size: 512,
    },
    { id: "wi_0004", kind: "object", status: "NOT_STARTED", unitId: "kyoshin/CChar", symbol: "obj_0004", size: 96 },
  ]);
  const { adapter } = await openImported(fixture);
  try {
    // meta post-filter narrows the SQL selection
    const c1 = collect();
    await runSelect(
      adapter,
      {
        filter: {
          status: ["NOT_STARTED"],
          unit: ["kyoshin/CGame"],
          meta: [{ key: "priority", op: "eq", value: "high" }],
        },
        limit: 10,
      },
      c1.out,
    );
    assert.equal(c1.text().trim(), "wi_0001\tfn_0001\tNOT_STARTED\t128");

    // sort by size desc + limit
    const c2 = collect();
    await runSelect(
      adapter,
      { filter: { status: ["NOT_STARTED"] }, sort: [{ by: "size", dir: "desc" }], limit: 2 },
      c2.out,
    );
    assert.equal(
      c2.text().trim(),
      ["wi_0003\tfn_0003\tNOT_STARTED\t512", "wi_0001\tfn_0001\tNOT_STARTED\t128"].join("\n"),
    );
  } finally {
    adapter.close();
  }
});

test("main('status' / 'select') wires argv → db open → migrate → fixture → output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-cli-main-"));
  try {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        workItems: [
          { id: "wi_0001", kind: "function", status: "NOT_STARTED", unitId: "kyoshin/CGame", symbol: "fn_0001", size: 128 },
          { id: "wi_0002", kind: "function", status: "FULL_MATCH", unitId: "kyoshin/CGame", symbol: "fn_0002", size: 256 },
        ],
      }),
    );

    const chunks: string[] = [];
    const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
    const original = stdout.write.bind(process.stdout);
    stdout.write = (chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await main(["status", "--db", ":memory:", "--fixture", fixturePath]);
      await main([
        "select",
        JSON.stringify({ filter: { status: ["FULL_MATCH"] } }),
        "--db",
        ":memory:",
        "--fixture",
        fixturePath,
      ]);
    } finally {
      stdout.write = original;
    }

    const text = chunks.join("");
    // total 2, remaining 1 (FULL_MATCH is terminal)
    assert.match(text, /kyoshin\/CGame\s+2\s+1/);
    assert.match(text, /wi_0002\tfn_0002\tFULL_MATCH\t256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FixtureAdapter rejects entries missing required fields", async () => {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.migrate([]);
  try {
    const bad = { id: "wi_bad", kind: "function" } as unknown as FixtureWorkItem;
    const fixture = FixtureAdapter.fromArray([bad]);
    await assert.rejects(
      fixture.importWorkItems({ store: adapter }),
      /missing or invalid "status"/,
    );
  } finally {
    adapter.close();
  }
});

test("FixtureAdapter import is atomic: a failing item rolls the whole import back", async () => {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.migrate([]);
  try {
    // Second entry duplicates the first entry's id → PK conflict mid-import.
    const fixture = FixtureAdapter.fromArray([
      { id: "wi_atomic_a", kind: "function", status: "NOT_STARTED" },
      { id: "wi_atomic_a", kind: "function", status: "NOT_STARTED" },
    ]);
    await assert.rejects(
      fixture.importWorkItems({ store: adapter }),
      (err: unknown) => adapter.isUniqueViolation(err),
    );
    const rows = await adapter.query<{ n: number }>("SELECT COUNT(*) AS n FROM work_items");
    assert.equal(Number(rows[0]?.n), 0, "no partial import may be persisted");
  } finally {
    adapter.close();
  }
});

test("FixtureAdapter default meta is cloned per item (no shared object)", async () => {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.migrate([]);
  try {
    const fixture = FixtureAdapter.fromArray([
      { id: "wi_meta_1", kind: "function", status: "NOT_STARTED" },
      { id: "wi_meta_2", kind: "function", status: "NOT_STARTED" },
    ]);
    const imported = await fixture.importWorkItems({ store: adapter });
    assert.deepEqual(imported[0]?.meta, {});
    assert.deepEqual(imported[1]?.meta, {});
    // Mutating one item's meta must never leak into another item.
    imported[0]!.meta["polluted"] = true;
    assert.deepEqual(imported[1]?.meta, {});
    // The persisted row for item 2 is still an empty bag.
    const row = await adapter.query<{ meta: string }>(
      "SELECT meta FROM work_items WHERE id = ?",
      ["wi_meta_2"],
    );
    assert.deepEqual(JSON.parse(row[0]?.meta ?? "{}"), {});
  } finally {
    adapter.close();
  }
});

test("parseSelector validates selector shape with clear errors", () => {
  // String instead of array (the headline adversarial case).
  assert.throws(
    () => parseSelector('{"filter":{"status":"FULL_MATCH"}}'),
    /filter\.status must be an array of strings/,
  );
  assert.throws(() => parseSelector('{"limit":-5}'), /limit must be a positive integer/);
  assert.throws(
    () => parseSelector('{"sort":[{"by":"status","dir":"asc"}]}'),
    /Invalid sort field: status/,
  );
  assert.throws(
    () => parseSelector('{"filter":{"meta":[{"key":"k","op":"bogus","value":1}]}}'),
    /filter\.meta\[0\]\.op must be one of eq\|neq\|in\|contains\|regex/,
  );
  assert.throws(() => parseSelector("not json"), /invalid selector JSON/);
  assert.deepEqual(parseSelector('{"limit":1}'), { limit: 1 });
});

test("main('select') rejects an invalid selector before touching the db", async () => {
  await assert.rejects(
    main(["select", '{"filter":{"status":"FULL_MATCH"}}', "--db", ":memory:"]),
    /filter\.status must be an array of strings/,
  );
});

test("parseArgs supports --flag value and --flag=value", () => {
  const parsed = parseArgs(["status", "--db", ":memory:", "--fixture=x.json"]);
  assert.deepEqual(parsed.positionals, ["status"]);
  assert.equal(parsed.values.get("db"), ":memory:");
  assert.equal(parsed.values.get("fixture"), "x.json");
  assert.equal(parsed.bools.size, 0);
});

test("parseArgs: boolean flags never consume the next token and reject =values", () => {
  // The adversarial case: `lint --delta foo.cpp` must keep foo.cpp positional.
  const parsed = parseArgs(["--delta", "foo.cpp", "--json", "bar.cpp"]);
  assert.deepEqual(parsed.positionals, ["foo.cpp", "bar.cpp"]);
  assert.deepEqual([...parsed.bools].sort(), ["delta", "json"]);
  assert.equal(parsed.values.size, 0);

  // `--delta=1` must not silently switch meaning (whole-file scan today).
  assert.throws(() => parseArgs(["--delta=1"]), /--delta does not take a value/);
  assert.throws(() => parseArgs(["--json=yes"]), /--json does not take a value/);

  // Value flags keep their behavior: `--base origin/main` and `--base=x`.
  const base = parseArgs(["--base", "origin/main", "--variant=RVL"]);
  assert.equal(base.values.get("base"), "origin/main");
  assert.equal(base.values.get("variant"), "RVL");
});

test("lint --json emits ONE flat JSON array with the stable finding schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-lint-json-"));
  try {
    const a = join(dir, "a.cpp");
    const b = join(dir, "b.cpp");
    writeFileSync(a, "void* p = 0;\n");
    writeFileSync(b, "class Foo { int x; };\n");
    const c = collect();
    await runLint([a, b], { format: "json" }, c.out);
    const parsed = JSON.parse(c.text());
    assert.ok(Array.isArray(parsed), "expected a single JSON array document");
    assert.equal(new Set(parsed.map((r) => r.path)).size, 2, "both files must appear");
    // Stable schema: every entry carries rule/line/column/snippet/message/path.
    for (const entry of parsed) {
      for (const key of ["rule", "line", "column", "snippet", "message", "path"]) {
        assert.ok(key in entry, `missing schema key "${key}"`);
      }
    }
    const voidPtr = parsed.find((r) => r.rule === "smell.void_ptr");
    assert.ok(voidPtr, "a.cpp should carry a smell.void_ptr finding");
    assert.equal(voidPtr.path, a);
    assert.equal(voidPtr.line, 1);
    const cls = parsed.find((r) => r.path === b);
    assert.equal(cls.rule, "smell.class_in_cpp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compileConfig warns on unknown top-level keys", () => {
  const warnings: string[] = [];
  const cfg = compileConfig(
    { placeholderPatterns: { unknown: "un\\d+" }, bogusKey: 1, other: true },
    "cfg.json",
    (w) => warnings.push(w),
  );
  assert.deepEqual(warnings, [
    'unknown lint config key "bogusKey" in cfg.json (ignored)',
    'unknown lint config key "other" in cfg.json (ignored)',
  ]);
  assert.ok(cfg.placeholderPatterns?.unknown instanceof RegExp);
  // Known keys warn nothing.
  const silent: string[] = [];
  compileConfig({ angleIncludeWhitelist: ["x.h"] }, "c.json", (w) => silent.push(w));
  assert.deepEqual(silent, []);
  // Malformed values still throw.
  assert.throws(() => compileConfig({ placeholderPatterns: { unknown: 5 } }, "c.json"), /must be a string regex/);
});

// ─── report --check CI gate (smell_report.py mirror) ────────────────────────

const SMELLY_CPP = `extern "C" {
  void not_label(void) { }
}
void* g_ptr = 0;
void f(char* p) {
  char* q = (char*)p + 4;
}
`;

/** Write a .cpp + generate docs/smells.md in `dir` via runReportCheck --write. */
function seedReport(dir: string, source: string, name = "a.cpp"): string {
  const file = join(dir, name);
  writeFileSync(file, source);
  const c = collect();
  runReportCheck([file], { check: false, write: true, strict: true, variant: "game" }, c.out);
  assert.match(c.text(), /wrote docs\/smells\.md/);
  return file;
}

test("report --check: freshness gate fails on stale docs and passes after --write", () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-report-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const file = seedReport(dir, SMELLY_CPP);
    // Fresh: the committed doc equals the fresh regeneration.
    const ok = collect();
    assert.equal(runReportCheck([file], { check: true, write: false, strict: false, variant: "game" }, ok.out), true);
    assert.match(ok.text(), /ok: docs\/smells\.md is fresh/);
    // Add a smell to the TU: the committed doc is now stale.
    writeFileSync(file, SMELLY_CPP + "void g(void) { goto done; done: return; }\n");
    const stale = collect();
    assert.equal(runReportCheck([file], { check: true, write: false, strict: false, variant: "game" }, stale.out), false);
    assert.match(stale.text(), /ERROR: docs\/smells\.md is stale/);
    // Regenerate; the gate passes again.
    const write2 = collect();
    runReportCheck([file], { check: false, write: true, strict: true, variant: "game" }, write2.out);
    const ok2 = collect();
    assert.equal(runReportCheck([file], { check: true, write: false, strict: false, variant: "game" }, ok2.out), true);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report --check: per-TU regression vs base branch baseline (git show)", () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-regress-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    execSync("git init -q", { stdio: "ignore" });
    execSync("git config user.email t@t && git config user.name t", { stdio: "ignore" });
    const file = seedReport(dir, SMELLY_CPP);
    execSync("git add . && git commit -qm base", { stdio: "ignore" });

    // Clean tree vs base: no regression.
    const clean = collect();
    assert.equal(
      runReportCheck([file], { check: true, write: false, strict: true, base: "HEAD", variant: "game" }, clean.out),
      true,
    );

    // Increase a TRACKED metric (void_ptr) on the same TU: regression.
    writeFileSync(file, SMELLY_CPP + "void* g2 = 0;\n");
    const regress = collect();
    assert.equal(
      runReportCheck([file], { check: true, write: false, strict: true, base: "HEAD", variant: "game" }, regress.out),
      false,
    );
    assert.match(regress.text(), /smell regression vs base branch baseline/);
    assert.match(regress.text(), /a\.cpp: void\* 1 → 2/);
    // --no-strict drops the regression check (freshness error remains).
    const noStrict = collect();
    assert.equal(
      runReportCheck([file], { check: true, write: false, strict: false, base: "HEAD", variant: "game" }, noStrict.out),
      false,
    );
    assert.doesNotMatch(noStrict.text(), /smell regression/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report --completeness prints the live TU status table from the registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-complete-"));
  try {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        workItems: [
          { id: "wi_1", kind: "function", status: "FULL_MATCH", unitId: "kyoshin/CGame" },
          { id: "wi_2", kind: "function", status: "FULL_MATCH", unitId: "kyoshin/CGame" },
          { id: "wi_3", kind: "function", status: "NOT_STARTED", unitId: "kyoshin/CGame" },
          { id: "wi_4", kind: "function", status: "EQUIVALENT_MATCH", unitId: "kyoshin/CChar" },
        ],
      }),
    );
    const chunks: string[] = [];
    const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
    const original = stdout.write.bind(process.stdout);
    stdout.write = (chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await main(["report", "--completeness", "--db", ":memory:", "--fixture", fixturePath]);
    } finally {
      stdout.write = original;
    }
    const text = chunks.join("");
    assert.match(text, /kyoshin\/CGame\s+\| 3 \| 2 \| PARTIAL \(2\/3\)/);
    assert.match(text, /kyoshin\/CChar\s+\| 1 \| 1 \| COMPLETE/);
    assert.match(text, /Complete TUs: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyze runs the introspection agent and prints the final text (--run scopes the prompt)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-cli-analyze-"));
  try {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({ workItems: [{ id: "wi_1", kind: "function", status: "FULL_MATCH", unitId: "kyoshin/CGame" }] }),
    );
    const { adapter } = await openImported(new FixtureAdapter(fixturePath));
    try {
      const plain = collect();
      await runAnalyze(adapter, "RESPOND: r1 was cancelled", {}, plain.out);
      assert.equal(plain.text(), "r1 was cancelled\n");

      // --run scopes the question to one run id (injected into the prompt).
      const scoped = collect();
      await runAnalyze(adapter, "RESPOND: ok", { runId: "r9" }, scoped.out);
      assert.equal(scoped.text(), "ok\n");
    } finally {
      adapter.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main wires `analyze '<prompt>'` through argv", async () => {
  const chunks: string[] = [];
  const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const original = stdout.write.bind(process.stdout);
  stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await main(["analyze", "RESPOND: two runs done", "--db", ":memory:"]);
    assert.equal(chunks.join(""), "two runs done\n");
  } finally {
    stdout.write = original;
  }
});
