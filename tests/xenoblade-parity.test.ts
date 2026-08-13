/**
 * M2.5 — Xenoblade adapter parity test (SPEC §7 / §7.1).
 *
 * Gated integration test: skips when the xenoblade repo / its .venv are
 * unavailable (set `DECOMPI_XENOBLADE_ROOT` if the checkout is not the
 * sibling-of-decompi default, and `DECOMPI_XENOBLADE_REGION` for a
 * non-"us" build). When the environment is present, drives
 * `XenobladeAdapter.diff()` for THREE golden symbols:
 *
 *   - `func_8003933C__5CGameFv` (kyoshin/CGame)     — FULL_MATCH target
 *   - `func_8003B748`          (kyoshin/plugin/ocBdat) — reg-swap mismatch
 *   - `Term__9CTaskGameFv`     (kyoshin/CTaskGame)   — structural mismatch
 *
 * For each golden the worker's parsed result is deep-compared against a
 * fresh `hexdiff.py --json` CLI run over the same objects — not just the
 * stable count fields but the FULL `instructions` / `reg_mapping` /
 * `size_check` / relocation arrays — plus the `verify()` mapping, and the
 * not-found path (adapter.diff on a bogus symbol → WorkerRpcError carrying
 * hexdiff rc 4; adapter.verify → rejected NOT_FOUND verdict, no throw).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  XenobladeAdapter,
  resolveXenobladePython,
  resolveXenobladeRoot,
} from "../adapters/xenoblade/adapter.js";
import type { AdapterCtx, DiffResult } from "../src/adapter/types.js";
import { WorkerRpcError } from "../src/core/worker.js";
import type { WorkItem } from "../src/types.js";

/** The golden symbols, one per diff class the review requires: a clean
 * FULL_MATCH target, a reg-swap mismatch, and a structural mismatch. */
const GOLDENS = [
  {
    unit: "kyoshin/CGame",
    symbol: "func_8003933C__5CGameFv",
    kind: "full-match", // byte-identical today
  },
  {
    unit: "kyoshin/plugin/ocBdat",
    symbol: "func_8003B748",
    kind: "reg-swap", // 1 mismatch, 1 reg-swap, 0 structural
  },
  {
    unit: "kyoshin/CTaskGame",
    symbol: "Term__9CTaskGameFv",
    kind: "structural", // decomp side stubbed: every slot structural
  },
] as const;

/** Stable fields of the hexdiff JSON that MUST agree across the worker and
 * the fresh CLI invocation. */
const STABLE_FIELDS = [
  "symbol",
  "retail_size",
  "decomp_size",
  "total_instructions",
  "mismatch_count",
  "reg_swap_count",
  "pure_reg_swap_count",
  "structural_count",
] as const;

/** Per-kind classification assertions on the diff counts. */
function assertKind(kind: string, result: DiffResult): void {
  if (kind === "full-match") {
    assert.equal(result.mismatch_count, 0, "FULL_MATCH golden must diff clean");
    assert.equal(result.structural_count, 0);
    assert.equal(result.reg_swap_count, 0);
  } else if (kind === "reg-swap") {
    assert.ok(result.mismatch_count > 0, "reg-swap golden must mismatch");
    assert.ok(result.reg_swap_count > 0, "reg-swap golden must have a reg-swap");
    assert.equal(result.structural_count, 0, "reg-swap golden must have no structural diffs");
  } else if (kind === "structural") {
    assert.ok(result.mismatch_count > 0, "structural golden must mismatch");
    assert.ok(result.structural_count > 0, "structural golden must have structural diffs");
  }
}

/**
 * Why the test must skip, or null when the environment is present:
 * the xenoblade repo + venv python + hexdiff.py + the retail/decomp objects
 * of every golden unit (diffed with --no-build).
 */
function envReason(): string | null {
  const root = resolveXenobladeRoot();
  const python = resolveXenobladePython(root);
  if (!existsSync(root)) {
    return `xenoblade repo not found at ${root} (set DECOMPI_XENOBLADE_ROOT)`;
  }
  if (!existsSync(join(root, "tools", "coop", "hexdiff.py"))) {
    return `hexdiff.py not found under ${root}`;
  }
  if (!existsSync(python)) {
    return `venv python not found at ${python} (create the repo .venv or set DECOMPI_XENOBLADE_PYTHON)`;
  }
  const region = process.env.DECOMPI_XENOBLADE_REGION ?? "us";
  for (const golden of GOLDENS) {
    // unit "kyoshin/plugin/ocBdat" → obj/kyoshin/plugin/ocBdat.o (retail)
    // and src/kyoshin/plugin/ocBdat.o (decomp).
    const [dir, file] = [
      golden.unit.slice(0, golden.unit.lastIndexOf("/")),
      golden.unit.slice(golden.unit.lastIndexOf("/") + 1),
    ];
    for (const obj of [
      join(root, "build", region, "obj", dir, `${file}.o`),
      join(root, "build", region, "src", dir, `${file}.o`),
    ]) {
      if (!existsSync(obj)) {
        return `object not found: ${obj} (build the unit first, or set DECOMPI_XENOBLADE_REGION)`;
      }
    }
  }
  return null;
}

/** Run the hexdiff CLI once; resolve with (code, stdout, stderr) whether the
 * process exited 0 (clean) or 5 (mismatch) — both carry a valid JSON doc. */
