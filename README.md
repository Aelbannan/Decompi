# Decompi

A **game-agnostic decomp-matching orchestration harness** built on the pi SDK.
It replaces the Xenoblade-only `tools/pi_harness` and the Python coop tooling it
shelled out to. One installable TypeScript package; each game ships an
*adapter*.

- **TypeScript-first.** Workflows are typed classes with hooks, not raw step graphs.
- **One database.** SQLite (WAL) holds work items, claims, runs, events, telemetry,
  and per-workflow status. Postgres is a later drop-in behind a `SqlAdapter`.
- **No Python in the control plane.** Orchestration, linter, claims, status, store,
  and UI are TS. The diff engine and the equivalence witness are external
  **persistent worker processes** (spawn once, serve many — no per-call startup).
- **Control plane.** A daemon owns the store; a web UI controls and inspects runs;
  an introspection agent analyzes them.
- **Full observability.** Typed append-only events, spans, costs, budgets.

See **[SPEC.md](./SPEC.md)** for the implementation contract and
**[docs/](./docs/)** for the workflow-authoring specs and the adversarial review
trail.

---

## Status

Implemented and green (**538 tests**, `npm run typecheck` clean):

| Area | What's there |
|---|---|
| **Store** | `SqlAdapter` (SQLite WAL), WorkItem/Selector, lease claims, typed events, embedded single-writer daemon |
| **Parser/linter** | tree-sitter-cpp whole-file rules (smell/pointer/match/clone/define-alias), line-oriented delta gate, `report --check` |
| **Binary analyzers** | dtk `.s` parser, `.o` scan, symbols.txt + MWCC mangled-name parser, member-vs-free + extern-C classifiers |
| **Diff engine** | persistent worker wrapping `hexdiff.py` + `ppc_equivalence` (≈80× vs per-call Python) |
| **Pipeline engine** | `foreach`/`onReject`/`gate`/`select`/`agentLoop` steps, triggers, budget/resume/per-model pacing |
| **Workflow API** | `Workflow` class (typed hooks: `setup`/`startPrompt`/`reprompt`/`complete`), `ctx.helpers`, `StartJsonAgent` judge, per-workflow **status ladder**, custom tools + `finish` |
| **Control plane** | REST + SSE + web UI + run scheduler + introspection agent + security (tokens, audit, spend caps) |
| **Xenoblade cut-over** | `importWorkItems` (live targets.json read), real helpers (`getFunctionAsm`/`runBatchCycle`/`structLayout`), diff verifier |

### Not yet (vs. the old pi-harness)

- **Real pi SDK adapter.** `AgentRuntime` currently ships a deterministic
  `MockAgentRuntime`; wiring the real `@earendil-works/pi-coding-agent` sessions
  (and oh-my-pi) is the remaining piece before live model runs.
- **Near-miss draft banking** (`drafts` table exists; no banking module).
- **Silence watchdog** (deferred until the real session adapter lands).
- **Equivalence witness / EQUIVALENT_MATCH** (`witnessEngine` is a stub; the diff
  verifier covers byte-identity only).
- **Snapshot/restore** (pre-session file rollback).
- **targets.json → SQLite migration** (SPEC §6.4) — `targets.json` remains the
  live registry source; the `workflow_status` table is separate.

---

## Concepts

| Term | Meaning |
|---|---|
| **WorkItem** | A unit of work (function/object/label) with a status, size, source, `meta`. |
| **Unit** | A grouping (translation unit) WorkItems belong to. |
| **Workflow** | A typed class (`definePipeline` is the low-level equivalent) with hooks. |
| **Pipeline / Step** | The generic execution substrate: `agent`/`shell`/`verify`/`transform`/`select`/`foreach`/`gate`/`agentLoop`. |
| **Verifier** | A predicate deciding acceptance (diff, behaviour, …). |
| **Selector** | Declarative filter/sort/limit over WorkItems, compiled to SQL. |
| **Adapter** | The per-game integration: registry, diff/witness engines, helpers, lint rules, status vocab. |
| **Claim** | A lease (heartbeat-refreshed) of write-scope ownership. |
| **Status ladder** | A workflow's own progress vocab (e.g. `DOESNT_COMPILE → … → LINTED`) per target/unit. |

---

## Quick start

```bash
npm install            # deps (may need --legacy-peer-deps for tree-sitter)
npm run typecheck
npm test               # 538 hermetic tests (no live game repo required)
npm run build          # tsc + copy schema.sql + diff-engine.py to dist
```

Run the control plane:

```bash
npx tsx src/cli/index.ts serve --port 8787
# or, compiled: node dist/src/cli/index.js serve
```

Open `http://127.0.0.1:8787` (bearer token required — see `decompi.models` /
`auth_tokens`).

---

## Authoring a workflow

