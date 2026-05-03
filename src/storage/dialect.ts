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
 *   Postgres: `now() - $N::int * interval '1 millisecond'`  (param: ms)
 *   SQLite:   `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', $N)`   (param: '-<ms> milliseconds')
 *
 * The cutoff is computed in SQL so it shares the database's clock —
 * a JS-computed `Date.now() - ms` against a Postgres-assigned
 * `created_at` is a clock-skew race (see openfga-how). The `ms`
 * value is passed as a Kysely parameter (no `sql.lit`) so callers
 * with different TTLs share a prepared-statement cache slot, matching
 * the original idempotency.ts behavior that this helper replaces.
 */
export function dialectNowMinus(dialect: DialectName, ms: number): RawBuilder<string> {
  if (dialect === 'postgres') {
    return sql<string>`now() - ${ms}::int * interval '1 millisecond'`
  }
  return sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${ms} milliseconds`})`
}

/**
 * Render a timestamp string parameter with a Postgres `::timestamptz`
 * cast when targeting Postgres, or as a bare parameter on SQLite. Used
 * inside row-tuple cursor comparisons like
 * `(created_at, id) < (${dialectTimestampParam(d, c.created_at)}, ${c.id})`
 * so the row-tuple parameter type is unambiguous on Postgres while
 * SQLite's lexicographic text comparison works without the cast.
 *
 * Centralized so subsequent storage-module ports (tuples,
 * tuple_change) reuse the same dialect-branching logic instead of
 * each duplicating the inline branch.
 */
export function dialectTimestampParam(dialect: DialectName, value: string): RawBuilder<string> {
  if (dialect === 'postgres') {
    return sql<string>`${value}::timestamptz`
  }
  return sql<string>`${value}`
}
