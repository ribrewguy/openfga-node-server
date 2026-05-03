/**
 * Shared internals between `pool.ts` (legacy `pg.Pool` getter) and
 * `db.ts` (Kysely entry point). Both import this module so the pg
 * type-parser overrides for openfga-5uv run from a single source of
 * truth, and so the `intFromEnv` helper isn't duplicated.
 *
 * The setTypeParser calls run as a top-level side effect at module
 * load time. They're idempotent at the pg layer (later calls overwrite
 * the same global parser slot with the same function), so any number
 * of imports is safe.
 *
 * When `pool.ts` is removed at the end of the openfga-8ri epic, this
 * module is folded into `db.ts`.
 */
import { types as pgTypes } from 'pg'

// Preserve openfga-5uv: return timestamptz/timestamp as raw text from
// Postgres rather than the default JS Date conversion. Date truncates
// to milliseconds, and that breaks cursor pagination on tables where
// multiple rows share a wall-clock millisecond.
const PG_OID_TIMESTAMPTZ = 1184
const PG_OID_TIMESTAMP = 1114
pgTypes.setTypeParser(PG_OID_TIMESTAMPTZ, value => value)
pgTypes.setTypeParser(PG_OID_TIMESTAMP, value => value)

/**
 * Parse a non-negative integer from an env var, falling back to a
 * default when unset/empty. Throws on a present-but-invalid value so a
 * misconfiguration fails fast at boot.
 */
export function intFromEnv(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[openfga] ${key} must be a non-negative integer; got "${v}"`)
  }
  return n
}
