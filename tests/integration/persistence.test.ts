/**
 * Integration test — tuples persist across a simulated server restart.
 *
 * The "restart" is modeled by tearing down the storage singleton via
 * `resetDb()`, re-acquiring it, and proving that the same `check()`
 * call returns the same answer. This is the durability guarantee the
 * storage layer makes for any backend that persists data outside the
 * process — Postgres always, file-backed SQLite when configured.
 *
 * Skipped on `:memory:` SQLite: a `resetDb()` against an in-process
 * volatile store destroys the data by definition, so the durability
 * assertion does not apply. The `integration-pg` project exercises the
 * Postgres path; a future file-backed SQLite path could re-enable this
 * spec locally.
 */
import { describe, it, expect, afterAll } from 'vitest'
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
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const MODEL_PATH = resolve(import.meta.dirname ?? '.', '..', 'fixtures', 'github.fga')

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

// Durability tests require a backend that survives `resetDb()`. Skip
// on `:memory:` SQLite where the entire database lives in process
// memory and would be lost on teardown.
const describeIfDb = bootstrap.ready && !bootstrap.inMemory ? describe : describe.skip

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
