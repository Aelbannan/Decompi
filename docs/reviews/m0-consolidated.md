# M0 — Consolidated Review

kimi-k3: **M0 BLOCKED** · glm-5.2: **M0 SHIP** (disagree on gate; agree on the
same findings).

## Converged blockers (fix before M2 / fix now)

1. **[CRITICAL] Transaction join race** — `SqliteAdapter.transaction` uses a
   shared in-transaction flag; a second concurrent `transaction()` call joins the
   first's BEGIN, and if the first rolls back, the second's *resolved-successfully*
   work is silently lost (PROBE1 confirmed: T2 "committed", T1 rollback wiped it).
   Nested rollback also has no savepoint isolation. → Use SAVEPOINTs for nesting;
   ensure concurrent calls can't silently share+rollback.
2. **[HIGH] `parseSelector` shape validation missing** — `{filter:{status:"FULL_MATCH"}}`
   (string) reaches `inClause` → `values.map` → raw crash; negative/NaN/zero
   `limit` → SQLite treats negative LIMIT as unlimited; invalid meta `op` silently
   filters everything out. → Validate shapes and throw clear errors.
3. **[MEDIUM] Packaging broken** — `bin` points to `.ts`; `tsc` build crashes on
   `schema.sql` ENOENT (not copied to dist); no `engines` field. → proper build
   (copy schema.sql), `engines >=22.5`, robust schema.sql resolution.

## Converged MEDIUM/LOW (fix cheap now)

4. **[MEDIUM] Pagination non-determinism** — OFFSET paging without a unique
   `ORDER BY` tiebreaker can drop/dup rows. → append `id` tiebreaker.
5. **[MEDIUM] `importWorkItems` not transactional** — partial import on failure.
   → wrap in one transaction.
6. **[MEDIUM] `execute()` with empty params returns `{changes:0}`** (routes to
   `exec`). → use prepared run for DML.
7. **[LOW] `WorkItemRepo.update` allows patching `id`** (PK). → reject id.
8. **[LOW] Fixture `DEFAULTS.meta` shared reference** across items. → clone per item.
9. **[LOW] Double `migrate([])`** in CLI path. → call once.
10. **[LOW] migrations `schemaWithoutTrackingTable()` `startsWith` brittleness.**
11. **[LOW] CSV not supported** (spec says JSON/CSV) — accept JSON-only as M0
    deviation or add trivial CSV.
12. **[LOW/NIT] `regex` meta op ReDoS** — self-DoS in CLI; revisit before M4 API.

## Sound (both)

types.ts + adapter.ts spec-exact (post-clobber verified) · schema.sql verbatim ·
selector SQL value-binding (no injection via values) · repo snake_case↔camelCase ·
migrations happy path · CLI arg parsing · test coverage adequate for M0 scope.
