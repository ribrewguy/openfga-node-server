/**
 * Unit tests for `assertions.ts` against in-memory SQLite. Mirrors
 * the openfga-19w port (assertions UPSERT via onConflict.doUpdateSet
 * with EXCLUDED).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { getAssertions, writeAssertions } from '../../src/storage/assertions'
import { migrateToLatest } from '../_helpers/sqlite-bootstrap'

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  await resetDb()
  delete process.env['OPENFGA_DB_NAMESPACE']
  await migrateToLatest()
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetDb()
})

describe('assertions (Kysely port)', () => {
  it('getAssertions returns [] when none have been written', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    expect(await getAssertions(store.id, model.id)).toEqual([])
  })

  it('writeAssertions inserts a new assertion array', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    const assertions = [
      { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, expectation: true },
    ]
    await writeAssertions(store.id, model.id, assertions)
    const out = await getAssertions(store.id, model.id)
    expect(out).toEqual(assertions)
  })

  it('writeAssertions upserts via ON CONFLICT DO UPDATE (EXCLUDED.assertions)', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await writeAssertions(store.id, model.id, [
      { tuple_key: { user: 'user:a', relation: 'viewer', object: 'doc:1' }, expectation: true },
    ])
    // Second write replaces the first.
    await writeAssertions(store.id, model.id, [
      { tuple_key: { user: 'user:b', relation: 'editor', object: 'doc:2' }, expectation: false },
    ])
    const out = await getAssertions(store.id, model.id)
    expect(out).toHaveLength(1)
    expect(out[0]?.tuple_key.user).toBe('user:b')
    expect(out[0]?.expectation).toBe(false)
  })

  it('writeAssertions accepts an empty array (clears assertions for a model)', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await writeAssertions(store.id, model.id, [
      { tuple_key: { user: 'user:a', relation: 'viewer', object: 'doc:1' }, expectation: true },
    ])
    await writeAssertions(store.id, model.id, [])
    expect(await getAssertions(store.id, model.id)).toEqual([])
  })

  it('isolates assertions across (store, model) pairs', async () => {
    const storeA = await createStore('a')
    const storeB = await createStore('b')
    const modelA = await writeAuthorizationModel(storeA.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    const modelB = await writeAuthorizationModel(storeB.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await writeAssertions(storeA.id, modelA.id, [
      { tuple_key: { user: 'user:onlyA', relation: 'viewer', object: 'doc:1' }, expectation: true },
    ])
    expect(await getAssertions(storeA.id, modelA.id)).toHaveLength(1)
    expect(await getAssertions(storeB.id, modelB.id)).toEqual([])
  })

  it('updates the updated_at timestamp on UPSERT', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await writeAssertions(store.id, model.id, [
      { tuple_key: { user: 'u:a', relation: 'r', object: 'o:1' }, expectation: true },
    ])
    const before = (await sql<{ updated_at: string }>`select updated_at from openfga_assertions where store_id = ${store.id}`.execute(getDb())).rows[0]
    expect(typeof before?.updated_at).toBe('string')
    // Backdate so the second write produces a strictly-greater timestamp
    // even when both happen in the same wall-clock millisecond.
    await sql`update openfga_assertions set updated_at = '2000-01-01T00:00:00.000Z' where store_id = ${store.id}`.execute(getDb())
    await writeAssertions(store.id, model.id, [
      { tuple_key: { user: 'u:b', relation: 'r', object: 'o:2' }, expectation: false },
    ])
    const after = (await sql<{ updated_at: string }>`select updated_at from openfga_assertions where store_id = ${store.id}`.execute(getDb())).rows[0]
    expect(after?.updated_at).not.toBe('2000-01-01T00:00:00.000Z')
  })
})
