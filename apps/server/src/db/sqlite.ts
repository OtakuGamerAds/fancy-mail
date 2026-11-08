/**
 * The one SQLite connection (node:sqlite, synchronous). WAL, foreign keys on, a busy timeout,
 * a cache of prepared statements, and `tx()` for transactions (nested calls use savepoints).
 */
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";

export type SqlValue = SQLInputValue;
export type Row = Record<string, unknown>;

export interface DbOptions {
  /** ":memory:" for tests that do not need a file. */
  path: string;
}

export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  #statements = new Map<string, StatementSync>();
  #depth = 0;
  #savepoint = 0;

  constructor(options: DbOptions) {
    this.path = options.path;
    this.raw = new DatabaseSync(options.path, { enableForeignKeyConstraints: true });
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA temp_store = MEMORY");
    this.raw.exec("PRAGMA cache_size = -32000");
  }

  /** A prepared statement, reused for the same SQL text. */
  prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      if (this.#statements.size > 500) this.#statements.clear();
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  /** The first column of the first row. */
  value<T = unknown>(sql: string, ...params: SqlValue[]): T | undefined {
    const row = this.prepare(sql).get(...params) as Row | undefined;
    if (!row) return undefined;
    for (const key in row) return row[key] as T;
    return undefined;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  /** Runs `fn` in a transaction (BEGIN IMMEDIATE), or a savepoint when already inside one. */
  tx<T>(fn: () => T): T {
    if (this.#depth === 0) {
      this.raw.exec("BEGIN IMMEDIATE");
      this.#depth++;
      try {
        const result = fn();
        this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
        throw error;
      } finally {
        this.#depth--;
      }
    }
    const name = `sp${++this.#savepoint}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.#depth++;
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.#depth--;
    }
  }

  close(): void {
    this.#statements.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

export function openDb(path: string): Db {
  return new Db({ path });
}

/** `?, ?, ?` for an IN list. */
export function placeholders(count: number): string {
  return count <= 0 ? "" : new Array(count).fill("?").join(", ");
}

/** Runs `fn` over `items` in slices small enough for SQLite's variable limit. */
export function chunked<T, R>(items: readonly T[], size: number, fn: (slice: T[]) => R[]): R[] {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...fn(items.slice(i, i + size)));
  return out;
}

export function bool(value: boolean): number {
  return value ? 1 : 0;
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
