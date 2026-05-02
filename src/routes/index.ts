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
import type { AuthorizationModel } from '@openfga/sdk'
import { transformer, errors as transformerErrors } from '@openfga/syntax-transformer'
import { createStore } from '../storage/stores'
import {
  getAuthorizationModel,
  listAuthorizationModels,
  writeAuthorizationModel,
} from '../storage/authorization-models'
import { getStore } from '../storage/stores'
import {
  DuplicateTupleError,
  InvalidObjectReferenceError,
  MissingTupleError,
  applyTupleMutations,
  readTuples,
  type TupleConflictMode,
} from '../storage/tuples'
import { loadModelIndex, pgTupleStore } from '../storage/engine-context'
import { check } from '../evaluator/check'
import { listObjects } from '../evaluator/list-objects'
import { requestLog } from '../middleware/request-log'
import { idempotencyMiddleware } from '../middleware/idempotency'
import { authMiddleware, loadAuthConfigFromEnv } from '../middleware/auth'
import { validate } from '../middleware/validation'
import {
  CheckBody,
  CreateStoreBody,
  ListObjectsBody,
  PageSizeQuery,
  ReadBody,
  WriteAuthorizationModelBody,
  WriteBody,
} from './schemas'
import { validateWriteTupleKey } from './write-validation'

/**
 * True when the Content-Type advertises an OpenFGA DSL body.
 *
 * `application/x-openfga-dsl` is the preferred type. `text/plain` is
 * accepted as a fallback because curl, ad-hoc scripts, and many
 * static-file servers default to it. Parameters such as `; charset=utf-8`
 * are tolerated per RFC 7231 §3.1.1.1.
 */
function isDslContentType(header: string | undefined): boolean {
  if (!header) return false
  const type = header.split(';', 1)[0]!.trim().toLowerCase()
  return type === 'application/x-openfga-dsl' || type === 'text/plain'
}

/**
 * Render a transformer error as a client-facing message. The
 * transformer's syntax/validation errors carry zero-based line and
 * column information; this surfaces 1-based positions because that is
 * what almost every editor reports and what is least surprising to a
 * human reading the response.
 */
function formatDslError(err: unknown): string {
  if (err instanceof transformerErrors.DSLSyntaxError && err.errors.length > 0) {
    const first = err.errors[0]!
    const line = first.line ? first.line.start + 1 : undefined
    const col = first.column ? first.column.start + 1 : undefined
    if (line !== undefined && col !== undefined) {
      return `DSL parse error at line ${line}, column ${col}: ${first.msg}`
    }
    return `DSL parse error: ${first.msg}`
  }
  if (err instanceof transformerErrors.ModelValidationError && err.errors.length > 0) {
    const first = err.errors[0]!
    const line = first.line ? first.line.start + 1 : undefined
    const col = first.column ? first.column.start + 1 : undefined
    if (line !== undefined && col !== undefined) {
      return `DSL validation error at line ${line}, column ${col}: ${first.msg}`
    }
    return `DSL validation error: ${first.msg}`
  }
  if (err instanceof Error) return `DSL error: ${err.message}`
  return 'DSL error'
}

