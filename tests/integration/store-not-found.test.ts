/**
 * Integration tests for the requireStore guard (openfga-rv0).
 *
 * Every /stores/:storeId/* route must return 404 store_id_not_found
 * when the requested store id does not exist. The previous behavior
 * for several routes was 200 with empty arrays (or 200 {} for
 * delete-only /write with on_missing: 'ignore'), which Codex review
 * flagged as a wire-compat regression and a misleading client signal.
 *
 * Skips silently when OPENFGA_DB_URL is unreachable.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { buildApp } from '../../src/routes/index'
import { resetPool } from '../../src/storage/pool'

const DB_URL = process.env['OPENFGA_DB_URL']
const UNKNOWN_STORE_ID = '01ZZZZZZZZZZZZZZZZZZZZZZZZ'

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
    '[openfga integration] OPENFGA_DB_URL unreachable, unset, or migrations not applied — skipping store-not-found tests.',
  )
}

afterAll(() => {
  if (dbAvailable) resetPool()
})

const describeIfDb = dbAvailable ? describe : describe.skip

interface RouteCase {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  body?: unknown
}

describeIfDb('requireStore guard — 404 store_id_not_found on every /stores/:storeId/* route', () => {
  const app = buildApp()

  async function fetchRoute({ method, path, body }: RouteCase): Promise<Response> {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    return await app.fetch(new Request(`http://localhost${path}`, init))
  }

  // The full set of store-scoped routes implemented on develop. New
  // routes should auto-inherit the guard via the path-scoped
  // middleware mount, but they are added here as well for
  // completeness so a future regression that bypasses the mount is
  // caught loudly.
  const routes: Array<[string, RouteCase]> = [
    ['POST /authorization-models', {
      method: 'POST',
      path: `/stores/${UNKNOWN_STORE_ID}/authorization-models`,
      body: { type_definitions: [] },
    }],
    ['GET /authorization-models', {
      method: 'GET',
      path: `/stores/${UNKNOWN_STORE_ID}/authorization-models`,
    }],
    ['GET /authorization-models/:id', {
      method: 'GET',
      path: `/stores/${UNKNOWN_STORE_ID}/authorization-models/01ZZZZZZZZZZZZZZZZZZZZZZZZ`,
    }],
    ['POST /check', {
      method: 'POST',
      path: `/stores/${UNKNOWN_STORE_ID}/check`,
      body: { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' } },
    }],
    ['POST /write', {
      method: 'POST',
      path: `/stores/${UNKNOWN_STORE_ID}/write`,
      body: {
        deletes: { tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }] },
      },
    }],
    ['POST /read', {
      method: 'POST',
      path: `/stores/${UNKNOWN_STORE_ID}/read`,
      body: {},
    }],
    ['POST /list-objects', {
      method: 'POST',
      path: `/stores/${UNKNOWN_STORE_ID}/list-objects`,
      body: { type: 'doc', relation: 'viewer', user: 'user:alice' },
    }],
    ['POST /batch-check', {
      method: 'POST',
      path: `/stores/${UNKNOWN_STORE_ID}/batch-check`,
      body: {
        checks: [{ tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, correlation_id: 'c1' }],
      },
    }],
    ['POST /expand', {
      method: 'POST',
      path: `/stores/${UNKNOWN_STORE_ID}/expand`,
      body: { tuple_key: { object: 'doc:1', relation: 'viewer' } },
    }],
    ['POST /list-users', {
      method: 'POST',
      path: `/stores/${UNKNOWN_STORE_ID}/list-users`,
      body: {
        object: { type: 'doc', id: '1' },
        relation: 'viewer',
        user_filters: [{ type: 'user' }],
      },
    }],
    ['GET /changes', {
      method: 'GET',
      path: `/stores/${UNKNOWN_STORE_ID}/changes`,
    }],
    ['GET /assertions/:authorizationModelId', {
      method: 'GET',
      path: `/stores/${UNKNOWN_STORE_ID}/assertions/01ZZZZZZZZZZZZZZZZZZZZZZZZ`,
    }],
    ['PUT /assertions/:authorizationModelId', {
      method: 'PUT',
      path: `/stores/${UNKNOWN_STORE_ID}/assertions/01ZZZZZZZZZZZZZZZZZZZZZZZZ`,
      body: { assertions: [] },
    }],
  ]

  for (const [label, route] of routes) {
    it(`${label} returns 404 store_id_not_found for an unknown store`, async () => {
      const res = await fetchRoute(route)
      expect(res.status, label).toBe(404)
      const body = await res.json() as { code?: string }
      expect(body.code, label).toBe('store_id_not_found')
    })
  }
})
