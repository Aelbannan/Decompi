/**
 * M5 — Xenoblade `importWorkItems` tests (SPEC §6.4 live read). Hermetic: a
 * SMALL frozen fixture (3 targets shaped like the coop targets.json) is
 * written to a temp `tools/coop/targets.json` that `DECOMPI_XENOBLADE_ROOT`
 * points at — the 18 MB live registry is never touched. Covers the §6.4
 * field map (id preservation, hex size parse, workflow_status → lifecycle,
 * meta capture of un-mapped fields), the adapter region default, and the
 * mtime/size-keyed parse cache.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XenobladeAdapter } from "../adapters/xenoblade/adapter.js";
import type { AdapterCtx } from "../src/adapter/types.js";
import type { WorkItem } from "../src/types.js";

/** importWorkItems never touches the store (a READ — the daemon inserts). */
const ctx = {} as AdapterCtx;

/**
 * Frozen fixture: 3 targets shaped like `tools/coop/targets.json`, incl. a
 * hex size, several workflow_status values, extra/un-mapped fields
 * (instruction_match, called_functions, depends_on, capabilities, …), a null
 * address, a missing workflow_status, and a non-hex size.
 */
const FIXTURE = {
  targets: [
    {
      id: "game-wk-render",
      kind: "function",
      unit: "kyoshin/CGame",
      status: "FULL_MATCH",
      workflow_status: "ACCEPTED",
      region: "us",
      symbol: "wkRender__5CGameFv",
      address: null,
      milestone: "render",
      required_level: "EQUIVALENT_MATCH",
      size: "0x29C",
      source: "src/kyoshin/CGame.cpp",
      instruction_match: 100.0,
      called_functions: ["us-801379b4", "us-80137bcc"],
      unresolved_called_functions: [],
      has_indirect_calls: true,
      depends_on: ["some-other-target"],
      capabilities: ["needs-both"],
      claim: "b14",
      notes: "frozen fixture entry",
    },
    {
      id: "menu-arts-ctor",
      kind: "function",
      unit: "kyoshin/menu/CMenuArtsSelect",
      status: "NOT_STARTED",
      workflow_status: "DISCOVERY",
      symbol: "__ct__CMenuArtsSelect",
      address: "0x80102B08",
      milestone: "presentation",
      required_level: "EQUIVALENT_MATCH",
      size: "0xB4",
      source: "src/kyoshin/menu/CMenuArtsSelect.cpp",
      instruction_match: 0,
    },
    {
      // No workflow_status → lifecycle "pending"; no region → adapter
      // default; non-hex size → undefined.
      id: "padmgr-get-instance",
      kind: "function",
      unit: "kyoshin/cf/CfGameManager",
      status: "NOT_STARTED",
      symbol: "getInstance__Q22cf13CfGameManagerFv",
      address: "0x8007E418",
      size: "not-hex",
      source: "src/kyoshin/cf/CfGameManager.cpp",
      has_indirect_calls: false,
    },
  ],
};

