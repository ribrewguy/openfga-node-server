/**
 * Unit tests for `engine-context.ts` — the wiring layer between the
 * storage repositories and the evaluator's `TupleStore` interface.
 *
 * Covers:
 *   - loadModelIndex pinning to a specific model id
 *   - loadModelIndex falling back to the latest model when id is undefined
 *   - loadModelIndex returning null when neither resolves
 *   - the per-store ModelIndex cache (second call hits the cache)
 *   - clearModelCache resetting the cache
 *   - pgTupleStore wraps the three evaluator helpers
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { writeTuples } from '../../src/storage/tuples'
import { clearModelCache, loadModelIndex, pgTupleStore } from '../../src/storage/engine-context'
import { migrateToLatest } from '../_helpers/sqlite-bootstrap'

async function stampModelCreatedAt(modelId: string, ts: string): Promise<void> {
  await sql`update openfga_authorization_model set created_at = ${ts} where id = ${modelId}`.execute(getDb())
}

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  await resetDb()
  delete process.env['OPENFGA_DB_NAMESPACE']
  await migrateToLatest()
  clearModelCache()
})

afterEach(async () => {
  clearModelCache()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetDb()
})

describe('loadModelIndex', () => {
  it('returns null when the store has no models and no id is pinned', async () => {
    const store = await createStore('s')
    expect(await loadModelIndex(store.id, undefined)).toBeNull()
  })

  it('returns null when a pinned model id does not exist', async () => {
    const store = await createStore('s')
    expect(await loadModelIndex(store.id, '01ABCDEFGHIJKLMNOPQRSTUVWX')).toBeNull()
  })

  it('returns the latest model when no id is pinned', async () => {
    const store = await createStore('s')
    const m1 = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await stampModelCreatedAt(m1.id, '2026-01-01T00:00:00.001Z')
    const m2 = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }, { type: 'doc' }],
    })
    await stampModelCreatedAt(m2.id, '2026-01-01T00:00:00.002Z')
    const ctx = await loadModelIndex(store.id, undefined)
    expect(ctx?.modelId).toBe(m2.id)
  })

  it('honors a pinned model id even when newer models exist', async () => {
    const store = await createStore('s')
    const m1 = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await stampModelCreatedAt(m1.id, '2026-01-01T00:00:00.001Z')
    const m2 = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }, { type: 'doc' }],
    })
    await stampModelCreatedAt(m2.id, '2026-01-01T00:00:00.002Z')
    const ctx = await loadModelIndex(store.id, m1.id)
    expect(ctx?.modelId).toBe(m1.id)
  })

  it('caches the ModelIndex by (storeId, modelId)', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    const a = await loadModelIndex(store.id, model.id)
    const b = await loadModelIndex(store.id, model.id)
    // Same instance returned on the second call.
    expect(a?.index).toBe(b?.index)
  })

  it('clearModelCache forces a fresh ModelIndex on next load', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    const before = await loadModelIndex(store.id, model.id)
    clearModelCache()
    const after = await loadModelIndex(store.id, model.id)
    expect(after?.index).not.toBe(before?.index)
  })
})

describe('pgTupleStore', () => {
  it('exposes the three evaluator helpers scoped to a store', async () => {
    const store = await createStore('s')
    await writeTuples(store.id, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
      { user: 'user:bob', relation: 'editor', object: 'doc:1' },
    ])
    const ts = pgTupleStore(store.id)

    const users = await ts.listUsersForRelation('doc', '1', 'viewer')
    expect(users.sort()).toEqual(['user:alice'])

    const ids = await ts.listObjectIdsForUser('doc', 'viewer', 'user:alice')
    expect(ids.sort()).toEqual(['1', '2'])

    const all = await ts.listAllForRelation('doc', 'viewer')
    expect(all.map(p => `${p.object_id}/${p.user_str}`).sort())
      .toEqual(['1/user:alice', '2/user:alice'])
  })
})
