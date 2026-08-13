/**
 * Portable store interface (SPEC §6.1).
 *
 * The store is written against `SqlAdapter`, never against engine specifics:
 * `?` placeholders everywhere, ISO-8601 TEXT timestamps, ULID string ids
 * generated in-app (no AUTOINCREMENT/SERIAL), and no JSON operators for
 * queryable fields (real columns only). SQLite is the v1 engine
 * (`src/core/store/sqlite.ts`); Postgres is a later drop-in behind this
 * same interface.
 */

export interface Migration {
  version: number;
  up(sql: SqlAdapter): Promise<void>;
}

export interface SqlAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T>;
  /** Insert, returning false on a unique/PK violation (portable CAS claim). */
  insertIgnore(sql: string, params?: unknown[]): Promise<boolean>;
  /** Classify a thrown error as a unique-violation (SQLite vs Postgres differ). */
  isUniqueViolation(err: unknown): boolean;
  migrate(migrations: Migration[]): Promise<void>;
}
