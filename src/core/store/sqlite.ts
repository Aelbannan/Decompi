/**
 * SQLite engine for the portable store (SPEC §6.1), v1.
 *
 * Implements `SqlAdapter` over the built-in `node:sqlite` `DatabaseSync`
 * (synchronous API wrapped in the async `SqlAdapter` surface). No
 * better-sqlite3 dependency.
 *
 * Portability notes:
 * - `execute` without params runs single statements through a prepared
 *   statement (so DML reports a real `changes` count); multi-statement SQL
 *   (the canonical `schema.sql`) is detected and routed through `exec()` —
 *   `node:sqlite`'s `prepare()` silently drops every statement after the
 *   first, so it must never be used for multi-statement input.
 * - `insertIgnore` runs a plain `INSERT` and maps a unique/PK conflict to
 *   `false` (portable CAS claim): the engine throws, `isUniqueViolation`
 *   classifies, and any other error is rethrown.
 * - `isUniqueViolation` recognises SQLite's extended error codes
 *   SQLITE_CONSTRAINT_UNIQUE (2067) and SQLITE_CONSTRAINT_PRIMARYKEY (1555),
 *   falling back to the message text.
 *
 * Transactions:
 * - A call to `transaction()` on the adapter itself is *outermost*: it opens
 *   with `BEGIN`, commits with `COMMIT`, and rolls back with `ROLLBACK`.
 * - Overlapping (concurrent) outermost calls are **serialized** on a queue:
 *   each waits for the previous one to finish before beginning. A caller's
 *   committed work can therefore never be wiped by another caller's
 *   rollback (SQLite has exactly one transaction per connection, so true
 *   parallel isolation is impossible — serialization is the guarantee).
 * - Calls to `transaction()` on the `tx` handle passed into a callback are
 *   *nested* and use SQLite SAVEPOINTs: `SAVEPOINT sp_N` on entry, `RELEASE
 *   sp_N` on success, `ROLLBACK TO sp_N` + `RELEASE sp_N` on failure, so an
 *   inner rollback only undoes the inner region and never the outer work.
 */
import { DatabaseSync } from "node:sqlite";
import type { Migration, SqlAdapter } from "./adapter.js";
import { runMigrations } from "./migrations.js";

/** Values `node:sqlite` accepts as bound parameters. */
type SqliteParam = null | number | bigint | string | NodeJS.ArrayBufferView;

/** SQLite extended result codes. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

function toParams(params?: unknown[]): SqliteParam[] {
  return (params ?? []) as SqliteParam[];
}

/**
 * True when `sql` contains more than one statement (a `;` terminator followed
 * by further non-whitespace SQL, ignoring quoted strings and comments).
 * `node:sqlite`'s `prepare()` silently executes only the first statement of
 * multi-statement input, so such SQL must go through `exec()`.
 */
function hasMultipleStatements(sql: string): boolean {
  let i = 0;
  let quote: string | null = null;
  let seenTerminator = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          i += 2; // escaped quote ('' / "") stays inside the string
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++; // line comment
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i + 1 < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === ";") {
      seenTerminator = true;
      i++;
      continue;
    }
    if (seenTerminator && !/\s/.test(ch)) return true;
    i++;
  }
  return false;
}

/**
 * Handle passed to a transaction callback. Every method delegates to the
 * owning adapter except `transaction()`, which nests via a SAVEPOINT — this
 * is what lets inner transactions roll back without touching outer work.
 */
class TxHandle implements SqlAdapter {
  constructor(private readonly owner: SqliteAdapter) {}

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.owner.query(sql, params);
  }

  async execute(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.owner.execute(sql, params);
  }

  async transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
    return this.owner.nestedTransaction(fn);
  }

  async insertIgnore(sql: string, params?: unknown[]): Promise<boolean> {
    return this.owner.insertIgnore(sql, params);
  }

  isUniqueViolation(err: unknown): boolean {
    return this.owner.isUniqueViolation(err);
  }

  migrate(migrations: Migration[]): Promise<void> {
    return this.owner.migrate(migrations);
  }

  close(): void {
    this.owner.close();
  }
}

export class SqliteAdapter implements SqlAdapter {
  private readonly db: DatabaseSync;

  /** Handle passed to transaction callbacks; its `transaction()` nests via SAVEPOINT. */
  private readonly txHandle = new TxHandle(this);

