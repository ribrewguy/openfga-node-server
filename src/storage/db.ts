/**
 * Engine-agnostic Kysely entry point for the storage layer.
 *
 * The dialect is inferred from the `OPENFGA_DB_URL` scheme:
 *
 *   postgres://… | postgresql://…  →  PostgresDialect (pg.Pool)
 *   sqlite:…  | file:…  | :memory: →  SqliteDialect (better-sqlite3)
 *
 * No `OPENFGA_DB_DRIVER` env var: a single source of truth avoids the
 * mismatched-scheme-and-driver bug class.
 *
 * Namespace handling — every table this server owns lives under the
 * value of `OPENFGA_DB_NAMESPACE` (default `openfga`):
 *
 *   Postgres → schema-qualified via Kysely's `withSchema(ns)` so
 *              SQL emits `<ns>.store`, `<ns>.tuple`, etc.
 *   SQLite   → table-prefixed via `TablePrefixPlugin(`${ns}_`)` so
 *              SQL emits `<ns>_store`, `<ns>_tuple`, etc.
 *
 * The Database type uses logical (unqualified) table names so
 * application code stays engine-neutral.
 *
 * `pool.ts` (the legacy `pg.Pool` getter) was deleted under
 * openfga-19w once every storage module migrated through getDb().
 * The pg type-parser setup and `intFromEnv` helper now live in
 * `src/storage/pg-internals.ts` as the single source of truth.
 */
import { Kysely, ParseJSONResultsPlugin, PostgresDialect, SqliteDialect } from 'kysely'
import { Pool } from 'pg'
import type { PoolConfig } from 'pg'
import Sqlite from 'better-sqlite3'
import { logger } from '../logger'
import type { Database } from './db-schema'
import { dialectFromUrl, sqlitePathFromUrl, type DialectName } from './dialect'
import { TablePrefixPlugin } from './table-prefix-plugin'
// Side effect: registers pg type-parser overrides for OIDs 1184/1114
// so timestamptz/timestamp return as text (preserves microsecond
// precision — see openfga-5uv). The helper `intFromEnv` is shared
// with pool.ts.
import { intFromEnv } from './pg-internals'

const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const DEFAULT_NAMESPACE = 'openfga'

let _namespace: string | null = null
let _db: Kysely<Database> | null = null
let _dialect: DialectName | null = null

/**
 * Read and validate the table namespace. Cached for the process
 * lifetime so the validation cost is paid once. Reset by `resetDb()`
 * for tests that want to swap the value.
 *
 * Validation: identifier must match `/^[a-z][a-z0-9_]{0,62}$/` so it
 * is a safe SQL identifier in both Postgres and SQLite without
 * requiring quoting. Postgres `NAMEDATALEN` is 63 by default.
 */
export function getNamespace(): string {
  if (_namespace !== null) return _namespace
  const raw = process.env['OPENFGA_DB_NAMESPACE'] ?? DEFAULT_NAMESPACE
  if (!NAMESPACE_PATTERN.test(raw)) {
    throw new Error(
      `[openfga] OPENFGA_DB_NAMESPACE must match /^[a-z][a-z0-9_]{0,62}$/ (lowercase letter, then up to 62 chars of [a-z0-9_]); got "${raw}"`,
    )
  }
  _namespace = raw
  return raw
}

/** Read the dialect inferred from `OPENFGA_DB_URL`. Cached. */
export function getDialect(): DialectName {
  if (_dialect !== null) return _dialect
  const url = process.env['OPENFGA_DB_URL']
  if (!url) {
    throw new Error(
      '[openfga] OPENFGA_DB_URL is not set. Configure it to point at the database backing the openfga state (see .env.example).',
    )
  }
  _dialect = dialectFromUrl(url)
  return _dialect
}

function buildPgPool(): Pool {
  const connectionString = process.env['OPENFGA_DB_URL']!
  const config: PoolConfig = {
    connectionString,
    application_name: process.env['OPENFGA_DB_APPLICATION_NAME'] ?? 'openfga-node-server',
    max: intFromEnv('OPENFGA_DB_POOL_MAX', 10),
    min: intFromEnv('OPENFGA_DB_POOL_MIN', 0),
    idleTimeoutMillis: intFromEnv('OPENFGA_DB_POOL_IDLE_TIMEOUT_MS', 30_000),
  }
  const connectionTimeout = intFromEnv('OPENFGA_DB_POOL_CONNECTION_TIMEOUT_MS', 0)
  if (connectionTimeout > 0) config.connectionTimeoutMillis = connectionTimeout
  const statementTimeout = intFromEnv('OPENFGA_DB_STATEMENT_TIMEOUT_MS', 0)
  if (statementTimeout > 0) config.statement_timeout = statementTimeout
  const queryTimeout = intFromEnv('OPENFGA_DB_QUERY_TIMEOUT_MS', 0)
  if (queryTimeout > 0) config.query_timeout = queryTimeout
  const pool = new Pool(config)
  pool.on('error', (err) => {
    logger.error({ err }, 'pg pool error (kysely)')
  })
  return pool
}

function buildSqlite(): Sqlite.Database {
  const url = process.env['OPENFGA_DB_URL']!
  const path = sqlitePathFromUrl(url)
  const db = new Sqlite(path)
  // WAL mode is the right default for any non-:memory: path — better
  // concurrent-read characteristics and crash safety. Skip for
  // :memory: where WAL is meaningless.
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  // Foreign-key enforcement is OFF by default in SQLite for backward
  // compat — we want it ON to mirror the Postgres `REFERENCES`
  // semantics in our migrations.
  db.pragma('foreign_keys = ON')
  return db
}

/**
 * Returns the singleton `Kysely<Database>` instance. The first call
 * constructs the underlying driver (pg.Pool or better-sqlite3
 * Database) and applies the namespace via the engine-appropriate
 * mechanism.
 */
export function getDb(): Kysely<Database> {
  if (_db) return _db
  const dialect = getDialect()
  const namespace = getNamespace()

  if (dialect === 'postgres') {
    const base = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: buildPgPool() }),
    })
    // Schema-scope the entire instance so logical queries against
    // `'store'` compile to `<namespace>.store`.
    _db = base.withSchema(namespace)
    logger.debug({ dialect, namespace }, 'kysely db initialized (postgres)')
    return _db
  }

  _db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: buildSqlite() }),
    plugins: [
      new TablePrefixPlugin(`${namespace}_`),
      // jsonb columns auto-parse on Postgres, but better-sqlite3
      // returns JSON columns as raw text — opt into Kysely's parser
      // so result rows are shape-equivalent across engines.
      new ParseJSONResultsPlugin(),
    ],
  })
  logger.debug({ dialect, namespace }, 'kysely db initialized (sqlite)')
  return _db
}

/**
 * Test-only: tear down the singleton so tests can swap configurations.
 * Awaits `Kysely.destroy()` so the underlying driver releases its
 * resources (pg.Pool drains, better-sqlite3.Database closes) before
 * the next `getDb()` builds a new instance.
 */
export async function resetDb(): Promise<void> {
  const previous = _db
  _db = null
  _dialect = null
  _namespace = null
  if (previous) await previous.destroy()
}
