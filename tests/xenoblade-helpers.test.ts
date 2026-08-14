/**
 * M5 — Xenoblade workflow-helper tests (SPEC §2/§3, task 11) — no live repo
 * access. The helpers spawn the coop python tools via an `execFile`-shaped
 * `run`; every test injects a MOCKED `run` that records the argv and returns
 * canned stdout (or writes a fake summary), so the venv python and the tool
 * scripts are never executed. Path resolution IS exercised for real, but
 * against a SMALL frozen fixture temp root (`.venv/bin/python3` +
 * `tools/coop/hexdiff.py` + `tools/coop/batch-cycle.py` +
 * `tools/struct_layout.py` as empty files) that `DECOMPI_XENOBLADE_ROOT`
 * points at — the real xenoblade checkout is never touched.
 *
 * Covers: getFunctionAsm's hexdiff argv + stdout passthrough; runBatchCycle's
 * batch-cycle argv + summary→BatchCycleResult mapping (accepted = status in
 * {FULL_MATCH, EQUIVALENT_MATCH}, missing fields/entries tolerated, non-zero
 * exit tolerated); structLayout's argv; and the clear root/venv errors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getFunctionAsm,
  registerHelpers,
  runBatchCycle,
  structLayout,
  type FunctionWorkItem,
} from "../adapters/xenoblade/workflow.js";
import { HelperRegistry } from "../src/workflow/helpers.js";

const MOCK_ASM = "; retail asm for wkRender__5CGameFv\n  lis r3, 0x8000\n  blr\n";
const MOCK_LAYOUT_JSON = JSON.stringify({
  unit: "kyoshin/CGame",
  types: [{ name: "CGame", size: 0x29C, fields: [{ name: "m_state", offset: 0 }] }],
});

/** A minimal `function`-kind work item with asm text. */
function item(id: string, symbol: string, unit = "kyoshin/CGame"): FunctionWorkItem {
  return {
    id,
    kind: "function",
    lifecycle: "pending",
    status: "NOT_STARTED",
    unitId: unit,
    symbol,
    asmText: "",
    attempts: 0,
    exhausted: false,
    ready: false,
    meta: {},
  };
}

/**
 * Point DECOMPI_XENOBLADE_ROOT at a temp dir that LOOKS like a xenoblade
 * checkout (empty venv python + the three tool scripts). `venv: false`
 * builds a root without `.venv/` to exercise the missing-python error. The
 * helper env vars are snapshot/restored so a developer shell can't leak
 * XENOBLADE_REPO / DECOMPI_XENOBLADE_PYTHON into the resolution.
 */
