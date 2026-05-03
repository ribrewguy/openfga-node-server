/**
 * Integration test — tuples persist across a simulated server restart.
 *
 * The "restart" is modeled by ending the pg.Pool, re-creating it, and
 * proving that the same `check()` call returns the same answer. This
 * is the durability guarantee the storage layer makes.
 *
 * The test is a no-op when `OPENFGA_DB_URL` is not reachable, so
 * vitest runs without a database pass silently rather than failing.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { Pool } from 'pg'
import { transformer } from '@openfga/syntax-transformer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { check } from '../../src/evaluator/check'
import { ModelIndex } from '../../src/evaluator/model-index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel, getLatestAuthorizationModel } from '../../src/storage/authorization-models'
import { writeTuples } from '../../src/storage/tuples'
import { resetDb } from '../../src/storage/db'
import { pgTupleStore } from '../../src/storage/engine-context'

const DB_URL = process.env['OPENFGA_DB_URL']
const MODEL_PATH = resolve(import.meta.dirname ?? '.', '..', 'fixtures', 'github.fga')

async function probeDb(dsn: string): Promise<boolean> {
  const probe = new Pool({ connectionString: dsn, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1 FROM openfga.store LIMIT 1')
    return true
  }
  catch {
    return false
  }
  finally {
    await probe.end().catch(() => { /* ignore */ })
  }
}

// Probe synchronously at module load — top-level await — so the right
// `describe` (real or `.skip`) is registered before vitest collects.
const dbAvailable = DB_URL ? await probeDb(DB_URL) : false
if (!dbAvailable) {
  console.warn('[openfga integration] OPENFGA_DB_URL unreachable or unset — skipping persistence tests.')
}

afterAll(() => {
  if (dbAvailable) resetDb()
})

const describeIfDb = dbAvailable ? describe : describe.skip

describeIfDb('persistence', () => {
  it('tuples survive pool reset — check still returns true after reconnect', async () => {
    const store = await createStore(`integration-test-${Date.now()}`)
    const dsl = readFileSync(MODEL_PATH, 'utf8')
    const modelJson = transformer.transformDSLToJSONObject(dsl)
    const model = await writeAuthorizationModel(store.id, modelJson)
    const userId = `test-user-${Date.now()}`
    await writeTuples(store.id, [
      { user: `user:${userId}`, relation: 'admin', object: 'organization:openfga' },
    ])

    {
      const before = await check(
        new ModelIndex(model.type_definitions),
        pgTupleStore(store.id),
        `user:${userId}`,
        'admin',
        'organization:openfga',
      )
      expect(before).toBe(true)
    }

    resetDb()

    const latest = await getLatestAuthorizationModel(store.id)
    expect(latest).not.toBeNull()
    const after = await check(
      new ModelIndex(latest!.type_definitions),
      pgTupleStore(store.id),
      `user:${userId}`,
      'admin',
      'organization:openfga',
    )
    expect(after).toBe(true)
  })

  it('granting organization#admin is durable — round-trip via the storage layer', async () => {
    const store = await createStore(`integration-test-admin-${Date.now()}`)
    const dsl = readFileSync(MODEL_PATH, 'utf8')
    const modelJson = transformer.transformDSLToJSONObject(dsl)
    await writeAuthorizationModel(store.id, modelJson)

    const adminId = `admin-${Date.now()}`
    await writeTuples(store.id, [
      { user: `user:${adminId}`, relation: 'admin', object: 'organization:openfga' },
    ])

    resetDb()

    const latest = await getLatestAuthorizationModel(store.id)
    const allowed = await check(
      new ModelIndex(latest!.type_definitions),
      pgTupleStore(store.id),
      `user:${adminId}`,
      'admin',
      'organization:openfga',
    )
    expect(allowed).toBe(true)
  })
})
