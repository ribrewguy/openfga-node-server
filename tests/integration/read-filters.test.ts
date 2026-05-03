/**
 * Integration tests for the /read endpoint's object-filter semantics.
 *
 * Pinned by openfga-7y8: tuple_key.object accepts both full
 * "type:id" references and type-only "type:" filters; the latter
 * returns every tuple of that type matching the rest of the filter.
 *
 * Skips silently when OPENFGA_DB_URL is unreachable or migrations have
 * not been applied, matching the existing integration test pattern.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { writeTuples } from '../../src/storage/tuples'
import { resetDb } from '../../src/storage/db'

const DB_URL = process.env['OPENFGA_DB_URL']

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

const dbAvailable = DB_URL ? await probeDb(DB_URL) : false
if (!dbAvailable) {
  console.warn(
    '[openfga integration] OPENFGA_DB_URL unreachable, unset, or migrations not applied — skipping read-filter tests.',
  )
}

afterAll(() => {
  if (dbAvailable) resetDb()
})

const describeIfDb = dbAvailable ? describe : describe.skip

interface ReadResponse {
  tuples: Array<{ key: { user: string, relation: string, object: string } }>
}

describeIfDb('/read object-filter semantics', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`read-filters-${Date.now()}-${Math.random()}`)
    await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
        {
          type: 'folder',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
      ],
    })
    await writeTuples(store.id, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
      { user: 'user:bob', relation: 'viewer', object: 'folder:f1' },
    ])
    return { app, storeId: store.id }
  }

  function read(storeId: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns every tuple of the requested type for a "type:" filter', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(read(storeId, { tuple_key: { object: 'doc:' } }))
    expect(res.status).toBe(200)
    const json = await res.json() as ReadResponse
    const objects = json.tuples.map((t) => t.key.object).sort()
    expect(objects).toEqual(['doc:1', 'doc:2'])
  })

  it('returns the exact tuple for a full "type:id" filter (regression)', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(read(storeId, { tuple_key: { object: 'doc:1' } }))
    expect(res.status).toBe(200)
    const json = await res.json() as ReadResponse
    expect(json.tuples).toHaveLength(1)
    expect(json.tuples[0]?.key.object).toBe('doc:1')
  })

  it('combines "type:" filter with relation/user constraints', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(
      read(storeId, { tuple_key: { object: 'doc:', user: 'user:alice', relation: 'viewer' } }),
    )
    expect(res.status).toBe(200)
    const json = await res.json() as ReadResponse
    const objects = json.tuples.map((t) => t.key.object).sort()
    expect(objects).toEqual(['doc:1', 'doc:2'])
  })

  it('returns 400 for an object reference without a colon', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(read(storeId, { tuple_key: { object: 'broken' } }))
    expect(res.status).toBe(400)
    const json = await res.json() as { code: string }
    expect(json.code).toBe('invalid_argument')
  })
})
