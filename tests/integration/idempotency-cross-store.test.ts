/**
 * Integration regression test for openfga-fot.
 *
 * The original bug: idempotency middleware fingerprinted the matched
 * route pattern (`/stores/:storeId/write`) instead of the concrete
 * request path. Same Idempotency-Key + same body across two stores
 * collided on the same fingerprint, so the second store's request
 * would replay store A's cached response under store B's namespace.
 *
 * This test exercises the exact production failure mode end-to-end
 * via the route stack with real Postgres-backed idempotency storage.
 * Codex used the same scenario for the manual reproduction; with the
 * fix the second call returns 422 idempotency_fingerprint_mismatch
 * rather than replaying.
 *
 * Skips silently when OPENFGA_DB_URL is unreachable. Sets
 * OPENFGA_IDEMPOTENCY_MODE=optional in beforeAll so the middleware
 * fires when an Idempotency-Key header is present; vitest isolates
 * env per worker process so concurrent test files are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { resetPool } from '../../src/storage/pool'
import type { Hono } from 'hono'

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
    '[openfga integration] OPENFGA_DB_URL unreachable, unset, or migrations not applied — skipping cross-store idempotency tests.',
  )
}

const describeIfDb = dbAvailable ? describe : describe.skip

describeIfDb('openfga-fot regression — cross-store idempotency on /authorization-models', () => {
  let app: Hono
  const previousMode = process.env['OPENFGA_IDEMPOTENCY_MODE']

  beforeAll(() => {
    // Middleware reads mode at composition time (buildApp), so the
    // env var must be set BEFORE the app is built.
    process.env['OPENFGA_IDEMPOTENCY_MODE'] = 'optional'
    app = buildApp()
  })

  afterAll(() => {
    if (previousMode === undefined) delete process.env['OPENFGA_IDEMPOTENCY_MODE']
    else process.env['OPENFGA_IDEMPOTENCY_MODE'] = previousMode
    resetPool()
  })

  function writeModelReq(storeId: string, body: unknown, idempotencyKey: string): Request {
    return new Request(`http://localhost/stores/${storeId}/authorization-models`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    })
  }

  it('same Idempotency-Key + same body across two stores does NOT replay store A under store B', async () => {
    const tag = `xstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const storeA = await createStore(`${tag}-a`)
    const storeB = await createStore(`${tag}-b`)

    const modelBody = {
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: { viewer: { this: {} } },
          metadata: {
            relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } },
          },
        },
      ],
    }
    const sharedKey = `shared-${tag}`

    // First call — store A. Succeeds, response cached against
    // (key, fingerprint) where fingerprint includes `/stores/<A>/...`.
    const resA = await app.fetch(writeModelReq(storeA.id, modelBody, sharedKey))
    expect(resA.status).toBe(200)
    const respA = await resA.json() as { authorization_model_id: string }
    expect(typeof respA.authorization_model_id).toBe('string')

    // Second call — store B with the same key + same body. With
    // openfga-fot fixed, the fingerprint differs (concrete path is
    // `/stores/<B>/...`), the storage layer's lookup under the
    // shared key surfaces the existing entry, and the fingerprint
    // mismatch returns 422.
    const resB = await app.fetch(writeModelReq(storeB.id, modelBody, sharedKey))
    expect(resB.status).toBe(422)
    const respB = await resB.json() as { code?: string }
    expect(respB.code).toBe('idempotency_fingerprint_mismatch')

    // Critical anti-replay assertion: store B's response must NOT be
    // store A's cached body. Even on a 422 the body shape differs
    // from the success response, but assert the model id is absent
    // so a future regression that returns 200 with respA's body
    // fails loudly.
    expect((respB as { authorization_model_id?: string }).authorization_model_id).toBeUndefined()
  })
})
