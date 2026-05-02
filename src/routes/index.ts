/**
 * HTTP routes — wire-compatible with the OpenFGA reference server's
 * REST API for the surface this project implements.
 *
 * Implemented endpoints:
 *
 *   GET    /stores
 *   POST   /stores
 *   GET    /stores/:storeId/authorization-models
 *   POST   /stores/:storeId/authorization-models
 *   GET    /stores/:storeId/authorization-models/:id
 *   POST   /stores/:storeId/check
 *   POST   /stores/:storeId/write
 *   POST   /stores/:storeId/read
 *   POST   /stores/:storeId/list-objects
 *   POST   /stores/:storeId/batch-check
 *   POST   /stores/:storeId/expand
 *   POST   /stores/:storeId/list-users
 *   GET    /stores/:storeId/changes
 *   GET    /stores/:storeId/assertions/:authorizationModelId
 *   PUT    /stores/:storeId/assertions/:authorizationModelId
 *
 * The wire format must match `@openfga/sdk` byte-for-byte. The SDK
 * snake_cases everything, so the bodies and responses here do too.
 */
import { Hono } from 'hono'
import type { AuthorizationModel } from '@openfga/sdk'
import { transformer, errors as transformerErrors } from '@openfga/syntax-transformer'
import { createStore, listStoresPage } from '../storage/stores'
import { listChangesPage } from '../storage/tuples'
import { getAssertions, writeAssertions } from '../storage/assertions'
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
import { expand } from '../evaluator/expand'
import { listObjects } from '../evaluator/list-objects'
import { listUsers } from '../evaluator/list-users'
import { InMemoryTupleStore, unionTupleStore } from '../evaluator/tuple-store'
import type { TupleStore } from '../evaluator/tuple-store'
import { requestLog } from '../middleware/request-log'
import { idempotencyMiddleware } from '../middleware/idempotency'
import { authMiddleware, loadAuthConfigFromEnv } from '../middleware/auth'
import { validate } from '../middleware/validation'
import {
  BatchCheckBody,
  ChangesQuery,
  CheckBody,
  CreateStoreBody,
  ExpandBody,
  ListObjectsBody,
  ListStoresQuery,
  ListUsersBody,
  PageSizeQuery,
  ReadBody,
  WriteAssertionsBody,
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
 * Continuation tokens for /stores pagination are opaque to clients.
 * Encoding: base64(JSON({ created_at, id })). Anything that doesn't
 * decode cleanly into a {created_at, id} pair is a 400 — clients are
 * expected to round-trip the exact token the previous page returned.
 */
interface StoreCursor {
  created_at: string
  id: string
}

function encodeStoreCursor(c: StoreCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

function decodeStoreCursor(token: string): StoreCursor | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as StoreCursor).created_at === 'string'
      && typeof (parsed as StoreCursor).id === 'string'
    ) {
      return parsed as StoreCursor
    }
    return null
  }
  catch {
    return null
  }
}

/**
 * Continuation tokens for /changes pagination. Same opaque-base64url
 * pattern as StoreCursor — different cursor fields because the table
 * is ordered by (inserted_at, id) rather than (created_at, id).
 */
interface ChangeCursor {
  inserted_at: string
  id: string
}

function encodeChangeCursor(c: ChangeCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

function decodeChangeCursor(token: string): ChangeCursor | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as ChangeCursor).inserted_at === 'string'
      && typeof (parsed as ChangeCursor).id === 'string'
    ) {
      return parsed as ChangeCursor
    }
    return null
  }
  catch {
    return null
  }
}

/**
 * Build a request-scoped TupleStore overlay that holds OpenFGA
 * `contextual_tuples` for the duration of one check or list-objects
 * call. Returns the base store unchanged when no contextual tuples
 * are present so the hot path stays a single Postgres-backed store.
 *
 * Contextual tuples are never persisted — the overlay is discarded
 * once the response is sent, and `add()` only mutates in-memory
 * state on the InMemoryTupleStore instance.
 */
