# Workflow Status Ladder + Agent Tools — Consolidated Review

kimi-k3 + glm-5.2 (high). Verdict: **BLOCKED**.

## CRITICAL
1. **No migration path.** Replacing `workflow_completions` with `workflow_status`
   in `schema.sql` breaks already-shipped DBs (the migration runner applies DDL
   once as v0; no `Migration` v1 to rename/backfill). → add Migration v1
   (rename + backfill `status` from the terminal rung or `"DONE"`, drop-or-keep old table).

## HIGH
2. **Ladder-less workflows lose done-subtraction** (empty `statuses` → empty
   `doneStatuses` → `plan()` subtracts nothing). → default `statuses = ["DONE"]`.
3. **`isDone` OR-formula contradicts "target wins"**; three row forms
   `(wf,U,T)`/`(wf,'',T)`/`(wf,U,'')` have no precedence. → resolve-then-test:
   status = `(wf,U,T)` else `(wf,'',T)` else `(wf,U,'')`; done iff resolved ∈ doneStatuses.
4. **Default status has no delivery path** — engine never calls `complete?`, and
   `doneStatuses[0]` ≠ terminal in general. → thread `completionStatus` (default =
   `statuses.at(-1)`) into finalize; fix the shipped `complete?`-bypass.
5. **`tools` signature collision** — shipped `tools?: string[]` (allowlist) vs
   `Tool[]` (definitions); pi SDK uses `tools: string[]` + `customTools:
   ToolDefinition[]`. → keep `tools` as allowlist; add `customTools?: Tool[]`.
6. **`finish` shadowable** by workflow > adapter > core precedence. → reserve
   `finish` (compile-time error on collision).
7. **`Tool.run(ctx, args: unknown)` is any-adjacent** → zod-typed `Tool<S extends
   z.ZodType>` (args = `z.infer<S>`), consistent with `StartJsonAgent`.

## MEDIUM
8. **Budget/pacing is per `prompt()`**, not per tool call (pi runs the loop inside
   one turn); the adapter must return cumulative usage per turn.
9. **`finish` drain ordering** undefined (verdict vs tool, final turn, stray ids,
   fragments). → drain after every `prompt()` (incl. final); finished ∪= accepted,
   removed from inPlay before checks; unknown ids logged+ignored.
10. **Mock scripted-tool-call hook too thin** → FIFO script of
    `{type:'tool',name,args} | {type:'reply',text}`; `prompt()` consumes to a reply,
    invoking real handlers.
11. **pi SDK `AgentSession.prompt()` returns `Promise<void>`** (result via event
    stream) → note the adapter maps the stream into `AgentResult`.
