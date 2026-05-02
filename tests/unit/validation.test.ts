/**
 * Unit tests for the route-level Zod validation boundary.
 *
 * These tests focus on validation rejection paths so they short-circuit
 * before reaching storage and don't need a live database. The acceptance
 * tests for valid-request behavior live alongside each endpoint's
 * existing integration test.
 *
 * Spec: docs/features/request-validation.md
 */
import { describe, expect, it, vi } from 'vitest'

// The requireStore middleware (openfga-rv0) calls getStore() on
// every /stores/:storeId/* request. These tests intentionally
// isolate the validation layer; mock storage so the middleware
// lets requests pass through to the validators.
vi.mock('../../src/storage/stores', () => ({
  getStore: vi.fn().mockResolvedValue({
    id: 'stub',
    name: 'stub',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  }),
  createStore: vi.fn(),
  listStoresPage: vi.fn(),
}))

const { buildApp } = await import('../../src/routes/index')
const app = buildApp()

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function postRaw(path: string, raw: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  })
}

async function expectInvalidArgument(res: Response): Promise<void> {
  expect(res.status).toBe(400)
  const body = await res.json() as { code: string, message: string }
  expect(body.code).toBe('invalid_argument')
  expect(typeof body.message).toBe('string')
}

describe('request validation — POST /stores', () => {
  it('rejects empty body (missing name)', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores', {})))
  })

  it('rejects empty name', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores', { name: '' })))
  })

  it('rejects whitespace-only name', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores', { name: '   ' })))
  })

  it('rejects non-string name', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores', { name: 42 })))
  })
})

describe('request validation — POST /stores/:storeId/check', () => {
  it('rejects empty body (missing tuple_key)', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores/abc/check', {})))
  })

  it('rejects tuple_key with missing fields', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/check', { tuple_key: { user: 'user:alice' } })),
    )
  })

  it('rejects malformed object reference (no colon)', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/check', {
        tuple_key: { user: 'user:alice', relation: 'viewer', object: 'missing-colon' },
      })),
    )
  })
})

describe('request validation — POST /stores/:storeId/write', () => {
  it('rejects body with neither writes nor deletes', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores/abc/write', {})))
  })

  it('rejects writes with empty tuple_keys array', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/write', { writes: { tuple_keys: [] } })),
    )
  })

  it('rejects malformed object reference in deletes', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/write', {
        deletes: {
          tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'no-colon' }],
        },
      })),
    )
  })

  it('rejects unknown on_duplicate value', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/write', {
        writes: {
          tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
          on_duplicate: 'replace',
        },
      })),
    )
  })
})

describe('request validation — POST /stores/:storeId/read', () => {
  it('rejects malformed object reference', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/read', { tuple_key: { object: 'no-colon' } })),
    )
  })

  it('rejects negative page_size', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/read', { page_size: -1 })),
    )
  })
})

describe('request validation — POST /stores/:storeId/list-objects', () => {
  it('rejects empty body (missing type, relation, user)', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores/abc/list-objects', {})))
  })

  it('rejects body with only some required fields', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/list-objects', { type: 'doc', relation: 'viewer' })),
    )
  })
})

describe('request validation — malformed JSON', () => {
  it('returns invalid_argument for unparseable JSON body on /stores', async () => {
    await expectInvalidArgument(await app.fetch(postRaw('/stores', '{ this is not json')))
  })
})

describe('request validation — unknown fields are passed through', () => {
  it('accepts forward-compatible OpenFGA fields without rejecting', async () => {
    // contextual_tuples, context, trace, consistency are part of the
    // OpenFGA wire contract that this server allows but does not yet
    // read. They must not be rejected by the validation boundary.
    const res = await app.fetch(postJson('/stores/abc/check', {
      tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      authorization_model_id: 'fake-model-id',
      contextual_tuples: { tuple_keys: [] },
      context: { ip: '127.0.0.1' },
      trace: true,
      consistency: 'MINIMIZE_LATENCY',
    }))
    // Validation passes — the request reaches the route handler, which
    // then 404s because the store/model doesn't exist. The test asserts
    // that we did NOT get a 400 invalid_argument from validation.
    expect(res.status).not.toBe(400)
  })
})
