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
      ],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      thresholds: {
        statements: 75,
        branches: 68,
        functions: 73,
        lines: 78,
      },
    },
  },
})
