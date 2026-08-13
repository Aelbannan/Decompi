/**
 * Model directory (SPEC §14). Named model presets validated from `models.json`
 * and round-tripped through the `models` table (§6.2).
 */
import type { ModelSpec, ModelCost, ThinkingLevel } from "../types.js";
import type { SqlAdapter } from "../core/store/adapter.js";
import { createHash } from "node:crypto";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh",
];

const COST_KEYS = ["inputPerM", "outputPerM", "cacheReadPerM", "cacheWritePerM"] as const;

/** Spec keys `loadModels` understands; anything else is warned about, never silently dropped. */
const SPEC_KEYS = new Set(["provider", "model", "thinkingLevel", "maxTokens", "rpm", "cost"]);

export interface ModelDirectoryEntry {
  name: string;
  spec: ModelSpec;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a parsed models.json doc; throws on the first invalid entry. */
export function loadModels(json: unknown): ModelDirectoryEntry[] {
  if (!isRecord(json)) throw new Error("models.json must be a JSON object of { name: spec }");
  const out: ModelDirectoryEntry[] = [];
  for (const [name, raw] of Object.entries(json)) {
    if (!name) throw new Error("models.json: empty model name");
    if (!isRecord(raw)) throw new Error(`models.${name}: spec must be an object`);
    // Unknown keys are a config smell: warn loudly instead of dropping them
    // silently (a typo'd `thinkinLevel` must not look like it took effect).
    const unknown = Object.keys(raw).filter((k) => !SPEC_KEYS.has(k));
    if (unknown.length > 0) {
      console.warn(`models.${name}: ignoring unknown key(s): ${unknown.join(", ")}`);
    }
    const provider = raw.provider;
    const model = raw.model;
    if (typeof provider !== "string" || !provider) {
      throw new Error(`models.${name}.provider must be a non-empty string`);
    }
    if (typeof model !== "string" || !model) {
      throw new Error(`models.${name}.model must be a non-empty string`);
    }
    const thinkingLevel = raw.thinkingLevel;
    if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) {
      throw new Error(
        `models.${name}.thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`,
      );
    }
    const maxTokens = raw.maxTokens ?? 0;
    if (!Number.isInteger(maxTokens) || (maxTokens as number) < 0) {
      throw new Error(`models.${name}.maxTokens must be an integer >= 0`);
    }
    const rpm = raw.rpm ?? 0;
    if (!Number.isInteger(rpm) || (rpm as number) < 0) {
      throw new Error(`models.${name}.rpm must be an integer >= 0`);
    }
    const costRaw = raw.cost ?? {};
    if (!isRecord(costRaw)) throw new Error(`models.${name}.cost must be an object`);
    const cost: ModelCost = {
      inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0,
    };
    for (const k of COST_KEYS) {
      const v = costRaw[k] ?? 0;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`models.${name}.cost.${k} must be a number >= 0`);
      }
      cost[k] = v;
    }
    out.push({
      name,
      spec: {
        provider, model,
        thinkingLevel: thinkingLevel as ThinkingLevel,
        maxTokens: maxTokens as number,
        rpm: rpm as number,
        cost,
      },
    });
  }
  return out;
}

/** sha256 hex digest of a string (content_hash cache invalidation). */
function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Persist validated entries to the `models` table (name PK). `content_hash`
 * is the sha256 of the canonical spec JSON — the cache key that lets a later
 * load skip re-importing an unchanged models.json (schema §6.2).
 */
export async function persistModels(adapter: SqlAdapter, entries: ModelDirectoryEntry[]): Promise<void> {
  for (const { name, spec } of entries) {
    const contentHash = sha256(JSON.stringify(spec));
    await adapter.execute(
      `INSERT INTO models (name, provider, model, thinking_level, max_tokens, rpm, cost, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         provider=excluded.provider, model=excluded.model,
         thinking_level=excluded.thinking_level, max_tokens=excluded.max_tokens,
         rpm=excluded.rpm, cost=excluded.cost, content_hash=excluded.content_hash`,
      [name, spec.provider, spec.model, spec.thinkingLevel, spec.maxTokens, spec.rpm,
       JSON.stringify(spec.cost), contentHash],
    );
  }
}

/** Load the `models` table back into ModelSpec entries. */
export async function loadModelsFromStore(adapter: SqlAdapter): Promise<ModelDirectoryEntry[]> {
  const rows = await adapter.query<{
    name: string; provider: string; model: string; thinking_level: string;
    max_tokens: number; rpm: number; cost: string;
  }>("SELECT name, provider, model, thinking_level, max_tokens, rpm, cost FROM models ORDER BY name");
  return rows.map((r) => ({
    name: r.name,
    spec: {
      provider: r.provider,
      model: r.model,
      thinkingLevel: r.thinking_level as ThinkingLevel,
      maxTokens: r.max_tokens,
      rpm: r.rpm,
      cost: JSON.parse(r.cost || "{}") as ModelCost,
    },
  }));
}
