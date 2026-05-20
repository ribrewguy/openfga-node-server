/**
 * Side-effectful configuration loader.
 *
 * Production code imports `config` from this module to read the
 * resolved, validated configuration. Importing this module triggers
 * c12's file/env discovery, the env-var overlay, and Zod parsing at
 * top-level await. If parsing fails, the module logs the formatted
 * Zod error tree to stderr and exits the process with code 1.
 *
 * The `config` export is a Proxy over an internal mutable singleton
 * so tests that mutate `process.env` (or other inputs) can call
 * `reloadConfigForTests()` to re-run the full load pipeline against
 * the updated environment. Production code never sees the Proxy
 * shape — it dereferences fields exactly as if `config` were a plain
 * frozen object.
 *
 * Tests that need to construct a `Config` without going through any
 * file/env discovery import `loadAndParseConfig` directly. That
 * helper is the pure-async core; it throws a `ZodError` on failure
 * instead of exiting the process.
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
   * Working directory passed to c12. Defaults to `process.cwd()`.
   * Tests point this at a fixture directory containing an
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
  /**
   * Whether c12 should auto-load `.env` files. Defaults to `true`.
   * Tests that mutate `process.env` and expect those mutations to
   * win over the repo's `.env` set this to `false` so c12 does not
   * overwrite test-set env vars from the on-disk file.
   */
  dotenv?: boolean
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
    dotenv: opts.dotenv ?? true,
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
    // config). Fall back to console.error for the pre-init failure
    // path, matching the existing fail-fast pattern in src/server.ts.
    console.error('[openfga] invalid configuration:')
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

let _internal: Config = await loadOrExit()

/**
 * Resolved, validated configuration. Exposed as a Proxy over an
 * internal mutable singleton so `reloadConfigForTests()` can swap
 * the live value without invalidating import bindings. Consumers
 * read `config.db.url`, `config.idempotency.ttlMs`, etc. exactly as
 * they would a plain object.
 */
export const config: Config = new Proxy({} as Config, {
  get(_target, prop, _receiver) {
    return (_internal as unknown as Record<string | symbol, unknown>)[prop]
  },
  has(_target, prop) {
    return prop in (_internal as unknown as object)
  },
  ownKeys() {
    return Reflect.ownKeys(_internal as unknown as object)
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(_internal as unknown as object, prop)
  },
})

/**
 * Test-only: re-run the full load pipeline against the current
 * `process.env` and replace the internal config the `config` Proxy
 * reflects. Use in tests that mutate `OPENFGA_*` env vars before
 * exercising code paths that consume `config`.
 *
 * Production code does NOT call this. The exported name carries the
 * `ForTests` suffix as a readability and grep affordance — any
 * non-test caller is a smell.
 */
export async function reloadConfigForTests(opts: LoadAndParseOptions = {}): Promise<void> {
  // Default `dotenv: false` for test reloads so the repo's `.env` file
  // does not overwrite mutations the test made to `process.env`. Tests
  // that explicitly want `.env` behavior pass `{ dotenv: true }`.
  _internal = await loadAndParseConfig({ dotenv: false, ...opts })
}
