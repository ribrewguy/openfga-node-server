/**
 * Kysely-based migration runner. Replaces node-pg-migrate (openfga-g2j).
 *
 * Usage:
 *   pnpm migrate up      # apply all pending migrations
 *   pnpm migrate down    # roll back the most recent migration
 *
 * The migration file source lives under `migrations/*.ts`. The runner
 * uses Kysely's `Migrator` + `FileMigrationProvider` to discover and
 * apply them in lexicographic-by-filename order (the timestamps in
 * the filenames sort correctly as text).
 *
 * Tracking tables — Kysely's Migrator stores applied-migration state
 * in `kysely_migration` and a per-process advisory lock in
 * `kysely_migration_lock`. Both are namespaced by the configured
 * `OPENFGA_DB_NAMESPACE`:
 *
 *   Postgres → `<namespace>.kysely_migration`,
 *              `<namespace>.kysely_migration_lock`
 *   SQLite   → `<namespace>_kysely_migration`,
 *              `<namespace>_kysely_migration_lock`
 *
 * The Postgres path uses `migrationTableSchema`. The SQLite path
 * sets `migrationTableName` directly (no schema concept).
 *
 * The pg_dump migration recipe in the README must include
 * `--exclude-table='<namespace>.kysely_migration*'` since the
 * Migrator tracking tables are not part of the OpenFGA-compatible
 * state contract.
 */
import 'dotenv/config'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileMigrationProvider, Migrator, type MigrationResultSet } from 'kysely'
import { getDb, getDialect, getNamespace, resetDb } from '../storage/db'
import { isPostgres } from '../storage/dialect'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const MIGRATION_FOLDER = path.resolve(__dirname, '../../migrations')

function buildMigrator() {
  const ns = getNamespace()
  const dialect = getDialect()
  const db = getDb()
  const migrationTableName = isPostgres(dialect) ? 'kysely_migration' : `${ns}_kysely_migration`
  const migrationLockTableName = isPostgres(dialect) ? 'kysely_migration_lock' : `${ns}_kysely_migration_lock`
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATION_FOLDER,
    }),
    migrationTableName,
    migrationLockTableName,
    ...(isPostgres(dialect) ? { migrationTableSchema: ns } : {}),
  })
}

function reportResults(direction: 'up' | 'down', { error, results }: MigrationResultSet): boolean {
  let ok = true
  if (results) {
    for (const r of results) {
      if (r.status === 'Success') {
        console.log('[migrate %s] ✓ %s', direction, r.migrationName)
      }
      else if (r.status === 'Error') {
        ok = false
        console.error('[migrate %s] ✗ %s failed', direction, r.migrationName)
      }
      else {
        console.log('[migrate %s] · %s (%s)', direction, r.migrationName, r.status)
      }
    }
  }
  if (error) {
    ok = false
    console.error('[migrate %s] error:', direction, error)
  }
  return ok
}

async function main(): Promise<void> {
  const direction = (process.argv[2] ?? 'up') as 'up' | 'down'
  if (direction !== 'up' && direction !== 'down') {
    console.error('Usage: pnpm migrate <up|down> (got %j)', direction)
    process.exit(2)
  }

  const migrator = buildMigrator()
  const result = direction === 'up'
    ? await migrator.migrateToLatest()
    : await migrator.migrateDown()
  const ok = reportResults(direction, result)
  await resetDb()
  process.exit(ok ? 0 : 1)
}

main().catch(async (err) => {
  console.error('[migrate] uncaught error:', err)
  await resetDb().catch(() => { /* swallow */ })
  process.exit(1)
})
