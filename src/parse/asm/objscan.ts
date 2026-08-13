/**
 * M1b .o data-pointer scan (SPEC §13.3): scan retail object files for symbol
 * addresses stored as 4-byte big-endian pointers.
 *
 * This is the `member.P1` evidence family — a symbol's address appearing as a
 * pointer-sized word in retail `.data` marks it as a candidate vtable slot /
 * function-pointer slot.
 *
 * Port of `build_data_hits` / `data_pointer_hits` in
 * `tools/coop/member_check.py` (Xenoblade co-op fork), with one deliberate
 * difference: instead of counting packed-byte occurrences per address, we
 * scan every 4-byte aligned offset exactly once, so each hit carries its
 * precise byte offset (useful for locating the slot within a vtable).
 * Relative paths are used for `objectFile` (relative to `objectDir`), and
 * results are deterministic: files in sorted traversal order, hits in offset
 * order within a file.
 *
 * Documented deviation (docs/m1b-parity.md): the reference counts raw packed
 * occurrences at ANY byte offset (an unaligned pointer would match there);
 * this port only scans 4-byte ALIGNED offsets, so a symbol address stored at
 * an unaligned offset is not found. Real retail vtables are aligned, so the
 * deviation is theoretical — proven by the unaligned test in
 * tests/parse-objscan.test.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** A symbol address stored as a 4-byte big-endian pointer in a retail `.o` file. */
export interface DataHit {
  objectFile: string;
  offset: number;
  address: number;
  symbol: string;
}

/** Recursively list `.o` files under `dir` in deterministic (sorted) order. */
function listObjectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listObjectFiles(full));
    } else if (st.isFile() && name.endsWith(".o")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan every 4-byte aligned offset of each `.o` file under `objectDir` as a
 * big-endian u32; when the word matches a symbol address, record a DataHit.
 * Missing/unreadable `objectDir` yields no hits (mirrors the reference's
 * `if not OBJ_DIR.is_dir(): return hits`). A trailing partial word (< 4
 * bytes) is never scanned.
 */
export function scanObjectFiles(
  objectDir: string,
  symbolAddrs: Map<number, string>
): DataHit[] {
  const hits: DataHit[] = [];
  if (symbolAddrs.size === 0) {
    return hits;
  }
  let files: string[];
  try {
    files = listObjectFiles(objectDir);
  } catch {
    return hits;
  }
  for (const file of files) {
    const data = readFileSync(file);
    const objectFile = relative(objectDir, file);
    for (let offset = 0; offset + 4 <= data.length; offset += 4) {
      const address = data.readUInt32BE(offset);
      const symbol = symbolAddrs.get(address);
      if (symbol !== undefined) {
        hits.push({ objectFile, offset, address, symbol });
      }
    }
  }
  return hits;
}
