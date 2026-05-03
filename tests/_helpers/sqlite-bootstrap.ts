/**
 * Shared test helper that runs the Kysely Migrator against the
 * configured `getDb()` Kysely instance — used by storage-layer unit
 * tests to bring the in-memory SQLite up to the same schema the
 * production CLI applies.
 *
 * vitest.config.ts sets `OPENFGA_DB_URL=:memory:` for the unit
 * project, so callers don't need to set it themselves. Tests that
 * need to swap the URL save and restore the env in their own
 * beforeEach/afterEach (see storage-db.test.ts).
 *
 * The Migrator's tracking tables are namespaced exactly as the
 * production CLI namespaces them (kysely_migration[_lock] under the
 * configured OPENFGA_DB_NAMESPACE) — matches what
 * `migrator.migrateToLatest()` produces in `pnpm migrate up`.
 */
import { Migrator } from 'kysely'
import { getDb, getDialect, getNamespace } from '../../src/storage/db'
import { isPostgres } from '../../src/storage/dialect'
import { StaticMigrationProvider } from '../../src/cli/migrations-bundle'

export async function migrateToLatest(): Promise<void> {
  const ns = getNamespace()
  const dialect = getDialect()
  const migrator = new Migrator({
    db: getDb(),
    provider: new StaticMigrationProvider(),
    migrationTableName: isPostgres(dialect) ? 'kysely_migration' : `${ns}_kysely_migration`,
    migrationLockTableName: isPostgres(dialect) ? 'kysely_migration_lock' : `${ns}_kysely_migration_lock`,
    ...(isPostgres(dialect) ? { migrationTableSchema: ns } : {}),
  })
  const { error } = await migrator.migrateToLatest()
  if (error) throw error
}
