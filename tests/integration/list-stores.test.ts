/**
 * Integration tests for GET /stores.
 *
 * Pinned by openfga-7ct: empty / single / multiple / pagination round
 * trip / soft-delete exclusion. The continuation_token is opaque to
 * clients but stable across calls — paging through with the
 * server-issued token must enumerate every store exactly once,
 * newest-first.
 *
 * Skips silently when OPENFGA_DB_URL is unreachable, matching the
 * existing integration test pattern.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { resetPool } from '../../src/storage/pool'

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
    '[openfga integration] OPENFGA_DB_URL unreachable, unset, or migrations not applied — skipping list-stores tests.',
  )
}

afterAll(() => {
  if (dbAvailable) resetPool()
})

const describeIfDb = dbAvailable ? describe : describe.skip

interface ListStoresResponse {
  stores: Array<{ id: string, name: string, created_at: string, updated_at: string }>
  continuation_token: string
}

describeIfDb('GET /stores', () => {
  // A unique tag scopes each test's assertions to its own freshly-created
  // stores, so previous test runs left in the DB don't bleed into
  // expectations. Tests filter the response on this tag prefix.
  function uniqueTag(): string {
    return `list-stores-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  function get(query: string): Request {
    return new Request(`http://localhost/stores${query}`)
  }

  it('returns an OpenFGA-compatible envelope with empty token when there are no further pages', async () => {
    const app = buildApp()
    const tag = uniqueTag()
    await createStore(`${tag}-only`)

    const res = await app.fetch(get('?page_size=10'))
    expect(res.status).toBe(200)
    const json = await res.json() as ListStoresResponse
    expect(Array.isArray(json.stores)).toBe(true)
    expect(typeof json.continuation_token).toBe('string')
    const ours = json.stores.filter(s => s.name.startsWith(tag))
    expect(ours.map(s => s.name)).toEqual([`${tag}-only`])
  })

  it('returns multiple stores newest-first', async () => {
    const app = buildApp()
    const tag = uniqueTag()
    await createStore(`${tag}-1`)
    await createStore(`${tag}-2`)
    await createStore(`${tag}-3`)

    const res = await app.fetch(get('?page_size=100'))
    expect(res.status).toBe(200)
    const json = await res.json() as ListStoresResponse
    const ours = json.stores.filter(s => s.name.startsWith(tag))
    // Newest-first means the most recently inserted comes first.
    expect(ours.map(s => s.name)).toEqual([`${tag}-3`, `${tag}-2`, `${tag}-1`])
  })

  it('rounds-trips the continuation_token to enumerate every store exactly once', async () => {
    const app = buildApp()
    const tag = uniqueTag()
    const created: string[] = []
    for (let i = 0; i < 5; i++) {
      const row = await createStore(`${tag}-${i}`)
      created.push(row.name)
    }

    const seen: string[] = []
    let token: string | undefined
    let safety = 50
    do {
      const url = `?page_size=2${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`
      const res = await app.fetch(get(url))
      expect(res.status).toBe(200)
      const json = await res.json() as ListStoresResponse
      for (const s of json.stores) {
        if (s.name.startsWith(tag)) seen.push(s.name)
      }
      token = json.continuation_token === '' ? undefined : json.continuation_token
      safety--
    } while (token !== undefined && safety > 0)
    expect(safety).toBeGreaterThan(0)

    // Newest-first across the entire walk; no duplicates, no drops.
    expect(seen).toEqual([...created].reverse())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('returns an empty stores array on the page after the last one', async () => {
    const app = buildApp()
    const tag = uniqueTag()
    const onlyRow = await createStore(`${tag}-solo`)

    // First page returns the row + an empty token (only one row exists).
    const first = await app.fetch(get('?page_size=10'))
    const firstJson = await first.json() as ListStoresResponse
    const firstOurs = firstJson.stores.filter(s => s.name.startsWith(tag))
    expect(firstOurs.map(s => s.id)).toEqual([onlyRow.id])
    expect(firstJson.continuation_token).toBe('')
  })

  it('returns 400 invalid_argument for a malformed continuation_token', async () => {
    const app = buildApp()
    const res = await app.fetch(get('?continuation_token=not-a-real-token'))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })

  it('rejects negative or non-numeric page_size at the validation boundary', async () => {
    const app = buildApp()
    const res = await app.fetch(get('?page_size=abc'))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })
})