  /** SAVEPOINT depth of the in-flight transaction (0 = none active). */
  private txDepth = 0;

  /** Tail of the serialization chain for concurrent outermost transactions. */
  private txTail: Promise<void> = Promise.resolve();

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      // Cross-process writers (SPEC §6.3 lease CAS races across daemon
      // processes): WAL lets a second writer block instead of failing, and
      // `busy_timeout` makes it wait up to 5s for the lock — without them a
      // concurrent claim throws SQLITE_BUSY instead of returning false. The
      // second writer then hits the PK conflict and `insertIgnore` reports
      // false (the portable CAS contract). Skipped for `:memory:` databases,
      // which cannot have cross-process contention.
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA busy_timeout=5000");
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...toParams(params));
    return rows as unknown as T[];
  }

  async execute(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    if (params !== undefined && params.length > 0) {
      const result = this.db.prepare(sql).run(...toParams(params));
      return { changes: Number(result.changes) };
    }
    if (hasMultipleStatements(sql)) {
      // Multi-statement DDL (the canonical schema.sql): `prepare()` would
      // silently drop every statement after the first, so use `exec()`.
      this.db.exec(sql);
      return { changes: 0 };
    }
    // Param-less single statement: prepared run so DML reports real changes.
    const result = this.db.prepare(sql).run();
    return { changes: Number(result.changes) };
  }

  /**
   * Run `fn` inside a transaction.
   *
   * Concurrent calls (another transaction already in flight on this adapter)
   * are serialized: each starts only after the previous one has finished, so
   * one caller's `COMMIT` is never wiped by another caller's `ROLLBACK`.
   * Call `transaction()` on the `tx` handle instead to nest — nested
   * transactions use SAVEPOINTs and are NOT serialized (they must run inside
   * the enclosing one).
   */
  async transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
    const run = this.txTail.then(() => this.runOuterTransaction(fn));
    // Keep the chain alive even when this transaction rejects.
    this.txTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Outermost transaction: BEGIN / COMMIT / ROLLBACK. Runs only after any
   * previously queued transaction has finished (serialization). */
  private async runOuterTransaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    this.txDepth = 1;
    let committed = false;
    try {
      const result = await fn(this.txHandle);
      this.db.exec("COMMIT");
      committed = true;
      return result;
    } catch (err) {
      if (!committed) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Database already closed/rolled back; preserve the original error.
        }
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  /**
   * Nested transaction: `SAVEPOINT sp_N` on entry, `RELEASE sp_N` on success,
   * `ROLLBACK TO sp_N` + `RELEASE sp_N` on failure. Only reachable through
   * the `tx` handle passed to an enclosing transaction callback; if called
   * outside one, it degrades to an outermost transaction.
   */
  async nestedTransaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
    if (this.txDepth === 0) {
      // Handle used outside an enclosing transaction: treat as outermost.
      return this.transaction(fn);
    }
    const name = `sp_${this.txDepth}`;
    this.db.exec(`SAVEPOINT ${name}`);
    this.txDepth += 1;
    try {
      const result = await fn(this.txHandle);
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
      } catch {
        // Database already closed/rolled back; preserve the original error.
      }
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  async insertIgnore(sql: string, params?: unknown[]): Promise<boolean> {
    try {
      const result = this.db.prepare(sql).run(...toParams(params));
      return Number(result.changes) > 0;
    } catch (err) {
      // Portable CAS claim (SPEC §6.1): a unique/PK conflict is a false, not a throw.
      if (this.isUniqueViolation(err)) return false;
      throw err;
    }
  }

  isUniqueViolation(err: unknown): boolean {
    if (err instanceof Error) {
      const sqliteError = err as Error & { code?: string; errcode?: number; errstr?: string };
      if (
        sqliteError.code === "ERR_SQLITE_ERROR" &&
        (sqliteError.errcode === SQLITE_CONSTRAINT_UNIQUE ||
          sqliteError.errcode === SQLITE_CONSTRAINT_PRIMARYKEY)
      ) {
        return true;
      }
      return /(UNIQUE constraint failed|PRIMARY KEY constraint failed)/i.test(err.message);
    }
    return false;
  }

  migrate(migrations: Migration[]): Promise<void> {
    return runMigrations(this, migrations);
  }

  close(): void {
    this.db.close();
  }
}
