import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadModels, persistModels, loadModelsFromStore } from "../src/models/directory.js";
import { SqliteAdapter } from "../src/core/store/sqlite.js";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

test("loadModels accepts a valid doc", () => {
  const entries = loadModels({
    "nube-ds4-flash-low": {
      provider: "nube", model: "ds4-flash", thinkingLevel: "low",
      maxTokens: 0, rpm: 20,
      cost: { inputPerM: 0.5, outputPerM: 1.5, cacheReadPerM: 0.1, cacheWritePerM: 1.5 },
    },
    "xhigh-free": { provider: "p", model: "m", thinkingLevel: "xhigh" },
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].spec.thinkingLevel, "low");
  // defaults applied
  assert.equal(entries[1].spec.maxTokens, 0);
  assert.equal(entries[1].spec.cost.inputPerM, 0);
});

test("loadModels rejects invalid entries", () => {
  assert.throws(() => loadModels({ m: { provider: "p", model: "m", thinkingLevel: "wat" } }),
    /thinkingLevel/);
  assert.throws(() => loadModels({ m: { model: "m", thinkingLevel: "low" } }), /provider/);
  assert.throws(() => loadModels({ m: { provider: "p", model: "m", thinkingLevel: "low", cost: { inputPerM: -1 } } }),
    /cost.inputPerM/);
  assert.throws(() => loadModels({ m: { provider: "p", model: "m", thinkingLevel: "low", maxTokens: 1.5 } }),
    /maxTokens/);
});

test("persist/load round-trips through the models table", async () => {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  const entries = loadModels({
    "a": { provider: "p", model: "m", thinkingLevel: "high", rpm: 5, cost: { inputPerM: 1 } },
  });
  await persistModels(db, entries);
  const loaded = await loadModelsFromStore(db);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].spec, entries[0].spec);
});

test("loadModels warns about unknown spec keys instead of dropping them silently", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    loadModels({
      m: { provider: "p", model: "m", thinkingLevel: "low", maxTokens: 5, thinkinLevel: "high", bogus: 1 },
    });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /models\.m: ignoring unknown key\(s\)/);
  assert.match(warnings[0]!, /thinkinLevel/);
  assert.match(warnings[0]!, /bogus/);
  // Known keys never warn.
  const clean: string[] = [];
  console.warn = (msg: unknown) => void clean.push(String(msg));
  try {
    loadModels({ m: { provider: "p", model: "m", thinkingLevel: "low" } });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(clean, []);
});

test("persistModels writes a sha256 content_hash (models.json cache key)", async () => {
  const db = new SqliteAdapter(":memory:");
  await db.migrate([]);
  const entries = loadModels({
    "a": { provider: "p", model: "m", thinkingLevel: "high", rpm: 5, cost: { inputPerM: 1 } },
  });
  await persistModels(db, entries);

  const rows = await db.query<{ name: string; content_hash: string | null }>(
    "SELECT name, content_hash FROM models",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "a");
  assert.equal(rows[0]!.content_hash, sha256(JSON.stringify(entries[0]!.spec)));

  // Re-persisting a changed spec updates the hash (cache invalidation).
  const changed = loadModels({
    "a": { provider: "p", model: "m", thinkingLevel: "xhigh", rpm: 5, cost: { inputPerM: 1 } },
  });
  await persistModels(db, changed);
  const after = await db.query<{ content_hash: string | null }>(
    "SELECT content_hash FROM models WHERE name = ?",
    ["a"],
  );
  assert.equal(after[0]!.content_hash, sha256(JSON.stringify(changed[0]!.spec)));
  assert.notEqual(after[0]!.content_hash, rows[0]!.content_hash);
});
