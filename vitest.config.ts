import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.{test,spec}.ts'],
          // SQLite is the default driver for unit tests so the storage
          // layer can be exercised without a Postgres container.
          // Tests that need to swap the URL (e.g. storage-db.test.ts's
          // dialect-detection cases) save and restore the env in
          // beforeEach/afterEach.
          env: {
            OPENFGA_DB_URL: ':memory:',
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.{test,spec}.ts'],
          testTimeout: 30_000,
        },
      },
    ],
    // Coverage runs against the combined unit + integration suite when
    // `pnpm coverage` is invoked — the integration job in CI runs both
    // projects in one go, with Postgres available, so the thresholds
    // below assume that combined view. `pnpm coverage:unit` runs only
    // the unit project for fast local feedback (no DB) and ignores
    // these thresholds via the script flag.
    //
    // Thresholds are floors set ~5% below the baseline measured at
    // bead-close time (openfga-efq) so they catch regressions without
    // failing day-1. Tighten these in a follow-up bead as new features
    // land with their own tests.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: [
        // Admin CLI tooling — exercised manually, not part of the
        // server runtime exposed by /stores/* routes.
        'src/cli/**',
        // Server entry-point boot wiring — env validation + listener
        // setup. Exercised by UAT and the local smoke against
        // pnpm start, not by unit/integration tests.
        'src/index.ts',
        // Postgres-only side-effect module (registers pg type
        // parsers; intFromEnv helper). The pg branch is exercised
        // by integration tests in CI, not by unit-only tests.
        'src/storage/pg-internals.ts',
      ],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      // Thresholds reflect the unit-only baseline measured under
      // openfga-yg9 with SQLite as the default driver: storage
      // modules largely 100% (assertions, db-schema, engine-context,
      // ids, stores, table-prefix-plugin, authorization-models),
      // 90%+ for dialect/idempotency, 79–82% for tuples (a few
      // Postgres-only `getDialect()==='postgres'` branches), and
      // ~67% for db.ts (the Postgres dialect branch in `getDb()`
      // is unreachable in unit-only by design — covered by the
      // integration tests in CI). `pnpm coverage:unit` flags
      // override these to 0 for local fast feedback; `pnpm coverage`
      // with PG in CI exercises the Postgres-only branches and
      // comfortably exceeds these floors.
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 72,
        lines: 72,
      },
    },
  },
})