function runHexdiffCli(
  python: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      python,
      args,
      { cwd, timeout: 120_000 },
      (err, stdout, stderr) => {
        let code: number | null = null;
        if (err) {
          // Non-zero exit surfaces as err.code === <exit code>; spawn
          // failures surface as err.code === "ENOENT"-style strings.
          const c = (err as NodeJS.ErrnoException & { code?: number | string })?.code;
          code = typeof c === "number" ? c : null;
        } else {
          code = 0;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function workItem(golden: { unit: string; symbol: string }): WorkItem {
  return {
    id: `test-xenoblade-${golden.symbol}`,
    kind: "function",
    lifecycle: "pending",
    status: "FULL_MATCH",
    unitId: golden.unit,
    symbol: golden.symbol,
    attempts: 0,
    exhausted: false,
    ready: false,
    meta: {},
  };
}

test(
  "xenoblade adapter diff() matches hexdiff.py --json on FULL arrays for all three golden classes",
  { skip: envReason() ?? false },
  async () => {
    const adapter = new XenobladeAdapter();
    try {
      // M2.5 diff() does not touch ctx.store (the §7.1 pool handoff is M4).
      const ctx = {} as AdapterCtx;
      const root = resolveXenobladeRoot();
      const python = resolveXenobladePython(root);

      for (const golden of GOLDENS) {
        const item = workItem(golden);

        // The worker result (one "diff" RPC over diffEngine()'s persistent
        // WorkerPool — reused across the loop, no per-symbol spawn).
        const result = await adapter.diff(ctx, item);
        assert.ok(result !== null && typeof result === "object", "diff() must return a parsed result");
        assert.ok(Array.isArray(result.instructions), "diff() result must carry the instruction diff");
        assert.equal(result.symbol, golden.symbol);

        // One fresh hexdiff.py CLI run over the same objects (same --no-build).
        const cli = await runHexdiffCli(
          python,
          [join(root, "tools", "coop", "hexdiff.py"), golden.unit, "--symbol", golden.symbol, "--json", "--no-build"],
          root,
        );
        assert.ok(
          cli.code === 0 || cli.code === 5,
          `hexdiff CLI failed for ${golden.symbol} (code ${cli.code}): ${cli.stderr.slice(0, 500)}`,
        );
        const cliDoc = JSON.parse(cli.stdout) as DiffResult;

        // Parity on the stable count fields.
        for (const field of STABLE_FIELDS) {
          assert.deepEqual(result[field], cliDoc[field], `field "${field}" must match hexdiff.py --json`);
        }
        // FULL deep-compare of the per-slot/per-map/per-check arrays — not
        // just lengths (adversarial review HIGH-4).
        assert.deepEqual(
          result.instructions,
          cliDoc.instructions,
          `instructions must match row-for-row for ${golden.symbol}`,
        );
        assert.deepEqual(
          result.reg_mapping,
          cliDoc.reg_mapping,
          `reg_mapping must match for ${golden.symbol}`,
        );
        assert.deepEqual(
          result.size_check,
          cliDoc.size_check,
          `size_check must match for ${golden.symbol}`,
        );
        assert.deepEqual(
          result.retail_relocations,
          cliDoc.retail_relocations,
          `retail_relocations must match for ${golden.symbol}`,
        );
        assert.deepEqual(
          result.decomp_relocations,
          cliDoc.decomp_relocations,
          `decomp_relocations must match for ${golden.symbol}`,
        );

        // The golden must still be classified as its advertised diff class,
        // so the arrays above actually exercise mismatches/reg-swaps/etc.
        assertKind(golden.kind, result);

        // verify() maps the diff result: accepted only for the FULL_MATCH.
        const verdict = await adapter.verify(ctx, item);
        if (golden.kind === "full-match") {
          assert.equal(verdict.accepted, true);
          assert.equal(verdict.status, "FULL_MATCH");
          assert.equal(verdict.evidence.symbol, golden.symbol);
        } else {
          assert.equal(verdict.accepted, false);
          assert.match(String(verdict.feedback), /instructions differ/);
        }
      }
    } finally {
      await adapter.dispose();
    }
  },
);

test(
  "xenoblade adapter diff() on a not-found symbol rejects with WorkerRpcError carrying hexdiff rc 4",
  { skip: envReason() ?? false },
  async () => {
    const adapter = new XenobladeAdapter();
    try {
      const ctx = {} as AdapterCtx;
      const err = await adapter.diff(ctx, workItem({ unit: "kyoshin/CGame", symbol: "func_DEADBEEF__DoesNotExist" })).then(
        () => {
          throw new Error("expected diff() to reject for a not-found symbol");
        },
        (e: unknown) => e,
      );
      assert.ok(err instanceof WorkerRpcError, `got ${String(err)}`);
      assert.equal(err.code, "rpc");
      assert.equal(err.exitCode, 4, "hexdiff rc 4 (symbol not found) must be preserved");
      assert.match(String(err.message), /exit 4/);
    } finally {
      await adapter.dispose();
    }
  },
);

test(
  "xenoblade adapter verify() on a not-found symbol returns a rejected NOT_FOUND verdict, never throws",
  { skip: envReason() ?? false },
  async () => {
    const adapter = new XenobladeAdapter();
    try {
      const ctx = {} as AdapterCtx;
      const verdict = await adapter.verify(
        ctx,
        workItem({ unit: "kyoshin/CGame", symbol: "func_DEADBEEF__DoesNotExist" }),
      );
      assert.equal(verdict.accepted, false);
      assert.equal(verdict.status, "NOT_FOUND");
      assert.equal(verdict.evidence.symbol, "func_DEADBEEF__DoesNotExist");
      assert.match(String(verdict.feedback), /exit 4/);
    } finally {
      await adapter.dispose();
    }
  },
);
