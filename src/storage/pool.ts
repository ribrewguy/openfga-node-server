/**
 * Pinned `pg.Pool` for the storage layer.
 *
 * The connection string comes from `OPENFGA_DB_URL`. The pool is a
 * process-lifetime singleton so route handlers and the model loader
 * CLI share connections. Tests can `resetPool()` to swap DSNs between
 * cases.
 */
import { Pool } from 'pg'
import type { PoolConfig } from 'pg'

let _pool: Pool | null = null

function buildConfig(): PoolConfig {
  const connectionString = process.env['OPENFGA_DB_URL']
  if (!connectionString) {
    throw new Error(
      '[openfga] OPENFGA_DB_URL is not set. Configure it to point at the Postgres instance hosting the openfga schema (see .env.example).',
    )
  }
  return {
    connectionString,
    // Conservative defaults — authz traffic is one tuple write per
    // relationship change plus check/list-objects on each request.
    max: 10,
    idleTimeoutMillis: 30_000,
  }
}

export function getPool(): Pool {
  if (_pool) return _pool
  _pool = new Pool(buildConfig())
  _pool.on('error', (err) => {
    console.error('[openfga] pg pool error', err)
  })
  return _pool
}

/** Test-only: reset the singleton so tests can swap connection strings. */
export function resetPool(): void {
  _pool?.end().catch(() => { /* swallow */ })
  _pool = null
}
