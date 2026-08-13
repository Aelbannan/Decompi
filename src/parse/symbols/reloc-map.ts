/**
 * M1b — retail reloc map (src/parse/symbols/reloc-map.ts).
 *
 * Minimal reader for the Xenoblade fork's `tools/coop/retail_reloc_map.json`
 * (SPEC §13.3 `relocMap` adapter source). The map records, per reloc symbol,
 * the retail symbol each relocation resolved to; those `retail_symbol` names
 * are ground-truth retail names that may NOT appear in the region symbols.txt
 * (e.g. `lbl_eu_805203C0`). `extc.py` merges them into its name set; this
 * module lets the TS classifier do the same.
 *
 *   {
 *     "entries": {
 *       "Decibel2RatioTable__Q44nw4r3snd6detail4Util": {
 *         "R_PPC_ADDR16_HA": { "retail_symbol": "lbl_eu_805203C0", ... }
 *       }, ...
 *     }
 *   }
 */
export interface RelocMap {
  /** every `retail_symbol` name referenced by the reloc map (deduped). */
  names: Set<string>;
}

/** Parse the retail_reloc_map.json text into a {@link RelocMap}. */
export function loadRelocMap(jsonText: string): RelocMap {
  const names = new Set<string>();
  try {
    const data: unknown = JSON.parse(jsonText);
    const entries =
      data !== null && typeof data === "object" && "entries" in data
        ? (data as { entries?: Record<string, unknown> }).entries
        : undefined;
    if (entries === undefined) {
      return { names };
    }
    for (const kinds of Object.values(entries)) {
      if (kinds === null || typeof kinds !== "object") {
        continue;
      }
      for (const v of Object.values(kinds as Record<string, unknown>)) {
        if (v !== null && typeof v === "object") {
          const rs = (v as { retail_symbol?: unknown }).retail_symbol;
          if (typeof rs === "string" && rs.length > 0) {
            names.add(rs);
          }
        }
      }
    }
  } catch {
    // malformed input: empty map (mirrors extc.py skipping a missing file)
  }
  return { names };
}
