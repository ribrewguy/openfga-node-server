/**
 * Integration test — Idempotency-Key storage layer hits real Postgres.
 *
 * Skips silently when OPENFGA_DB_URL is unreachable (same pattern as
 * tests/integration/persistence.test.ts). Exercises:
 *
 *   - first claim succeeds with kind='claimed'
 *   - second claim with same fingerprint while in-flight returns
 *     kind='in_flight' (409 territory)
 *   - second claim with a different fingerprint returns kind='mismatch'
 *     (422 territory)
 *   - completed key replays the cached response
 *   - expired keys are deleted on a fresh claim
 *   - releaseKey clears in-flight state for retry
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { claimKey, completeKey, releaseKey } from '../../src/storage/idempotency'
import { resetPool } from '../../src/storage/pool'

const DB_URL = process.env['OPENFGA_DB_URL']

async function probeDb(dsn: string): Promise<boolean> {
  const probe = new Pool({ connectionString: dsn, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1 FROM openfga.idempotency_keys LIMIT 1')
    return true
  }
  catch {
    return false
  }
  finally {
    await probe.end().catch(() => { /* ignore */ })
  }
}

const dbAvailable = DB_URL ? await probeDb(DB_URL) : false
if (!dbAvailable) {
  console.warn(
    '[openfga integration] OPENFGA_DB_URL unreachable, unset, or migrations not applied — skipping idempotency tests.',
  )
}

afterAll(() => {
  if (dbAvailable) resetPool()
})

const describeIfDb = dbAvailable ? describe : describe.skip

function uniqueKey(label: string): string {
  return `idem-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

describeIfDb('idempotency storage', () => {
  beforeEach(async () => {
    // Tests use unique keys, so cross-test interference is unlikely,
    // but a wide TTL also guarantees no row from one test ages out
    // mid-test.
  })

  it('first claim returns kind=claimed', async () => {
    const key = uniqueKey('claim')
    const result = await claimKey(key, 'fingerprint-a', 60_000)
    expect(result.kind).toBe('claimed')
    await releaseKey(key)
  })

  it('second claim with same fingerprint while in-flight returns kind=in_flight', async () => {
    const key = uniqueKey('inflight')
    const first = await claimKey(key, 'fp-a', 60_000)
    expect(first.kind).toBe('claimed')

    const second = await claimKey(key, 'fp-a', 60_000)
    expect(second.kind).toBe('in_flight')

    await releaseKey(key)
  })

  it('second claim with different fingerprint returns kind=mismatch', async () => {
    const key = uniqueKey('mismatch')
    await claimKey(key, 'fp-original', 60_000)

    const second = await claimKey(key, 'fp-different', 60_000)
    expect(second.kind).toBe('mismatch')

    await releaseKey(key)
  })

  it('completed key replays the cached response on next claim', async () => {
    const key = uniqueKey('replay')
    const first = await claimKey(key, 'fp-a', 60_000)
    expect(first.kind).toBe('claimed')

    await completeKey(key, 200, { id: 'cached-store' })

    const replayed = await claimKey(key, 'fp-a', 60_000)
    expect(replayed.kind).toBe('replay')
    if (replayed.kind === 'replay') {
      expect(replayed.status).toBe(200)
      expect(replayed.body).toEqual({ id: 'cached-store' })
    }

    await releaseKey(key)
  })

  it('mismatch detection still applies after the original is completed', async () => {
    const key = uniqueKey('completed-mismatch')
    await claimKey(key, 'fp-original', 60_000)
    await completeKey(key, 200, { id: 'cached-store' })

    const second = await claimKey(key, 'fp-different', 60_000)
    expect(second.kind).toBe('mismatch')

    await releaseKey(key)
  })

  it('expired keys are deleted and the new claim wins', async () => {
    const key = uniqueKey('expired')
    const first = await claimKey(key, 'fp-old', 60_000)
    expect(first.kind).toBe('claimed')

    // Pretend the previous row aged past the TTL by claiming again
    // with ttlMs = 0 — every existing row is older than now()-0ms.
    const fresh = await claimKey(key, 'fp-new', 0)
    expect(fresh.kind).toBe('claimed')

    await releaseKey(key)
  })

  it('releaseKey clears in-flight state so a retry can claim cleanly', async () => {
    const key = uniqueKey('release')
    await claimKey(key, 'fp-a', 60_000)
    await releaseKey(key)

    const retried = await claimKey(key, 'fp-a', 60_000)
    expect(retried.kind).toBe('claimed')

    await releaseKey(key)
  })
})
