/**
 * Integration tests for POST /stores/:storeId/expand.
 *
 * Pinned by openfga-5xn: confirms the route returns the OpenFGA
 * UsersetTree envelope, contextual_tuples flow through to the
 * evaluator, and 404 surfaces for an unknown model. Per-rewrite-shape
 * coverage lives in the expand evaluator unit tests.
 *
 * Skips silently when OPENFGA_DB_URL is unreachable.
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
    '[openfga integration] OPENFGA_DB_URL unreachable, unset, or migrations not applied — skipping expand tests.',
  )
}

afterAll(() => {
  if (dbAvailable) resetDb()
})

const describeIfDb = dbAvailable ? describe : describe.skip

interface ExpandResponse {
  tree: { root: { name: string, leaf?: { users?: { users: string[] } } } }
}

describeIfDb('POST /stores/:storeId/expand', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`expand-${Date.now()}-${Math.random()}`)
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
      ],
    })
    return { app, storeId: store.id, modelId: model.id }
  }

  function expandReq(storeId: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/expand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns a tree.root with persisted direct grants under leaf.users.users', async () => {
    const { app, storeId, modelId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
    ])

    const res = await app.fetch(expandReq(storeId, {
      authorization_model_id: modelId,
      tuple_key: { object: 'doc:1', relation: 'viewer' },
    }))
    expect(res.status).toBe(200)
    const json = await res.json() as ExpandResponse
    expect(json.tree.root.name).toBe('doc:1#viewer')
    expect((json.tree.root.leaf?.users?.users ?? []).sort()).toEqual(['user:alice', 'user:bob'])
  })

  it('includes contextual_tuples in the leaf without persisting them', async () => {
    const { app, storeId, modelId } = await setup()

    const res = await app.fetch(expandReq(storeId, {
      authorization_model_id: modelId,
      tuple_key: { object: 'doc:1', relation: 'viewer' },
      contextual_tuples: { tuple_keys: [{ user: 'user:carol', relation: 'viewer', object: 'doc:1' }] },
    }))
    expect(res.status).toBe(200)
    const json = await res.json() as ExpandResponse
    expect(json.tree.root.leaf?.users?.users).toEqual(['user:carol'])
  })

  it('returns 404 when the requested authorization_model_id does not exist', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(expandReq(storeId, {
      authorization_model_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
      tuple_key: { object: 'doc:1', relation: 'viewer' },
    }))
    expect(res.status).toBe(404)
  })

  it('returns 400 when the requested relation is not defined on the type', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(expandReq(storeId, {
      authorization_model_id: modelId,
      tuple_key: { object: 'doc:1', relation: 'editor' },
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })

  it('rejects type-only object filters at the route boundary (expand needs a full type:id)', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(expandReq(storeId, {
      authorization_model_id: modelId,
      tuple_key: { object: 'doc:', relation: 'viewer' },
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })
})
