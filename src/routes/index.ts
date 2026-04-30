/**
 * HTTP routes — wire-compatible with the OpenFGA reference server's
 * REST API for the surface this project implements.
 *
 * Implemented endpoints:
 *
 *   POST   /stores
 *   GET    /stores/:storeId/authorization-models
 *   POST   /stores/:storeId/authorization-models
 *   GET    /stores/:storeId/authorization-models/:id
 *   POST   /stores/:storeId/check
 *   POST   /stores/:storeId/write
 *   POST   /stores/:storeId/read
 *   POST   /stores/:storeId/list-objects
 *
 * Endpoints NOT implemented (return 501):
 *
 *   GET    /stores
 *   POST   /stores/:storeId/expand
 *   POST   /stores/:storeId/batch-check
 *   POST   /stores/:storeId/list-users
 *   POST   /stores/:storeId/assertions
 *   GET    /stores/:storeId/changes
 *
 * The wire format must match `@openfga/sdk` byte-for-byte. The SDK
 * snake_cases everything, so the bodies and responses here do too.
 */
import { Hono } from 'hono'
import type { CheckRequest, ListObjectsRequest, ReadRequest, WriteRequest, AuthorizationModel } from '@openfga/sdk'
import { createStore } from '../storage/stores'
import {
  getAuthorizationModel,
  listAuthorizationModels,
  writeAuthorizationModel,
} from '../storage/authorization-models'
import { getStore } from '../storage/stores'
import { readTuples, writeTuples, deleteTuples } from '../storage/tuples'
import { loadModelIndex, pgTupleStore } from '../storage/engine-context'
import { check } from '../evaluator/check'
import { listObjects } from '../evaluator/list-objects'

export function buildApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // ─── Stores ─────────────────────────────────────────────────────
  app.post('/stores', async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
    const name = body?.name?.trim()
    if (!name) return c.json({ code: 'invalid_argument', message: 'name is required' }, 400)
    const row = await createStore(name)
    return c.json({
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })
  })

  // ─── Authorization models ───────────────────────────────────────
  app.post('/stores/:storeId/authorization-models', async (c) => {
    const storeId = c.req.param('storeId')
    const store = await getStore(storeId)
    if (!store) return c.json({ code: 'not_found', message: 'store not found' }, 404)

    const body = await c.req.json<Partial<AuthorizationModel>>().catch(() => ({} as Partial<AuthorizationModel>))
    if (!Array.isArray(body.type_definitions)) {
      return c.json({ code: 'invalid_argument', message: 'type_definitions required' }, 400)
    }
    const row = await writeAuthorizationModel(storeId, {
      schema_version: body.schema_version ?? '1.1',
      type_definitions: body.type_definitions,
      conditions: body.conditions,
    })
    return c.json({ authorization_model_id: row.id })
  })

  app.get('/stores/:storeId/authorization-models', async (c) => {
    const storeId = c.req.param('storeId')
    const store = await getStore(storeId)
    if (!store) return c.json({ code: 'not_found', message: 'store not found' }, 404)

    const pageSize = Math.min(Number(c.req.query('page_size') ?? 50), 100)
    const rows = await listAuthorizationModels(storeId, pageSize)
    return c.json({
      authorization_models: rows.map(r => ({
        id: r.id,
        schema_version: r.schema_version,
        type_definitions: r.type_definitions,
        conditions: r.conditions ?? undefined,
      })),
      continuation_token: '',
    })
  })

  app.get('/stores/:storeId/authorization-models/:id', async (c) => {
    const storeId = c.req.param('storeId')
    const id = c.req.param('id')
    const row = await getAuthorizationModel(storeId, id)
    if (!row) return c.json({ code: 'not_found', message: 'model not found' }, 404)
    return c.json({
      authorization_model: {
        id: row.id,
        schema_version: row.schema_version,
        type_definitions: row.type_definitions,
        conditions: row.conditions ?? undefined,
      },
    })
  })

  // ─── Check ──────────────────────────────────────────────────────
  app.post('/stores/:storeId/check', async (c) => {
    const storeId = c.req.param('storeId')
    const body = await c.req.json<CheckRequest>().catch(() => ({} as CheckRequest))
    const tk = body?.tuple_key
    if (!tk?.user || !tk.relation || !tk.object) {
      return c.json({ code: 'invalid_argument', message: 'tuple_key.user, .relation, .object required' }, 400)
    }
    const ctx = await loadModelIndex(storeId, body.authorization_model_id)
    if (!ctx) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)
    const allowed = await check(ctx.index, pgTupleStore(storeId), tk.user, tk.relation, tk.object)
    return c.json({ allowed })
  })

  // ─── Write ──────────────────────────────────────────────────────
  app.post('/stores/:storeId/write', async (c) => {
    const storeId = c.req.param('storeId')
    const body = await c.req.json<WriteRequest>().catch(() => ({} as WriteRequest))
    const writes = body?.writes?.tuple_keys ?? []
    const deletes = body?.deletes?.tuple_keys ?? []
    if (writes.length === 0 && deletes.length === 0) {
      return c.json({ code: 'invalid_argument', message: 'writes or deletes required' }, 400)
    }
    if (writes.length > 0) await writeTuples(storeId, writes)
    if (deletes.length > 0) await deleteTuples(storeId, deletes)
    return c.json({})
  })

  // ─── Read ───────────────────────────────────────────────────────
  app.post('/stores/:storeId/read', async (c) => {
    const storeId = c.req.param('storeId')
    const body = await c.req.json<ReadRequest>().catch(() => ({} as ReadRequest))
    const tk = body?.tuple_key
    const rows = await readTuples(storeId, {
      object: tk?.object,
      relation: tk?.relation,
      user: tk?.user,
      pageSize: body?.page_size,
    })
    return c.json({
      tuples: rows.map(r => ({
        key: {
          user: r.user_str,
          relation: r.relation,
          object: `${r.object_type}:${r.object_id}`,
        },
        timestamp: r.inserted_at,
      })),
      continuation_token: '',
    })
  })

  // ─── List objects ───────────────────────────────────────────────
  app.post('/stores/:storeId/list-objects', async (c) => {
    const storeId = c.req.param('storeId')
    const body = await c.req.json<ListObjectsRequest>().catch(() => ({} as ListObjectsRequest))
    if (!body?.type || !body.relation || !body.user) {
      return c.json({ code: 'invalid_argument', message: 'type, relation, user required' }, 400)
    }
    const ctx = await loadModelIndex(storeId, body.authorization_model_id)
    if (!ctx) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)
    const ids = await listObjects(ctx.index, pgTupleStore(storeId), body.user, body.relation, body.type)
    return c.json({ objects: ids.map(id => `${body.type}:${id}`) })
  })

  // ─── Not implemented ────────────────────────────────────────────
  for (const path of [
    '/stores/:storeId/expand',
    '/stores/:storeId/batch-check',
    '/stores/:storeId/list-users',
    '/stores/:storeId/assertions',
  ] as const) {
    app.post(path, c => c.json({ code: 'not_implemented', message: `${path} is not implemented` }, 501))
  }
  app.get('/stores', c => c.json({ code: 'not_implemented', message: 'GET /stores is not implemented' }, 501))
  app.get('/stores/:storeId/changes', c => c.json({ code: 'not_implemented', message: 'changes is not implemented' }, 501))

  return app
}
