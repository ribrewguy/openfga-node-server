/**
 * Evaluation routes — the read-shaped OpenFGA endpoints that compute
 * over the authorization model + tuple store:
 *
 *   POST /stores/:storeId/check         single check
 *   POST /stores/:storeId/batch-check   correlated batch of checks
 *   POST /stores/:storeId/expand        userset-tree expansion
 *   POST /stores/:storeId/list-objects  objects of `type` the user has `relation` on
 *   POST /stores/:storeId/list-users    users with `relation` on a given object
 */
import { Hono } from 'hono'
import { check } from '../evaluator/check'
import { expand } from '../evaluator/expand'
import { listObjects } from '../evaluator/list-objects'
import { listUsers } from '../evaluator/list-users'
import { loadModelIndex, pgTupleStore } from '../storage/engine-context'
import { validate } from '../middleware/validation'
import {
  BatchCheckBody,
  CheckBody,
  ExpandBody,
  ListObjectsBody,
  ListUsersBody,
} from './schemas'
import { withContextualTuples } from './_helpers/contextual-tuples'

export const evaluationRoutes = new Hono()

evaluationRoutes.post('/stores/:storeId/check', validate('json', CheckBody), async (c) => {
  const storeId = c.req.param('storeId')
  const body = c.req.valid('json')
  const tk = body.tuple_key
  const ctx = await loadModelIndex(storeId, body.authorization_model_id)
  if (!ctx) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)
  const store = withContextualTuples(pgTupleStore(storeId), body.contextual_tuples?.tuple_keys)
  const allowed = await check(ctx.index, store, tk.user, tk.relation, tk.object)
  return c.json({ allowed })
})

evaluationRoutes.post('/stores/:storeId/list-objects', validate('json', ListObjectsBody), async (c) => {
  const storeId = c.req.param('storeId')
  const body = c.req.valid('json')
  const ctx = await loadModelIndex(storeId, body.authorization_model_id)
  if (!ctx) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)
  const store = withContextualTuples(pgTupleStore(storeId), body.contextual_tuples?.tuple_keys)
  const ids = await listObjects(ctx.index, store, body.user, body.relation, body.type)
  return c.json({ objects: ids.map(id => `${body.type}:${id}`) })
})

evaluationRoutes.post('/stores/:storeId/list-users', validate('json', ListUsersBody), async (c) => {
  const storeId = c.req.param('storeId')
  const body = c.req.valid('json')
  const ctx = await loadModelIndex(storeId, body.authorization_model_id)
  if (!ctx) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)

  // ListUsersRequest's contextual_tuples is a flat array (unlike
  // check/list-objects) — adapt to the same overlay helper.
  const store = withContextualTuples(pgTupleStore(storeId), body.contextual_tuples)
  const users = await listUsers(
    ctx.index,
    store,
    body.object.type,
    body.object.id,
    body.relation,
    body.user_filters[0]!,
  )
  if (users === null) {
    return c.json({
      code: 'invalid_argument',
      message: `relation "${body.relation}" is not defined for type "${body.object.type}"`,
    }, 400)
  }
  return c.json({ users })
})

evaluationRoutes.post('/stores/:storeId/expand', validate('json', ExpandBody), async (c) => {
  const storeId = c.req.param('storeId')
  const body = c.req.valid('json')
  const ctx = await loadModelIndex(storeId, body.authorization_model_id)
  if (!ctx) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)

  const { type: objectType, id: objectId } = (() => {
    const idx = body.tuple_key.object.indexOf(':')
    return { type: body.tuple_key.object.slice(0, idx), id: body.tuple_key.object.slice(idx + 1) }
  })()

  if (objectId === '') {
    return c.json({ code: 'invalid_argument', message: 'tuple_key.object must be a full type:id reference' }, 400)
  }

  const store = withContextualTuples(pgTupleStore(storeId), body.contextual_tuples?.tuple_keys)
  const root = await expand(ctx.index, store, objectType, objectId, body.tuple_key.relation)
  if (root === null) {
    return c.json({
      code: 'invalid_argument',
      message: `relation "${body.tuple_key.relation}" is not defined for type "${objectType}"`,
    }, 400)
  }
  return c.json({ tree: { root } })
})

evaluationRoutes.post('/stores/:storeId/batch-check', validate('json', BatchCheckBody), async (c) => {
  const storeId = c.req.param('storeId')
  const body = c.req.valid('json')
  const ctx = await loadModelIndex(storeId, body.authorization_model_id)
  if (!ctx) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)

  const result: Record<string, { allowed?: boolean, error?: { internal_error: string } }> = {}
  for (const item of body.checks) {
    const store = withContextualTuples(pgTupleStore(storeId), item.contextual_tuples?.tuple_keys)
    try {
      const allowed = await check(
        ctx.index,
        store,
        item.tuple_key.user,
        item.tuple_key.relation,
        item.tuple_key.object,
      )
      result[item.correlation_id] = { allowed }
    }
    catch (err) {
      // Per-item errors do not fail the whole batch — clients receive
      // the success/failure of each item by correlation_id. Shape
      // errors (malformed tuple_key, bad correlation_id) are caught at
      // the validation boundary before this handler runs.
      result[item.correlation_id] = {
        error: { internal_error: err instanceof Error ? err.message : 'check failed' },
      }
    }
  }
  return c.json({ result })
})
