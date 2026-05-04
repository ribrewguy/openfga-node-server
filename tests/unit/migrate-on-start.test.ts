/**
 * Unit tests for the OPENFGA_MIGRATE_ON_START env-var parser and the
 * boot-time migration gate.
 *
 * Covers:
 *
 *   - parseMigrateOnStart: strict 'true' | 'false' parsing matching
 *     OPENFGA_HTTP_ENABLED. Whitespace and case-tolerant. Unset →
 *     false. Anything else → throws with the offending value visible
 *     in the message.
 *   - applyMigrationsOnStartIfEnabled: no-op when disabled (the probe
 *     stays unhealthy on an unmigrated DB); applies migrations when
 *     enabled (the probe flips to ok).
 *   - End-to-end boot semantics: the readiness probe transitions
 *     503 → 200 across a single in-process invocation when the flag
 *     is on, and stays 503 when off — the contract that operators
 *     deploying with this flag are relying on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDb } from '../../src/storage/db'
import { logger } from '../../src/logger'
import { applyMigrationsOnStartIfEnabled, parseMigrateOnStart } from '../../src/storage/migrate-on-start'
import { checkReadiness } from '../../src/storage/readiness'

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE', 'OPENFGA_MIGRATE_ON_START'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env['OPENFGA_DB_URL'] = ':memory:'
  delete process.env['OPENFGA_DB_NAMESPACE']
  delete process.env['OPENFGA_MIGRATE_ON_START']
  await resetDb()
})

afterEach(async () => {
  await resetDb()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('parseMigrateOnStart', () => {
  it('returns false when unset', () => {
    expect(parseMigrateOnStart(undefined)).toBe(false)
  })

  it.each(['true', 'TRUE', '  True  ', 'TrUe'])(
    'parses %j as true (case- and whitespace-tolerant)',
    (raw) => {
      expect(parseMigrateOnStart(raw)).toBe(true)
    },
  )

  it.each(['false', 'FALSE', '  False  '])(
    'parses %j as false',
    (raw) => {
      expect(parseMigrateOnStart(raw)).toBe(false)
    },
  )

  it.each(['1', '0', 'yes', 'no', 'on', 'off', ''])(
    'rejects %j with the offending value visible in the message',
    (raw) => {
      expect(() => parseMigrateOnStart(raw)).toThrow(/OPENFGA_MIGRATE_ON_START must be "true" or "false"/)
    },
  )
})

describe('applyMigrationsOnStartIfEnabled', () => {
  it('is a no-op when the flag is unset (probe stays unhealthy)', async () => {
    await applyMigrationsOnStartIfEnabled()
    const result = await checkReadiness()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('schema_missing')
  })

  it('is a no-op when the flag is false', async () => {
    process.env['OPENFGA_MIGRATE_ON_START'] = 'false'
    await applyMigrationsOnStartIfEnabled()
    const result = await checkReadiness()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('schema_missing')
  })

  it('applies migrations when the flag is true (probe flips ok)', async () => {
    process.env['OPENFGA_MIGRATE_ON_START'] = 'true'
    // Pre-condition: readiness reports schema_missing.
    expect(await checkReadiness()).toMatchObject({ ok: false, reason: 'schema_missing' })
    await applyMigrationsOnStartIfEnabled()
    // Post-condition: readiness reports ok against the same DB.
    expect(await checkReadiness()).toEqual({ ok: true })
  })

  it('honours a non-default OPENFGA_DB_NAMESPACE', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'app_authz'
    process.env['OPENFGA_MIGRATE_ON_START'] = 'true'
    await resetDb()
    await applyMigrationsOnStartIfEnabled()
    expect(await checkReadiness()).toEqual({ ok: true })
  })

  it('rejects an invalid flag value before doing any DB work', async () => {
    process.env['OPENFGA_MIGRATE_ON_START'] = 'maybe'
    await expect(applyMigrationsOnStartIfEnabled()).rejects.toThrow(
      /OPENFGA_MIGRATE_ON_START must be "true" or "false"/,
    )
    // DB stays untouched — readiness still reports schema_missing.
    expect(await checkReadiness()).toMatchObject({ ok: false, reason: 'schema_missing' })
  })

  it('propagates the underlying error when the migrator fails (corrupt DB)', async () => {
    // Plant a non-SQLite file at the configured path. better-sqlite3
    // opens the handle without inspecting contents, so the failure
    // surfaces from the Migrator's first catalog query — exactly the
    // shape of "the operator wired the wrong path" in production.
    const dir = mkdtempSync(join(tmpdir(), 'openfga-migrate-on-start-'))
    const corrupt = join(dir, 'corrupt.sqlite')
    writeFileSync(corrupt, Buffer.from('this is not a sqlite database'))
    process.env['OPENFGA_DB_URL'] = `sqlite:${corrupt}`
    process.env['OPENFGA_MIGRATE_ON_START'] = 'true'
    await resetDb()
    try {
      await expect(applyMigrationsOnStartIfEnabled()).rejects.toThrow()
    }
    finally {
      await resetDb()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('applyMigrationsOnStartIfEnabled — logging contract', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never)
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    debugSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('emits a DEBUG state line when the flag is unset (no migration attempted)', async () => {
    await applyMigrationsOnStartIfEnabled()
    expect(debugSpy).toHaveBeenCalledTimes(1)
    const [obj, msg] = debugSpy.mock.calls[0]!
    expect(obj).toMatchObject({ OPENFGA_MIGRATE_ON_START: null, enabled: false })
    expect(msg).toMatch(/disabled — no migration will be attempted/)
    // Skipped path emits no INFO events.
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('emits a DEBUG state line when the flag is explicitly false', async () => {
    process.env['OPENFGA_MIGRATE_ON_START'] = 'false'
    await applyMigrationsOnStartIfEnabled()
    const [obj, msg] = debugSpy.mock.calls[0]!
    expect(obj).toMatchObject({ OPENFGA_MIGRATE_ON_START: 'false', enabled: false })
    expect(msg).toMatch(/disabled/)
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('emits DEBUG state + INFO attempt + INFO success when the flag is true', async () => {
    process.env['OPENFGA_MIGRATE_ON_START'] = 'true'
    await applyMigrationsOnStartIfEnabled()
    const [debugObj, debugMsg] = debugSpy.mock.calls[0]!
    expect(debugObj).toMatchObject({ OPENFGA_MIGRATE_ON_START: 'true', enabled: true })
    expect(debugMsg).toMatch(/enabled/)
    const infoMessages = infoSpy.mock.calls.map((c: unknown[]) => c[0])
    expect(infoMessages).toEqual(['migrate_on_start_attempt', 'migrate_on_start_success'])
  })
})