function withFixtureRoot(opts: { venv?: boolean } = {}): {
  root: string;
  python: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "decompi-xenoblade-helpers-"));
  mkdirSync(join(root, "tools", "coop"), { recursive: true });
  writeFileSync(join(root, "tools", "coop", "hexdiff.py"), "");
  writeFileSync(join(root, "tools", "coop", "batch-cycle.py"), "");
  writeFileSync(join(root, "tools", "struct_layout.py"), "");
  if (opts.venv !== false) {
    mkdirSync(join(root, ".venv", "bin"), { recursive: true });
    writeFileSync(join(root, ".venv", "bin", "python3"), "");
  }
  const prevRoot = process.env.DECOMPI_XENOBLADE_ROOT;
  const prevRepo = process.env.XENOBLADE_REPO;
  const prevPython = process.env.DECOMPI_XENOBLADE_PYTHON;
  process.env.DECOMPI_XENOBLADE_ROOT = root;
  delete process.env.XENOBLADE_REPO;
  delete process.env.DECOMPI_XENOBLADE_PYTHON;
  return {
    root,
    python: join(root, ".venv", "bin", "python3"),
    cleanup: () => {
      if (prevRoot === undefined) delete process.env.DECOMPI_XENOBLADE_ROOT;
      else process.env.DECOMPI_XENOBLADE_ROOT = prevRoot;
      if (prevRepo === undefined) delete process.env.XENOBLADE_REPO;
      else process.env.XENOBLADE_REPO = prevRepo;
      if (prevPython === undefined) delete process.env.DECOMPI_XENOBLADE_PYTHON;
      else process.env.DECOMPI_XENOBLADE_PYTHON = prevPython;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("getFunctionAsm runs hexdiff.py <unit> --symbol <symbol> --asm --no-build and returns stdout", async () => {
  const fixture = withFixtureRoot();
  try {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return MOCK_ASM;
    };
    const target = item("game-wk-render", "wkRender__5CGameFv", "kyoshin/CGame");
    const asm = await getFunctionAsm(target, run);

    assert.equal(asm, MOCK_ASM, "stdout is returned verbatim");
    assert.equal(calls.length, 1, "exactly one subprocess");
    assert.equal(calls[0]!.cmd, fixture.python, "the venv python runs the script");
    assert.deepEqual(calls[0]!.args, [
      join(fixture.root, "tools", "coop", "hexdiff.py"),
      "kyoshin/CGame", // unit from target.unitId
      "--symbol",
      "wkRender__5CGameFv", // symbol from target.symbol
      "--asm",
      "--no-build",
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("getFunctionAsm rejects a work item without unitId/symbol before spawning", async () => {
  const fixture = withFixtureRoot();
  try {
    const run = async (): Promise<string> => {
      throw new Error("must not be called");
    };
    await assert.rejects(
      () => getFunctionAsm(item("t-bad", "sym", ""), run),
      /requires a function work item with unitId \+ symbol/,
    );
    await assert.rejects(
      () => getFunctionAsm(item("t-bad", ""), run),
      /requires a function work item with unitId \+ symbol/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("runBatchCycle runs batch-cycle.py <ids> --summary <tmp> and maps the summary with accepted from status", async () => {
  const fixture = withFixtureRoot();
  try {
    const targets = [
      item("fn-full", "symA"),
      item("fn-eq", "symB"),
      item("fn-stale", "symC"),
      item("fn-broken", "symD"),
      item("fn-missing-entry", "symE"),
    ];
    // Frozen summary shaped like batch-cycle.py's --summary writer, minus
    // fields on purpose: fn-broken's entry drops `status` (tolerated), and
    // fn-missing-entry has no entry at all (tolerated).
    const summary = {
      tool: "batch-cycle",
      total: 5,
      passed: 2,
      failed: 3,
      skipped: 0,
      duration_s: 0.4,
      results: [
        { target_id: "fn-full", function: "f1", status: "FULL_MATCH", passed: true },
        { target_id: "fn-eq", function: "f2", status: "EQUIVALENT_MATCH", passed: true },
        { target_id: "fn-stale", function: "f3", status: "NOT_STARTED", passed: false },
        { target_id: "fn-broken", function: "f4", passed: false },
      ],
    };
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const summaryIdx = args.indexOf("--summary");
      assert.notEqual(summaryIdx, -1, "the --summary flag is passed");
      writeFileSync(args[summaryIdx + 1]!, JSON.stringify(summary));
      return "";
    };

    const results = await runBatchCycle(targets, run);

    assert.equal(results.length, targets.length, "one result per input target");
    assert.equal(results[0]!.target, targets[0]!, "the target reference is preserved");
    assert.deepEqual(
      results.map((r) => [r.targetId, r.status, r.accepted]),
      [
        ["fn-full", "FULL_MATCH", true],
        ["fn-eq", "EQUIVALENT_MATCH", true],
        ["fn-stale", "NOT_STARTED", false],
        ["fn-broken", "", false], // missing status field → ""
        ["fn-missing-entry", "", false], // missing entry → ""
      ],
    );

    assert.equal(calls.length, 1, "exactly one subprocess");
    assert.equal(calls[0]!.cmd, fixture.python);
    assert.equal(calls[0]!.args[0], join(fixture.root, "tools", "coop", "batch-cycle.py"));
    assert.deepEqual(
      calls[0]!.args.slice(1, 6),
      ["fn-full", "fn-eq", "fn-stale", "fn-broken", "fn-missing-entry"],
      "ids = target.id, in input order",
    );
    assert.equal(calls[0]!.args[6], "--summary");
    const summaryPath = calls[0]!.args[7]!;
    assert.ok(summaryPath.startsWith(tmpdir()), "summary goes to a temp dir");
    assert.match(summaryPath, /decompi-batch-cycle-/);
    assert.ok(summaryPath.endsWith("summary.json"));
    assert.equal(existsSync(summaryPath), false, "the temp summary is cleaned up");
  } finally {
    fixture.cleanup();
  }
});

test("runBatchCycle still maps the summary when the tool exits non-zero (rc 1 = some target failed)", async () => {
  const fixture = withFixtureRoot();
  try {
    const targets = [item("fn-a", "symA"), item("fn-b", "symB")];
    const run = async (_cmd: string, args: string[]) => {
      const summaryIdx = args.indexOf("--summary");
      writeFileSync(args[summaryIdx + 1]!, JSON.stringify({
        tool: "batch-cycle",
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        duration_s: 0.1,
        results: [
          { target_id: "fn-a", status: "FULL_MATCH", passed: true },
          { target_id: "fn-b", status: "NOT_STARTED", passed: false },
        ],
      }));
      throw new Error("Command failed with exit code 1");
    };
    const results = await runBatchCycle(targets, run);
    assert.equal(results[0]!.accepted, true);
    assert.equal(results[1]!.accepted, false);
  } finally {
    fixture.cleanup();
  }
});

test("runBatchCycle propagates when the tool fails before writing the summary", async () => {
  const fixture = withFixtureRoot();
  try {
    const run = async (): Promise<string> => {
      throw new Error("python3: no such file");
    };
    await assert.rejects(
      () => runBatchCycle([item("fn-a", "symA")], run),
      /batch-cycle\.py failed before writing/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("structLayout runs struct_layout.py search <unit> --json and returns stdout", async () => {
  const fixture = withFixtureRoot();
  try {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return MOCK_LAYOUT_JSON;
    };
    const out = await structLayout("kyoshin/CGame", run);

    assert.equal(out, MOCK_LAYOUT_JSON, "the JSON string is returned verbatim");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, fixture.python);
    assert.deepEqual(calls[0]!.args, [
      join(fixture.root, "tools", "struct_layout.py"),
      "search",
      "kyoshin/CGame",
      "--json",
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("helpers throw a clear error when the xenoblade root is missing", async () => {
  const fixture = withFixtureRoot();
  try {
    process.env.DECOMPI_XENOBLADE_ROOT = join(fixture.root, "does-not-exist");
    const run = async (): Promise<string> => {
      throw new Error("must not be called");
    };
    await assert.rejects(
      () => getFunctionAsm(item("t", "sym"), run),
      /xenoblade repo root not found/,
    );
    await assert.rejects(
      () => structLayout("kyoshin/CGame", run),
      /xenoblade repo root not found/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("helpers throw a clear error when the venv python is missing", async () => {
  const fixture = withFixtureRoot({ venv: false });
  try {
    const run = async (): Promise<string> => {
      throw new Error("must not be called");
    };
    await assert.rejects(
      () => getFunctionAsm(item("t", "sym"), run),
      /venv python not found/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("registerHelpers registers the three real helpers", () => {
  const registry = new HelperRegistry();
  registerHelpers(registry);
  assert.equal(registry.has("getFunctionAsm"), true);
  assert.equal(registry.has("runBatchCycle"), true);
  assert.equal(registry.has("structLayout"), true);
  assert.equal(typeof registry.get("getFunctionAsm"), "function");
});
