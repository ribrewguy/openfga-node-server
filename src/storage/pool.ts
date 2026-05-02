/**
 * Pinned `pg.Pool` for the storage layer.
 *
 * The connection string comes from `OPENFGA_DB_URL`. Pool sizing and
 * timeout knobs are env-overrideable — see .env.example for the full
 * list. The pool is a process-lifetime singleton so route handlers and
 * the model loader CLI share connections. Tests can `resetPool()` to
 * swap DSNs between cases.
 */
import { Pool, types as pgTypes } from 'pg'
import type { PoolConfig } from 'pg'
import { logger } from '../logger'

// Return timestamptz (OID 1184) and timestamp (OID 1114) as raw text
// from Postgres rather than the default JS Date conversion. Date has
// only millisecond precision, but Postgres timestamps carry
// microseconds; the truncation breaks cursor pagination on tables
// where multiple rows can share the same wall-clock millisecond
// (e.g. tuples written in a single transaction). The text form
// preserves full precision and round-trips losslessly through the
// `<col>::timestamptz` cast on the return path. See openfga-5uv.
const PG_OID_TIMESTAMPTZ = 1184
const PG_OID_TIMESTAMP = 1114
pgTypes.setTypeParser(PG_OID_TIMESTAMPTZ, (value) => value)
pgTypes.setTypeParser(PG_OID_TIMESTAMP, (value) => value)

let _pool: Pool | null = null

function intFromEnv(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[openfga] ${key} must be a non-negative integer; got "${v}"`)
  }
  return n
}

function buildConfig(): PoolConfig {
  const connectionString = process.env['OPENFGA_DB_URL']
  if (!connectionString) {
    throw new Error(
      '[openfga] OPENFGA_DB_URL is not set. Configure it to point at the Postgres instance hosting the openfga schema (see .env.example).',
    )
  }

  // Conservative defaults — authz traffic is one tuple write per
  // relationship change plus check/list-objects on each request.
  const config: PoolConfig = {
    connectionString,
    application_name: process.env['OPENFGA_DB_APPLICATION_NAME'] ?? 'openfga-node-server',
    max: intFromEnv('OPENFGA_DB_POOL_MAX', 10),
    min: intFromEnv('OPENFGA_DB_POOL_MIN', 0),
    idleTimeoutMillis: intFromEnv('OPENFGA_DB_POOL_IDLE_TIMEOUT_MS', 30_000),
  }

  // Timeouts — only set when explicitly enabled (>0). Postgres treats 0
  // as "no timeout" but pg's defaults differ by field, so we omit
  // unless the operator opts in.
  const connectionTimeout = intFromEnv('OPENFGA_DB_POOL_CONNECTION_TIMEOUT_MS', 0)
  if (connectionTimeout > 0) config.connectionTimeoutMillis = connectionTimeout

  const statementTimeout = intFromEnv('OPENFGA_DB_STATEMENT_TIMEOUT_MS', 0)
  if (statementTimeout > 0) config.statement_timeout = statementTimeout

  const queryTimeout = intFromEnv('OPENFGA_DB_QUERY_TIMEOUT_MS', 0)
  if (queryTimeout > 0) config.query_timeout = queryTimeout

  return config
}

export function getPool(): Pool {
  if (_pool) return _pool
  const config = buildConfig()
  _pool = new Pool(config)
  _pool.on('error', (err) => {
    logger.error({ err }, 'pg pool error')
  })
  logger.debug(
    {
      max: config.max,
      min: config.min,
      idleTimeoutMillis: config.idleTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      statement_timeout: config.statement_timeout,
      query_timeout: config.query_timeout,
      application_name: config.application_name,
    },
    'pg pool initialized',
  )
  return _pool
}

/** Test-only: reset the singleton so tests can swap connection strings. */
export function resetPool(): void {
  _pool?.end().catch(() => { /* swallow */ })
  _pool = null
}
