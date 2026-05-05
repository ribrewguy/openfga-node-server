/**
 * Shared Kysely Migrator factory.
 *
 * Centralizes the namespacing rules so the CLI (`pnpm migrate`), the
 * self-host boot gate (`OPENFGA_MIGRATE_ON_START`), and the
 * SQLite-backed unit-test bootstrap all build the Migrator the same
 * way. Drift between these three was a real risk before extraction —
 * the previous duplicates between `src/cli/migrate.ts` and
 * `tests/_helpers/sqlite-bootstrap.ts` would have silently masked any
 * future change to the namespace-of-tracking-tables contract.
 */
import { Migrator } from 'kysely'
import { StaticMigrationProvider } from '../cli/migrations-bundle'
import { getDb, getDialect, getNamespace } from './db'
import { isPostgres } from './dialect'

/**
 * Build a Migrator wired against the configured DB and namespace.
 *
 * Tracking tables follow the same dialect rules as the rest of the
 * schema:
 *   Postgres → `<ns>.kysely_migration[_lock]` via `migrationTableSchema`
 *   SQLite   → `<ns>_kysely_migration[_lock]` (table-name prefix)
 */
export function buildMigrator(): Migrator {
  const ns = getNamespace()
  const dialect = getDialect()
  return new Migrator({
    db: getDb(),
    provider: new StaticMigrationProvider(),
    migrationTableName: isPostgres(dialect) ? 'kysely_migration' : `${ns}_kysely_migration`,
    migrationLockTableName: isPostgres(dialect) ? 'kysely_migration_lock' : `${ns}_kysely_migration_lock`,
    ...(isPostgres(dialect) ? { migrationTableSchema: ns } : {}),
  })
}

/**
 * Apply all pending migrations and throw on any failure. Silent on
 * success — callers that need per-migration reporting (the CLI) drive
 * the Migrator themselves and read the structured `MigrationResultSet`.
 */
export async function runMigrationsToLatest(): Promise<void> {
  const migrator = buildMigrator()
  const { error } = await migrator.migrateToLatest()
  if (error) throw error instanceof Error ? error : new Error(String(error))
}
