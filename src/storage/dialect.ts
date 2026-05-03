/**
 * Per-dialect helpers used by the storage layer to keep
 * engine-specific SQL fragments out of the repository modules.
 *
 * Currently exposed:
 *   - `getDialect()`   — returns 'postgres' | 'sqlite' based on the
 *                        configured `OPENFGA_DB_URL`.
 *   - `dialectNowMinus(ms)` — Kysely RawBuilder rendering an
 *                        engine-correct "now() minus N milliseconds"
 *                        timestamp literal. Idempotency uses this for
 *                        its TTL cutoff so the cutoff shares the
 *                        clock that wrote the row (openfga-how).
 */
import { sql, type RawBuilder } from 'kysely'

export type DialectName = 'postgres' | 'sqlite'

const POSTGRES_PREFIXES = ['postgres://', 'postgresql://']
const SQLITE_PREFIXES = ['sqlite:', 'file:']
const SQLITE_MEMORY = ':memory:'

/**
 * Infer the dialect from a connection string. Throws on unsupported
 * schemes so a misconfigured URL fails fast at boot, not at first
 * query.
 */
export function dialectFromUrl(url: string): DialectName {
  if (POSTGRES_PREFIXES.some(p => url.startsWith(p))) return 'postgres'
  if (url === SQLITE_MEMORY) return 'sqlite'
  if (SQLITE_PREFIXES.some(p => url.startsWith(p))) return 'sqlite'
  throw new Error(
    `[openfga] OPENFGA_DB_URL must start with postgres://, postgresql://, sqlite:, file:, or be ":memory:"; got "${url}"`,
  )
}

/**
 * Extract the SQLite database path from a `sqlite:` / `file:` /
 * `:memory:` connection string. Returns the literal `:memory:` for
 * the in-memory cases.
 */
export function sqlitePathFromUrl(url: string): string {
  if (url === SQLITE_MEMORY) return SQLITE_MEMORY
  for (const prefix of SQLITE_PREFIXES) {
    if (url.startsWith(prefix)) {
      const rest = url.slice(prefix.length)
      // `sqlite::memory:` → `:memory:` after slicing the prefix.
      return rest === '' ? SQLITE_MEMORY : rest
    }
  }
  throw new Error(`[openfga] not a SQLite connection string: "${url}"`)
}

/**
 * Render `now() - <ms> milliseconds` as a SQL fragment. The shape
 * differs per engine; both produce a timestamp at exactly `ms`
 * milliseconds before the database's `now()`.
 *
 *   Postgres: `now() - $1::int * interval '1 millisecond'`
 *   SQLite:   `STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || $1 || ' milliseconds')`
 *
 * The cutoff is computed in SQL so it shares the database's clock —
 * a JS-computed `Date.now() - ms` against a Postgres-assigned
 * `created_at` is a clock-skew race (see openfga-how).
 */
export function dialectNowMinus(dialect: DialectName, ms: number): RawBuilder<string> {
  if (dialect === 'postgres') {
    return sql<string>`now() - ${sql.lit(ms)}::int * interval '1 millisecond'`
  }
  return sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${sql.lit(`-${ms} milliseconds`)})`
}