export function buildApp(): Hono {
  const app = new Hono()

  app.use('*', requestLog)

  // Caller authentication. Mounted on /stores/* so /health stays
  // reachable for liveness probes without credentials. Mode is
  // chosen at boot from OPENFGA_AUTH_MODE; see src/middleware/auth.ts
  // for the dispatch and the supported modes.
  app.use('/stores/*', authMiddleware(loadAuthConfigFromEnv()))

  // Idempotency-Key support for the three mutating endpoints in scope
  // (PRD §"Idempotency keys", docs/features/idemnpotency-keys.md).
  // Mode and TTL are read from OPENFGA_IDEMPOTENCY_MODE /
  // OPENFGA_IDEMPOTENCY_TTL_MS at first request. Default mode is 'off'
  // so existing clients are not affected until idempotency is enabled.
  app.use(
    '*',
    idempotencyMiddleware({
      scopes: [
        { method: 'POST', path: '/stores' },
        { method: 'POST', path: '/stores/:storeId/authorization-models' },
        { method: 'POST', path: '/stores/:storeId/write' },
      ],
    }),
  )

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // ─── Stores ─────────────────────────────────────────────────────
  app.post('/stores', validate('json', CreateStoreBody), async (c) => {
    const body = c.req.valid('json')
    const row = await createStore(body.name.trim())
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

    let model: Partial<AuthorizationModel>
    if (isDslContentType(c.req.header('content-type'))) {
      // DSL branch — driven by Red Planet's deploy-from-.fga use case.
      // The transformer is the same one src/cli/load-model.ts uses; the
      // resulting JSON feeds the existing JSON path verbatim, so the
      // storage layer never sees DSL.
      let dsl: string
      try {
        dsl = await c.req.text()
      }
      catch {
        return c.json({ code: 'invalid_argument', message: 'failed to read DSL request body' }, 400)
      }
      try {
        model = transformer.transformDSLToJSONObject(dsl) as Partial<AuthorizationModel>
      }
      catch (err) {
        return c.json({ code: 'invalid_argument', message: formatDslError(err) }, 400)
      }
    }
    else {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = WriteAuthorizationModelBody.safeParse(raw)
      if (!parsed.success) {
        return c.json({ code: 'invalid_argument', message: 'request validation failed' }, 400)
      }
      model = parsed.data as Partial<AuthorizationModel>
    }

    if (!Array.isArray(model.type_definitions)) {
      return c.json({ code: 'invalid_argument', message: 'type_definitions required' }, 400)
    }
    const row = await writeAuthorizationModel(storeId, {
      schema_version: model.schema_version ?? '1.1',
      type_definitions: model.type_definitions,
      conditions: model.conditions,
    })
    return c.json({ authorization_model_id: row.id })
  })

  app.get('/stores/:storeId/authorization-models', validate('query', PageSizeQuery), async (c) => {
    const storeId = c.req.param('storeId')
    const store = await getStore(storeId)
    if (!store) return c.json({ code: 'not_found', message: 'store not found' }, 404)

    const { page_size } = c.req.valid('query')
    const pageSize = Math.min(page_size ?? 50, 100)
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
  app.post('/stores/:storeId/check', validate('json', CheckBody), async (c) => {
    const storeId = c.req.param('storeId')
    const body = c.req.valid('json')
    const tk = body.tuple_key
    const ctx = await loadModelIndex(storeId, body.authorization_model_id)
    if (!ctx) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)
    const allowed = await check(ctx.index, pgTupleStore(storeId), tk.user, tk.relation, tk.object)
    return c.json({ allowed })
  })

  // ─── Write ──────────────────────────────────────────────────────
  app.post('/stores/:storeId/write', validate('json', WriteBody), async (c) => {
    const storeId = c.req.param('storeId')
    const body = c.req.valid('json')
    const writes = body.writes?.tuple_keys ?? []
    const deletes = body.deletes?.tuple_keys ?? []

    const onDuplicate = body.writes?.on_duplicate ?? 'error'
    const onMissing = body.deletes?.on_missing ?? 'error'

    const ctx = writes.length > 0 || body.authorization_model_id
      ? await loadModelIndex(storeId, body.authorization_model_id)
      : null
    if ((writes.length > 0 || body.authorization_model_id) && !ctx) {
      return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)
    }

    if (ctx) {
      for (const tuple of writes) {
        const invalid = validateWriteTupleKey(ctx.index, tuple)
        if (invalid) return c.json({ code: 'invalid_argument', message: invalid }, 400)
      }
    }

    try {
      await applyTupleMutations(storeId, {
        writes,
        deletes,
        onDuplicate: onDuplicate as TupleConflictMode,
        onMissing: onMissing as TupleConflictMode,
      })
    }
    catch (err) {
      if (err instanceof DuplicateTupleError || err instanceof MissingTupleError) {
        return c.json({ code: 'conflict', message: err.message }, 409)
      }
      throw err
    }
    return c.json({})
  })

  // ─── Read ───────────────────────────────────────────────────────
  app.post('/stores/:storeId/read', validate('json', ReadBody), async (c) => {
    const storeId = c.req.param('storeId')
    const body = c.req.valid('json')
    const tk = body.tuple_key
    let rows
    try {
      rows = await readTuples(storeId, {
        object: tk?.object,
        relation: tk?.relation,
        user: tk?.user,
        pageSize: body.page_size,
      })
    }
    catch (err) {
      if (err instanceof InvalidObjectReferenceError) {
        return c.json({ code: 'invalid_argument', message: err.message }, 400)
      }
      throw err
    }
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
  app.post('/stores/:storeId/list-objects', validate('json', ListObjectsBody), async (c) => {
    const storeId = c.req.param('storeId')
    const body = c.req.valid('json')
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