function withContextualTuples(
  base: TupleStore,
  contextual: ReadonlyArray<{ user: string, relation: string, object: string }> | undefined,
): TupleStore {
  if (!contextual || contextual.length === 0) return base
  const overlay = new InMemoryTupleStore()
  for (const t of contextual) {
    overlay.add(t.object, t.relation, t.user)
  }
  return unionTupleStore(base, overlay)
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
  app.get('/stores', validate('query', ListStoresQuery), async (c) => {
    const { page_size, continuation_token } = c.req.valid('query')
    const pageSize = Math.min(Math.max(page_size ?? 50, 1), 100)
    let cursor: StoreCursor | null = null
    if (continuation_token !== undefined && continuation_token.length > 0) {
      cursor = decodeStoreCursor(continuation_token)
      if (cursor === null) {
        return c.json({ code: 'invalid_argument', message: 'continuation_token is malformed' }, 400)
      }
    }
    const page = await listStoresPage(pageSize, cursor)
    return c.json({
      stores: page.rows.map(r => ({
        id: r.id,
        name: r.name,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      continuation_token: page.nextCursor === null ? '' : encodeStoreCursor(page.nextCursor),
    })
  })

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
    const store = withContextualTuples(pgTupleStore(storeId), body.contextual_tuples?.tuple_keys)
    const allowed = await check(ctx.index, store, tk.user, tk.relation, tk.object)
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
    const store = withContextualTuples(pgTupleStore(storeId), body.contextual_tuples?.tuple_keys)
    const ids = await listObjects(ctx.index, store, body.user, body.relation, body.type)
    return c.json({ objects: ids.map(id => `${body.type}:${id}`) })
  })

  // ─── List users ─────────────────────────────────────────────────
  app.post('/stores/:storeId/list-users', validate('json', ListUsersBody), async (c) => {
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

  // ─── Expand ─────────────────────────────────────────────────────
  app.post('/stores/:storeId/expand', validate('json', ExpandBody), async (c) => {
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

  // ─── Batch check ────────────────────────────────────────────────
  app.post('/stores/:storeId/batch-check', validate('json', BatchCheckBody), async (c) => {
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
        // errors (malformed tuple_key, bad correlation_id) are caught
        // at the validation boundary before this handler runs.
        result[item.correlation_id] = {
          error: { internal_error: err instanceof Error ? err.message : 'check failed' },
        }
      }
    }
    return c.json({ result })
  })

  // ─── Assertions ─────────────────────────────────────────────────
  app.get('/stores/:storeId/assertions/:authorizationModelId', async (c) => {
    const storeId = c.req.param('storeId')
    const authorizationModelId = c.req.param('authorizationModelId')
    // Validate the model pin exists; the SDK expects 404 when an
    // unknown model is referenced rather than a silently-empty
    // response. getAuthorizationModel scopes by store too, so a
    // mismatched store-id surfaces as 404 here.
    const model = await getAuthorizationModel(storeId, authorizationModelId)
    if (!model) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)

    const assertions = await getAssertions(storeId, authorizationModelId)
    return c.json({ authorization_model_id: authorizationModelId, assertions })
  })

  app.put(
    '/stores/:storeId/assertions/:authorizationModelId',
    validate('json', WriteAssertionsBody),
    async (c) => {
      const storeId = c.req.param('storeId')
      const authorizationModelId = c.req.param('authorizationModelId')
      const model = await getAuthorizationModel(storeId, authorizationModelId)
      if (!model) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)

      const body = c.req.valid('json')
      await writeAssertions(storeId, authorizationModelId, body.assertions)
      // OpenFGA returns 204 No Content on a successful PUT. Hono's
      // c.body(null, 204) sends an empty body with the status.
      return c.body(null, 204)
    },
  )
  // ─── Changes ────────────────────────────────────────────────────
  app.get('/stores/:storeId/changes', validate('query', ChangesQuery), async (c) => {
    const storeId = c.req.param('storeId')
    const { type, page_size, continuation_token, start_time } = c.req.valid('query')
    const pageSize = Math.min(Math.max(page_size ?? 50, 1), 100)
    let cursor: ChangeCursor | null = null
    if (continuation_token !== undefined && continuation_token.length > 0) {
      cursor = decodeChangeCursor(continuation_token)
      if (cursor === null) {
        return c.json({ code: 'invalid_argument', message: 'continuation_token is malformed' }, 400)
      }
    }
    const page = await listChangesPage(storeId, pageSize, cursor, {
      objectType: type,
      startTime: start_time,
    })
    return c.json({
      changes: page.rows.map((r) => ({
        tuple_key: {
          user: r.user_str,
          relation: r.relation,
          object: `${r.object_type}:${r.object_id}`,
        },
        operation: r.operation,
        timestamp: r.inserted_at,
      })),
      continuation_token: page.nextCursor === null ? '' : encodeChangeCursor(page.nextCursor),
    })
  })

  return app
}
