/**
 * Integration tests for GET /stores/:storeId/changes.
 *
 * Pinned by openfga-bh9: tuple writes/deletes record changes
 * transactionally, the changelog is paginated newest-first with a
 * round-tripping continuation_token, the optional `type` filter
 * narrows by object type, and `start_time` admits only changes at or
 * after the timestamp. Skips silently when OPENFGA_DB_URL is
 * unreachable.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { writeTuples, deleteTuples } from '../../src/storage/tuples'
import { resetPool } from '../../src/storage/pool'

const DB_URL = process.env['OPENFGA_DB_URL']

async function probeDb(dsn: string): Promise<boolean> {
  const probe = new Pool({ connectionString: dsn, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1 FROM openfga.tuple_change LIMIT 1')
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
    '[openfga integration] OPENFGA_DB_URL unreachable, unset, or migrations not applied — skipping changes tests.',
  )
}

afterAll(() => {
  if (dbAvailable) resetPool()
})

const describeIfDb = dbAvailable ? describe : describe.skip

interface ChangesResponse {
  changes: Array<{
    tuple_key: { user: string, relation: string, object: string }
    operation: 'TUPLE_OPERATION_WRITE' | 'TUPLE_OPERATION_DELETE'
    timestamp: string
  }>
  continuation_token: string
}

describeIfDb('GET /stores/:storeId/changes', () => {
  async function setupStore() {
    const store = await createStore(`changes-${Date.now()}-${Math.random()}`)
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
    return store.id
  }

  function get(storeId: string, query: string): Request {
    return new Request(`http://localhost/stores/${storeId}/changes${query}`)
  }

  it('records a TUPLE_OPERATION_WRITE for each successful write', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
    ])

    const res = await app.fetch(get(storeId, '?page_size=100'))
    expect(res.status).toBe(200)
    const json = await res.json() as ChangesResponse
    expect(json.changes).toHaveLength(2)
    for (const c of json.changes) expect(c.operation).toBe('TUPLE_OPERATION_WRITE')
    // Newest-first; ordering between two same-microsecond inserts is
    // tiebroken by ULID id (DESC), so the second write comes first.
    expect(json.changes.map((c) => c.tuple_key.user)).toEqual(['user:bob', 'user:alice'])
  })

  it('records a TUPLE_OPERATION_DELETE for each successful delete', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }])
    await deleteTuples(storeId, [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }])

    const res = await app.fetch(get(storeId, '?page_size=100'))
    const json = await res.json() as ChangesResponse
    expect(json.changes.map((c) => c.operation)).toEqual([
      'TUPLE_OPERATION_DELETE',
      'TUPLE_OPERATION_WRITE',
    ])
  })

  it('honors the ?type= filter to narrow to a single object type', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'folder:f1' },
    ])

    const res = await app.fetch(get(storeId, '?type=doc&page_size=100'))
    const json = await res.json() as ChangesResponse
    const objects = json.changes.map((c) => c.tuple_key.object)
    expect(objects).toEqual(['doc:1'])
  })

  it('rounds-trips continuation_token to enumerate all changes exactly once', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    const recorded: Array<{ user: string, op: 'TUPLE_OPERATION_WRITE' | 'TUPLE_OPERATION_DELETE' }> = []
    for (let i = 0; i < 5; i++) {
      await writeTuples(storeId, [{ user: `user:u${i}`, relation: 'viewer', object: 'doc:1' }])
      recorded.push({ user: `user:u${i}`, op: 'TUPLE_OPERATION_WRITE' })
    }

    const seen: typeof recorded = []
    let token: string | undefined
    let safety = 50
    while (safety > 0) {
      const url = `?page_size=2${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`
      const res = await app.fetch(get(storeId, url))
      const json = await res.json() as ChangesResponse
      for (const c of json.changes) seen.push({ user: c.tuple_key.user, op: c.operation })
      if (json.continuation_token === '') break
      token = json.continuation_token
      safety--
    }
    expect(safety).toBeGreaterThan(0)
    expect(seen).toEqual([...recorded].reverse())
    expect(new Set(seen.map((s) => s.user)).size).toBe(seen.length)
  })

  it('honors start_time to exclude changes recorded before the cutoff', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [{ user: 'user:before', relation: 'viewer', object: 'doc:1' }])
    // Sleep ~50ms so the cutoff lands cleanly between the two inserts.
    await new Promise((r) => setTimeout(r, 50))
    const cutoff = new Date().toISOString()
    await new Promise((r) => setTimeout(r, 50))
    await writeTuples(storeId, [{ user: 'user:after', relation: 'viewer', object: 'doc:1' }])

    const res = await app.fetch(get(storeId, `?start_time=${encodeURIComponent(cutoff)}`))
    const json = await res.json() as ChangesResponse
    const users = json.changes.map((c) => c.tuple_key.user)
    expect(users).toEqual(['user:after'])
  })

  it('returns 400 invalid_argument for a malformed continuation_token', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    const res = await app.fetch(get(storeId, '?continuation_token=not-real'))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })

  it('returns 400 invalid_argument for a malformed start_time', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    const res = await app.fetch(get(storeId, '?start_time=not-a-timestamp'))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })
})
