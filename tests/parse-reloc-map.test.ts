/**
 * M1b tests for the retail reloc map reader (`src/parse/symbols/reloc-map.ts`)
 * and its wiring into `classifyExternC` (fix #11): reloc-map-only retail names
 * (e.g. `lbl_eu_805203C0`, which never appear in a region symbols.txt) must
 * classify as exact instead of invented, mirroring extc.py's merged name set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSymbols } from "../src/parse/symbols/table.js";
import { loadRelocMap } from "../src/parse/symbols/reloc-map.js";
import { classifyExternC } from "../src/parse/symbols/extc.js";

const RMAP_JSON = JSON.stringify({
  count: 2,
  entries: {
    Decibel2RatioTable__Q44nw4r3snd6detail4Util: {
      R_PPC_ADDR16_HA: {
        addend_delta: 0,
        kind: "data",
        retail_symbol: "lbl_eu_805203C0",
      },
    },
    DefaultBlackColor: {
      R_PPC_EMB_SDA21: {
        addend_delta: 0,
        kind: "data",
        retail_symbol: "DefaultBlackColor_8066B550",
      },
    },
  },
});

const TABLE = loadSymbols("memcpy = .init:0x80004000; // type:function\n");

test("loadRelocMap collects every retail_symbol name", () => {
  const m = loadRelocMap(RMAP_JSON);
  assert.deepEqual([...m.names].sort(), [
    "DefaultBlackColor_8066B550",
    "lbl_eu_805203C0",
  ]);
});

test("loadRelocMap tolerates malformed JSON (empty map)", () => {
  assert.equal(loadRelocMap("not json {{{").names.size, 0);
  assert.equal(loadRelocMap('{"entries": 5}').names.size, 0);
  assert.equal(loadRelocMap("{}").names.size, 0);
});

test("classifyExternC: reloc-map-only retail name is exact (not invented)", () => {
  const rmap = loadRelocMap(RMAP_JSON);
  const without = classifyExternC({ name: "lbl_eu_805203C0", params: [], line: 1 }, TABLE);
  assert.equal(without.category.category, "invented"); // absent without the map
  const withMap = classifyExternC({ name: "lbl_eu_805203C0", params: [], line: 1 }, TABLE, rmap);
  assert.equal(withMap.category.category, "exact");
  if (withMap.category.category === "exact") {
    assert.match(withMap.category.reason, /reloc map/);
  }
});

test("classifyExternC: reloc-map name participates in drift resolution", () => {
  const rmap = loadRelocMap(RMAP_JSON);
  // `DefaultBlackColor_8066B550_jp` — retail reloc-map name + JP suffix → drift
  const r = classifyExternC({ name: "DefaultBlackColor_8066B550_jp", params: [], line: 1 }, TABLE, rmap);
  assert.equal(r.category.category, "drift");
  if (r.category.category === "drift") {
    assert.equal(r.category.resolved, "DefaultBlackColor_8066B550");
  }
});
