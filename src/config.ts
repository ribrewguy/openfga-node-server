/**
 * Side-effectful configuration loader.
 *
 * Production code imports `config` from this module to read the
 * resolved, validated configuration. Importing this module triggers
 * c12's file/env discovery, the env-var overlay, and Zod parsing at
 * top-level await. If parsing fails, the module logs the formatted
 * Zod error tree to stderr and exits the process with code 1.
 *
 * Tests that need to construct a `Config` without triggering this
 * module's side effects import `loadAndParseConfig` directly. That
 * helper is the same logic without the `process.exit(1)` on failure;
 * it throws a `ZodError` instead so callers can assert on the failure
 * shape.
 *
 * The module structure separation is documented in
 * `docs/features/configuration.md` §"Test Strategy".
 */
import { loadConfig } from 'c12'
import { applyEnvOverrides } from './config-env-overrides'
import { ConfigSchema, type Config } from './config-schema'

export type { Config } from './config-schema'

export interface LoadAndParseOptions {
  /**
   * Working directory passed to c12. Defaults to `process.cwd()`. Tests
   * point this at a fixture directory containing an
   * `openfga.config.yaml`.
   */
  cwd?: string
  /**
   * Environment-variable source for the overlay step. Defaults to
   * `process.env`. Tests pass a synthetic object to assert specific
   * env-var translations in isolation from the host environment.
   */
  env?: Record<string, string | undefined>
  /**
   * Override block applied on top of c12 and env-overlay outputs.
   * Reserved for tests that need to inject a value the schema
   * declares as required without setting an env var or fixture file.
   */
  overrides?: Record<string, unknown>
}

/**
 * Load configuration from disk + environment and validate it.
 *
 * Source ordering (lowest to highest precedence):
 *   1. Zod schema defaults
 *   2. openfga.config.{yaml,yml,toml,...} base block
 *   3. $development / $production / $test block matching NODE_ENV
 *   4. OPENFGA_* env vars (incl. those loaded from .env via c12)
 *   5. The `overrides` argument (test-only injection point)
 *
 * Throws `ZodError` on validation failure. Callers that want
 * fail-fast process termination should use the top-level `config`
 * export instead.
 */
export async function loadAndParseConfig(opts: LoadAndParseOptions = {}): Promise<Config> {
  const env = opts.env ?? process.env
  const { config: raw } = await loadConfig({
    name: 'openfga',
    cwd: opts.cwd,
    dotenv: true,
    rcFile: false,
    globalRc: false,
    packageJson: false,
  })

  let merged = applyEnvOverrides(raw ?? {}, env)
  if (opts.overrides) {
    const base = (merged && typeof merged === 'object' && !Array.isArray(merged))
      ? (merged as Record<string, unknown>)
      : {}
    merged = { ...base, ...opts.overrides }
  }

  return ConfigSchema.parse(merged)
}

async function loadOrExit(): Promise<Config> {
  try {
    return await loadAndParseConfig()
  }
  catch (err) {
    // The logger may not be initialized yet (logger reads from
    // config). Fall back to console.error and stderr for the
    // pre-init failure path, matching the existing fail-fast
    // pattern in src/server.ts.
    console.error('[openfga] invalid configuration:')
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

export const config: Config = await loadOrExit()
