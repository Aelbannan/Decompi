/**
 * M1b tests for the .o data-pointer scan (`src/parse/asm/objscan.ts`), a port
 * of `build_data_hits` / `data_pointer_hits` from
 * `tools/coop/member_check.py` (SPEC §13.3, `member.P1`): a symbol's address
 * stored as a 4-byte big-endian pointer in a retail `.o` file marks a
 * candidate vtable / function-pointer slot.
 *
 * Uses a temp dir with a small fake `.o` (a Buffer containing known 4-byte
 * big-endian values at known offsets) plus a matching symbolAddrs map.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanObjectFiles } from "../src/parse/asm/objscan.js";
import type { DataHit } from "../src/parse/asm/objscan.js";

const FN_A = 0x8007dca8; // plausible retail function address
const FN_B = 0x8005a6e4; // another symbol address

/**
 * Create a temp dir under `tmpdir()` containing the given fake `.o` files
 * (relative path -> bytes), returning the temp dir. Cleaned up by `t.after`.
 */
function makeObjectDir(
  t: { after(fn: () => void): void },
  files: Record<string, number[]>
): string {
  const dir = mkdtempSync(join(tmpdir(), "decompi-objscan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, bytes] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, Buffer.from(bytes));
  }
  return dir;
}

test("finds big-endian symbol-address pointers at aligned offsets", (t) => {
  const dir = makeObjectDir(t, {
    "obj/unit.o": [
      0x00, 0x00, 0x00, 0x00, // offset 0: null, no match
      0xde, 0xad, 0xbe, 0xef, // offset 4: garbage, no match
      0x80, 0x07, 0xdc, 0xa8, // offset 8: FN_A (matches)
      0x80, 0x05, 0xa6, 0xe4, // offset 12: FN_B (matches)
      0x00, 0x01, // trailing partial word (< 4 bytes): never scanned
    ],
  });
  const symbolAddrs = new Map<number, string>([
    [FN_A, "func_8007DCA8__Q22cf13CfGameManagerFv"],
    [FN_B, "func_8005A6E4Fv"],
  ]);
  const hits = scanObjectFiles(dir, symbolAddrs);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], {
    objectFile: "obj/unit.o",
    offset: 8,
    address: FN_A,
    symbol: "func_8007DCA8__Q22cf13CfGameManagerFv",
  });
  assert.deepEqual(hits[1], {
    objectFile: "obj/unit.o",
    offset: 12,
    address: FN_B,
    symbol: "func_8005A6E4Fv",
  });
});

test("does not match little-endian-encoded or unrelated values", (t) => {
  const dir = makeObjectDir(t, {
    "obj/le.o": [
      0xa8, 0xdc, 0x07, 0x80, // FN_A little-endian: reads as 0xa8dc0780 BE
      0x80, 0x07, 0xdc, 0xa8, // FN_A big-endian at offset 4: the only match
    ],
  });
  const symbolAddrs = new Map<number, string>([[FN_A, "func_8007DCA8Fv"]]);
  const hits = scanObjectFiles(dir, symbolAddrs);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.offset, 4);
  assert.equal(hits[0]!.address, FN_A);
});

test("recurses into subdirectories and ignores non-.o files", (t) => {
  const dir = makeObjectDir(t, {
    "obj/a/unit.o": [0x80, 0x07, 0xdc, 0xa8],
    "obj/a/notes.txt": [0x80, 0x07, 0xdc, 0xa8], // must be ignored (no .o suffix)
    "obj/other.o": [0x80, 0x05, 0xa6, 0xe4],
  });
  const symbolAddrs = new Map<number, string>([
    [FN_A, "func_8007DCA8Fv"],
    [FN_B, "func_8005A6E4Fv"],
  ]);
  const hits = scanObjectFiles(dir, symbolAddrs);
  assert.deepEqual(
    hits.map((h) => h.objectFile),
    ["obj/a/unit.o", "obj/other.o"] // sorted traversal; notes.txt never scanned
  );
  assert.equal(hits.length, 2);
});

test("returns [] for a missing objectDir", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "decompi-objscan-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const symbolAddrs = new Map<number, string>([[FN_A, "func_8007DCA8Fv"]]);
  assert.deepEqual(scanObjectFiles(join(dir, "does-not-exist"), symbolAddrs), []);
});

test("returns [] for an empty symbolAddrs map", (t) => {
  const dir = makeObjectDir(t, {
    "obj/unit.o": [0x80, 0x07, 0xdc, 0xa8],
  });
  assert.deepEqual(scanObjectFiles(dir, new Map<number, string>()), []);
});

test("unaligned pointers are NOT found (aligned-only scan — documented deviation, fix #8)", (t) => {
  // The reference (`member_check.build_data_hits`) counts raw packed-byte
  // occurrences at ANY byte offset, so FN_A stored at offset 1 WOULD match
  // there. This port scans only 4-byte ALIGNED offsets (each hit carries its
  // precise slot offset), so an unaligned pointer is deliberately missed.
  // Real retail vtables are aligned; this test proves the deviation exists.
  const dir = makeObjectDir(t, {
    "obj/unaligned.o": [
      0xde, // offset 0: padding
      0x80, 0x07, 0xdc, 0xa8, // offsets 1..4: FN_A big-endian (UNALIGNED)
      0xde, 0xad, 0xbe, 0xef, // offsets 5..8: garbage
    ],
  });
  const symbolAddrs = new Map<number, string>([[FN_A, "func_8007DCA8Fv"]]);
  assert.deepEqual(scanObjectFiles(dir, symbolAddrs), []);
  // sanity: the same bytes at an ALIGNED offset are found
  const dir2 = makeObjectDir(t, {
    "obj/aligned.o": [0x80, 0x07, 0xdc, 0xa8],
  });
  assert.equal(scanObjectFiles(dir2, symbolAddrs).length, 1);
});

test("DataHit shape contract is importable and type-safe", () => {
  const hit: DataHit = {
    objectFile: "kyoshin/cf/CfGameManager.o",
    offset: 0x14,
    address: FN_A,
    symbol: "func_8007DCA8__Q22cf13CfGameManagerFv",
  };
  assert.equal(hit.offset % 4, 0);
  assert.equal(typeof hit.address, "number");
  assert.equal(typeof hit.symbol, "string");
});
