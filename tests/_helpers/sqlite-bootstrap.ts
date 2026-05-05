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
 * The Migrator setup is now centralized in `src/storage/migrator.ts`
 * and shared with `pnpm migrate` and the OPENFGA_MIGRATE_ON_START
 * boot path so test schema and production schema cannot drift.
 */
import { runMigrationsToLatest } from '../../src/storage/migrator'

export async function migrateToLatest(): Promise<void> {
  await runMigrationsToLatest()
}