```ts
import { Workflow } from "decompi";
import { z } from "zod";

const JudgeOut = z.object({ shouldContinue: z.boolean(), message: z.string() });

export const basicMatch = new Workflow({
  id: "basic-match",
  accepts: "function",          // kind narrowing
  canBatch: true,
  defaultBatchSize: 5,
  rejectionRetries: 1,
  select: { filter: { status: ["NOT_STARTED"] }, sort: [{ by: "size", dir: "asc" }] },
  routes: [
    { when: { sizeBelow: 128 }, model: "nube-ds4-flash-low" },   // rebatch (cheap)
    { model: "nube-ds4-flash-high" },                            // singleton (hard, batch 1)
  ],

  startPrompt: async (targets, ctx) => {
    const asm = await Promise.all(targets.map(t => ctx.helpers.getFunctionAsm(t)));
    return ctx.helpers.render("match", { targets, asm });
  },

  reprompt: async (targets, ctx, lastTurn) => {
    const results = await ctx.helpers.runBatchCycle(targets);
    const judge = await ctx.StartJsonAgent(
      "nube-ds4-flash-low",
      "Is this batch converging?", results, JudgeOut);
    if (!judge.shouldContinue) {
      return { accepted: [], rejected: targets, final: true, feedback: judge.message };
    }
    return {
      accepted: results.filter(r => r.accepted).map(r => r.target),
      rejected: results.filter(r => !r.accepted).map(r => r.target),
      feedback: results.map(r => `# ${r.targetId} — ${r.status}`).join("\n"),
    };
  },
});
```

Key hooks:

- **`setup(targets, ctx)`** — per-batch config (`rejectionRetries`/`batchSize`/`model`) from inputs (size, difficulty, …).
- **`startPrompt` / `reprompt`** — the engine owns the model call between them.
- **`complete(target, ctx)`** — decider for what "done" means; `ctx.finalize` writes it.
- **`ctx.StartJsonAgent(model, prompt, input, schema)`** — a separate, stateless
  LLM **judge** (fresh session, one JSON turn, closed).
- **`ctx.helpers`** — built-in + adapter + workflow helpers, all typed.

Reference examples in [`examples/`](./examples/): `basic-match`, `judge-adaptive-match`,
`tu-final`, `tu-prepass`, `fakematch-detect`.

---

## Workflow status ladder

Each workflow tracks its own progress vocab per target **and** unit:

```ts
new Workflow({
  id: "tu-final",
  statuses: ["DOESNT_COMPILE", "COMPILES", "TEXT_MATCH", "EXACT_MATCH", "LINTED"],
  // doneStatuses defaults to the last entry (LINTED)
});
```

```bash
decompi workflow set tu-final LINTED --unit kyoshin/CGame
decompi workflow status tu-final --unit kyoshin/CGame
```

`plan()` auto-skips targets/units whose status is in `doneStatuses`.

---

## Agent tools

Sessions get **core built-ins** (`select`, `status`, `lint`, `finish`), **adapter
tools** (`hexdiff`, `build`, `size`, `symbols`, `asm`), and **workflow tools**
(`customTools`). The built-in `finish(targetIds)` lets the agent end a batch early.

```ts
new Workflow({
  id: "…",
  customTools: [
    {
      name: "lookup_type",
      description: "look up a struct/class by name",
      inputSchema: z.object({ name: z.string() }),
      run: async (ctx, { name }) => ctx.helpers.structLayout(name),
    },
  ],
});
```

---

## CLI

```
decompi run <workflow> [--model name] [--budget $] [--target id]... [--unit id]...
decompi select '<selector-json>' [--json]
decompi status [--unit U] [--selector …]
decompi diff <unit> [--symbol S] [--all] [--list] [--brief] [--asm] [--no-build] [--json]   # hexdiff alias
decompi lint <paths…> [--delta] [--json]
decompi report [--check] [--json]
decompi export registry|work-items|events|spans   | decompi import <snapshot>
decompi workflow set <wf> <status> --unit U | --target T   | decompi workflow status <wf>
decompi models list | validate
decompi serve [--port P] [--detached]
decompi analyze [--run id]
decompi prune [--retention-days N]
```

(Adapter maintenance commands — `recertify`, `sync`, `scan-source`, `reloc-map`,
`size`, `progress`, `ctx`, `triage` — are declared by the adapter and surfaced
when present.)

---

## Model directory (`models.json`)

```json
{
  "nube-ds4-flash-low": {
    "provider": "nube", "model": "ds4-flash", "thinkingLevel": "low",
    "maxTokens": 0, "rpm": 20,
    "cost": { "inputPerM": 0.5, "outputPerM": 1.5, "cacheReadPerM": 0.1, "cacheWritePerM": 1.5 }
  }
}
```

Cost lives with the model; `rpm` drives the per-model pacer; every run/step/judge
references a model name.

---

## Development

```bash
npm run typecheck        # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm test                 # node --import tsx --test (hermetic — no live game repo)
npm run build            # tsc + copy schema.sql + diff-engine.py
```

The test suite is **game-agnostic**: parser/classifier tests use frozen fixtures;
the diff engine is tested against a fake worker; the Xenoblade adapter's live
diff parity is a **script** (`adapters/xenoblade/diff-engine.py --bench`), not a
test.

## Documents

- `SPEC.md` — the implementation contract (schema, interfaces, milestones).
- `docs/workflow-authoring-spec.md`, `docs/workflow-reprompt-lint-spec.md`,
  `docs/workflow-status-tools-spec.md` — workflow feature specs.
- `docs/reviews/` — the full kimi-k3 + glm-5.2 adversarial review trail.
