/**
 * Dialect-agnostic bootstrap helper for the integration test suite.
 *
 * Replaces the per-spec `probeDb()` + `dbAvailable` + `describeIfDb`
 * pattern that gated every integration test on a reachable Postgres
 * `OPENFGA_DB_URL`. Two integration vitest projects share this helper:
 *
 * - `integration` (default) — runs against SQLite, configured by
 *   `vitest.config.ts` to set `OPENFGA_DB_URL=:memory:`. The bootstrap
 *   runs migrations to build the schema fresh in memory and is always
 *   `ready` (a SQLite-side failure surfaces as a real setup error, not
 *   a silent skip — SQLite is the PRD-supported test backend per
 *   docs/PRD.md:116 so failure to bootstrap means the test infra is
 *   broken).
 *
 * - `integration-pg` — runs the same specs against Postgres, configured
 *   by CI with `OPENFGA_DB_URL=postgres://…`. The bootstrap probes pg
 *   reachability via the abstracted `getDb()` instance (no direct
 *   `pg.Pool` import here) and returns `ready: false` if pg is
 *   unreachable, matching the silent-skip pattern that local dev
 *   without Postgres expects.
 *
 * Specs use the helper at module load via top-level await so the right
 * `describe` (real or `.skip`) is registered before vitest collects:
 *
 *   const bootstrap = await bootstrapIntegrationDb()
 *   afterAll(() => bootstrap.teardown())
 *   const describeIf = bootstrap.ready ? describe : describe.skip
 *   describeIf('thing', () => { … })
 */
import { describeDb, getDb, getDialect, resetDb } from '../../src/storage/db'
import { runMigrationsToLatest } from '../../src/storage/migrator'

export interface IntegrationBootstrap {
  /** True when the suite should run; false signals silent skip. */
  ready: boolean
  /** Resolved dialect (`postgres` | `sqlite`) when `ready` is true. */
  dialect: 'postgres' | 'sqlite' | null
  /**
   * True when the storage backend is an in-process volatile store
   * (sqlite `:memory:`). Specs whose semantics depend on data
   * surviving a `resetDb()` (durability tests) skip when this is true.
   */
  inMemory: boolean
  /** Tear down the singleton DB. Safe to call when not ready. */
  teardown(): Promise<void>
}

export async function bootstrapIntegrationDb(): Promise<IntegrationBootstrap> {
  const url = process.env['OPENFGA_DB_URL']
  if (!url) {
    // Neither vitest project default nor operator env is set. The
    // `integration` project always sets `:memory:`, so reaching this
    // branch means the `integration-pg` project ran without an
    // operator-supplied URL. Skip silently.
    console.warn('[openfga integration] OPENFGA_DB_URL unset — skipping integration suite (likely integration-pg project without Postgres available).')
    return { ready: false, dialect: null, inMemory: false, teardown: async () => { /* nothing constructed */ } }
  }

  const dialect = getDialect()

  if (dialect === 'sqlite') {
    // SQLite path — :memory: starts empty, so migrations are required
    // to build the schema. `runMigrationsToLatest` is shared with
    // production (`pnpm migrate up`) so test schema cannot drift.
    await runMigrationsToLatest()
    // Force singleton init so `resetDb()` has something to tear down,
    // and so describeDb() can report the resolved path/in-memory flag.
    getDb()
    const desc = describeDb()
    const inMemory = desc.dialect === 'sqlite' && desc.inMemory
    return {
      ready: true,
      dialect,
      inMemory,
      teardown: async () => { await resetDb() },
    }
  }

  // Postgres path — CI runs `pnpm migrate up` before vitest, so
  // migrations are already applied. Probe via the abstracted Kysely
  // instance: a reachable pg returns from `selectFrom('store')` with
  // either rows or empty; an unreachable pg throws on the underlying
  // pool connect. No raw SQL, no schema-qualified strings — Kysely's
  // `withSchema(namespace)` handles the Postgres path.
  try {
    const db = getDb()
    await db.selectFrom('store').select('id').limit(1).execute()
    return {
      ready: true,
      dialect,
      inMemory: false,
      teardown: async () => { await resetDb() },
    }
  }
  catch (err) {
    console.warn(
      `[openfga integration] Postgres unreachable or migrations not applied — skipping integration-pg suite (${(err as Error).message}).`,
    )
    // Best-effort teardown of any partially constructed singleton so
    // the next file's bootstrap starts clean.
    await resetDb().catch(() => { /* ignore */ })
    return { ready: false, dialect, inMemory: false, teardown: async () => { /* already torn down */ } }
  }
}
