/**
 * Pre-flight: exercise the non-model pieces of the live wiring against the
 * xenoblade worktree — adapter import, diff verifier (worker spawn + NDJSON),
 * the function-span extractor + applyCandidate splice (with rollback).
 *
 * Usage (from the decompi repo):
 *   DECOMPI_XENOBLADE_ROOT=... DECOMPI_XENOBLADE_PYTHON=... \
 *     npx tsx scripts/preflight-live.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import xenobladeAdapter, { resolveXenobladeRoot } from "../adapters/xenoblade/adapter.js";
import {
  applyCandidate,
  extractFunctionSpan,
  getFunctionAsm,
  readSource,
  sourcePathFor,
} from "../adapters/xenoblade/workflow.js";

const root = resolveXenobladeRoot();
console.log(`root: ${root}`);
if (!existsSync(join(root, "tools", "coop", "targets.json"))) {
  throw new Error(`targets.json missing under ${root}`);
}

// 1. Adapter importWorkItems → the 5 target TUs present?
const items = await xenobladeAdapter.importWorkItems({});
const units = new Set(["kyoshin/CSaveLoad", "nw4r/src/snd/snd_ExternalSoundPlayer",
  "nw4r/src/lyt/lyt_texMap", "CriWare/src/adx/ahx/ahx_sbf2", "CriWare/src/adx/adxt/srcwii/adx_suwii"]);
const wanted = items.filter((i) => units.has(i.unitId ?? ""));
console.log(`imported ${items.length} work items; ${wanted.length} in the 5 target TUs`);
for (const w of wanted.filter((i) => i.status === "NOT_STARTED")) {
  console.log(`  NOT_STARTED: ${w.id} ${w.symbol} (${w.size} bytes) source=${w.source}`);
}

// 2. Diff verifier (worker spawn + diff RPC) on the CSaveLoad stub.
const stub = wanted.find((i) => i.id === "us-80293800")!;
const verdict = await xenobladeAdapter.verify({} as never, stub);
console.log(`verify(${stub.symbol}): accepted=${verdict.accepted} status=${verdict.status} ` +
  `mismatch=${(verdict.evidence.diff as { mismatch_count?: number }).mismatch_count}`);

// 3. getFunctionAsm (retail asm read).
const asm = await getFunctionAsm({ ...stub, kind: "function", asmText: "" } as never);
console.log(`asm(${stub.symbol}): ${asm.split("\n").length} lines`);

// 4. extractFunctionSpan + applyCandidate with rollback, on each NOT_STARTED TU.
const notStarted = wanted.filter((i) => i.status === "NOT_STARTED");
let spliced = 0;
for (const t of notStarted) {
  const path = sourcePathFor(t);
  const before = readFileSync(path, "utf8");
  const span = extractFunctionSpan(before, t.symbol!);
  if (!span) {
    console.log(`extractFunctionSpan(${t.symbol}): NOT FOUND`);
    continue;
  }
  const origText = before.slice(span.start, span.end);
  const candidate = origText.replace(/\{\s*[\s\S]*\}/, "{ /* spliced by preflight */ }");
  try {
    const updated = await applyCandidate({ ...t, kind: "function", asmText: "" } as never, candidate);
    console.log(`applyCandidate(${t.symbol}): span [${span.start},${span.end}) ok, ` +
      `externC=${/^\s*extern\s+"C"/.test(origText) ? "yes" : "no"}`);
    spliced++;
    writeFileSync(path, before); // rollback — keep the worktree pristine
  } catch (err) {
    console.log(`applyCandidate(${t.symbol}): ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`spliced ${spliced}/${notStarted.length}`);

await xenobladeAdapter.dispose();
console.log("preflight OK");