/** Point DECOMPI_XENOBLADE_ROOT at a temp dir; write targets.json on demand. */
function withFixtureRoot(): {
  path: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "decompi-xenoblade-import-"));
  const coopDir = join(root, "tools", "coop");
  mkdirSync(coopDir, { recursive: true });
  const path = join(coopDir, "targets.json");
  const prev = process.env.DECOMPI_XENOBLADE_ROOT;
  process.env.DECOMPI_XENOBLADE_ROOT = root;
  return {
    path,
    cleanup: () => {
      if (prev === undefined) delete process.env.DECOMPI_XENOBLADE_ROOT;
      else process.env.DECOMPI_XENOBLADE_ROOT = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Deterministic mtime (2000-01-01T00:00:00Z — whole ms, no fs drift). */
const MTIME_SECONDS = 946_684_800;

test("importWorkItems maps the §6.4 field map from a small targets.json fixture", async () => {
  const fixture = withFixtureRoot();
  try {
    writeFileSync(fixture.path, JSON.stringify(FIXTURE));
    const items = await new XenobladeAdapter().importWorkItems(ctx);
    assert.equal(items.length, 3);

    // id preserved verbatim (the registry join key — SPEC §6.4).
    assert.equal(items[0].id, "game-wk-render");
    // promoted columns (unit→unitId, required_level→requiredLevel, …).
    assert.equal(items[0].kind, "function");
    assert.equal(items[0].unitId, "kyoshin/CGame");
    assert.equal(items[0].status, "FULL_MATCH");
    assert.equal(items[0].region, "us");
    assert.equal(items[0].symbol, "wkRender__5CGameFv");
    assert.equal(items[0].address, undefined, "null address → undefined");
    assert.equal(items[0].milestone, "render");
    assert.equal(items[0].requiredLevel, "EQUIVALENT_MATCH");
    assert.equal(items[0].source, "src/kyoshin/CGame.cpp");
    // hex size parsed to bytes (0x29C = 668).
    assert.equal(items[0].size, 668);
    assert.equal(items[1].size, 180, "0xB4 = 180");
    // workflow_status → lifecycle (ACCEPTED → accepted).
    assert.equal(items[0].lifecycle, "accepted");
    // materialized columns are store-side: a live read leaves defaults.
    assert.equal(items[0].attempts, 0);
    assert.equal(items[0].exhausted, false);
    assert.equal(items[0].ready, false);
    // meta captures every un-mapped field, JSON-serializable as-is.
    assert.equal(items[0].meta.instruction_match, 100.0);
    assert.deepEqual(items[0].meta.called_functions, ["us-801379b4", "us-80137bcc"]);
    assert.deepEqual(items[0].meta.unresolved_called_functions, []);
    assert.equal(items[0].meta.has_indirect_calls, true);
    assert.deepEqual(items[0].meta.depends_on, ["some-other-target"]);
    assert.deepEqual(items[0].meta.capabilities, ["needs-both"]);
    assert.equal(items[0].meta.claim, "b14");
    assert.equal(items[0].meta.notes, "frozen fixture entry");
    // promoted columns must not leak into meta.
    assert.equal("unit" in items[0].meta, false);
    assert.equal("workflow_status" in items[0].meta, false);
    assert.equal("size" in items[0].meta, false);

    // DISCOVERY → pending; missing workflow_status → pending; missing region
    // → default "us"; non-hex size → undefined.
    assert.equal(items[1].lifecycle, "pending");
    assert.equal(items[2].lifecycle, "pending");
    assert.equal(items[2].region, "us");
    assert.equal(items[2].size, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("workflow_status → lifecycle covers the full §6.4 map; missing → pending", async () => {
  const fixture = withFixtureRoot();
  const doc = {
    targets: [
      { id: "a", kind: "function", status: "NOT_STARTED", workflow_status: "QUEUED" },
      { id: "b", kind: "function", status: "NOT_STARTED", workflow_status: "CLAIMED" },
      { id: "c", kind: "function", status: "NOT_STARTED", workflow_status: "ACTIVE" },
      { id: "d", kind: "function", status: "NOT_STARTED", workflow_status: "BACKLOG" },
      { id: "e", kind: "function", status: "NOT_STARTED", workflow_status: "BLOCKED" },
      { id: "f", kind: "function", status: "NOT_STARTED", workflow_status: "ACCEPTED" },
      { id: "g", kind: "function", status: "NOT_STARTED", workflow_status: "REVALIDATION_REQUIRED" },
      { id: "h", kind: "function", status: "NOT_STARTED", workflow_status: "NOT_REQUIRED" },
      { id: "i", kind: "function", status: "NOT_STARTED" },
      { id: "j", kind: "function", status: "NOT_STARTED", workflow_status: "SOME_FUTURE_STATE" },
    ],
  };
  try {
    writeFileSync(fixture.path, JSON.stringify(doc));
    const items = await new XenobladeAdapter().importWorkItems(ctx);
    assert.deepEqual(
      items.map((item: WorkItem) => item.lifecycle),
      [
        "pending", // QUEUED
        "pending", // CLAIMED
        "pending", // ACTIVE
        "blocked", // BACKLOG
        "blocked", // BLOCKED
        "accepted", // ACCEPTED
        "revalidation_required", // REVALIDATION_REQUIRED
        "not_required", // NOT_REQUIRED
        "pending", // missing
        "pending", // unknown value → same default as missing
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("region defaults to DECOMPI_XENOBLADE_REGION ?? 'us'; an explicit target region wins", async () => {
  const fixture = withFixtureRoot();
  const doc = {
    targets: [
      { id: "no-region", kind: "function", status: "NOT_STARTED" },
      { id: "explicit", kind: "function", status: "NOT_STARTED", region: "jp" },
    ],
  };
  const prevRegion = process.env.DECOMPI_XENOBLADE_REGION;
  process.env.DECOMPI_XENOBLADE_REGION = "eu";
  try {
    writeFileSync(fixture.path, JSON.stringify(doc));
    const items = await new XenobladeAdapter().importWorkItems(ctx);
    assert.equal(items[0].region, "eu", "target without region takes the adapter default");
    assert.equal(items[1].region, "jp", "explicit target region is preserved");
  } finally {
    if (prevRegion === undefined) delete process.env.DECOMPI_XENOBLADE_REGION;
    else process.env.DECOMPI_XENOBLADE_REGION = prevRegion;
    fixture.cleanup();
  }
});

test("the parse cache is keyed by mtime+size: an unchanged file reuses the parse, a touch re-parses", async () => {
  const docA = { targets: [{ id: "AAAA", kind: "function", status: "NOT_STARTED" }] };
  const docB = { targets: [{ id: "BBBB", kind: "function", status: "NOT_STARTED" }] };
  assert.equal(
    JSON.stringify(docA).length,
    JSON.stringify(docB).length,
    "fixture: both docs must be byte-identical in size",
  );
  const fixture = withFixtureRoot();
  try {
    writeFileSync(fixture.path, JSON.stringify(docA));
    utimesSync(fixture.path, MTIME_SECONDS, MTIME_SECONDS);
    const adapter = new XenobladeAdapter();
    assert.equal((await adapter.importWorkItems(ctx))[0].id, "AAAA");

    // Same byte size + same mtime, different content: the cache key matches,
    // so the import MUST NOT re-parse — it returns the stale first parse.
    writeFileSync(fixture.path, JSON.stringify(docB));
    utimesSync(fixture.path, MTIME_SECONDS, MTIME_SECONDS);
    assert.equal(
      (await adapter.importWorkItems(ctx))[0].id,
      "AAAA",
      "a same-mtime/same-size file must be served from the parse cache",
    );

    // A touch (new mtime) invalidates the key → re-parses the new content.
    utimesSync(fixture.path, MTIME_SECONDS + 1, MTIME_SECONDS + 1);
    assert.equal((await adapter.importWorkItems(ctx))[0].id, "BBBB");
  } finally {
    fixture.cleanup();
  }
});

test("importWorkItems throws a clear error when targets.json is missing", async () => {
  const fixture = withFixtureRoot(); // no file written
  try {
    await assert.rejects(
      () => new XenobladeAdapter().importWorkItems(ctx),
      /targets\.json not found/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("importWorkItems rejects a file without a targets array", async () => {
  const fixture = withFixtureRoot();
  try {
    writeFileSync(fixture.path, JSON.stringify({ nope: true }));
    await assert.rejects(
      () => new XenobladeAdapter().importWorkItems(ctx),
      /no "targets" array/,
    );
  } finally {
    fixture.cleanup();
  }
});
