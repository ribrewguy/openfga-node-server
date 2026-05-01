import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypeDefinition } from '@openfga/sdk'
import { ModelIndex } from '../../src/evaluator/model-index'

const applyTupleMutations = vi.fn()
const loadModelIndex = vi.fn()

vi.mock('../../src/storage/stores', () => ({
  createStore: vi.fn(),
  getStore: vi.fn(),
}))

vi.mock('../../src/storage/authorization-models', () => ({
  getAuthorizationModel: vi.fn(),
  listAuthorizationModels: vi.fn(),
  writeAuthorizationModel: vi.fn(),
}))

vi.mock('../../src/storage/tuples', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/tuples')>()
  return {
    ...actual,
    applyTupleMutations,
    readTuples: vi.fn(),
    writeTuples: vi.fn(),
    deleteTuples: vi.fn(),
  }
})

vi.mock('../../src/storage/engine-context', () => ({
  loadModelIndex,
  pgTupleStore: vi.fn(),
}))

const { DuplicateTupleError } = await import('../../src/storage/tuples')
const { buildApp } = await import('../../src/routes/index')

const userType: TypeDefinition = { type: 'user' }
const modelIndex = new ModelIndex([
  userType,
  {
    type: 'doc',
    relations: { viewer: { this: {} } },
    metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
  },
])

function writeRequest(body: unknown): Request {
  return new Request('http://localhost/stores/store-1/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('write route', () => {
  beforeEach(() => {
    applyTupleMutations.mockReset()
    loadModelIndex.mockReset()
    loadModelIndex.mockResolvedValue({ modelId: 'model-1', index: modelIndex })
    delete process.env['OPENFGA_AUTH_MODE']
    delete process.env['OPENFGA_IDEMPOTENCY_MODE']
  })

  it('loads the requested authorization model and rejects tuple keys outside the model', async () => {
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      authorization_model_id: 'model-1',
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'editor', object: 'doc:1' }],
      },
    }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'invalid_argument',
      message: 'relation "editor" is not defined for type "doc"',
    })
    expect(loadModelIndex).toHaveBeenCalledWith('store-1', 'model-1')
    expect(applyTupleMutations).not.toHaveBeenCalled()
  })

  it('returns not found when the requested authorization model is missing', async () => {
    loadModelIndex.mockResolvedValueOnce(null)
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      authorization_model_id: 'missing',
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      },
    }))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 'not_found', message: 'authorization model not found' })
    expect(applyTupleMutations).not.toHaveBeenCalled()
  })

  it('rejects malformed delete tuple keys before storage mutation', async () => {
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      deletes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'missing-colon' }],
      },
    }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'invalid_argument',
      message: 'invalid object reference "missing-colon"',
    })
    expect(applyTupleMutations).not.toHaveBeenCalled()
  })

  it('does not require authorization model lookup for delete-only requests without a model id', async () => {
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      deletes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
        on_missing: 'ignore',
      },
    }))

    expect(res.status).toBe(200)
    expect(loadModelIndex).not.toHaveBeenCalled()
    expect(applyTupleMutations).toHaveBeenCalledWith('store-1', {
      writes: [],
      deletes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      onDuplicate: 'error',
      onMissing: 'ignore',
    })
  })

  it('passes conflict options to the transactional tuple mutation boundary', async () => {
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
        on_duplicate: 'ignore',
      },
      deletes: {
        tuple_keys: [{ user: 'user:bob', relation: 'viewer', object: 'doc:2' }],
        on_missing: 'ignore',
      },
    }))

    expect(res.status).toBe(200)
    expect(applyTupleMutations).toHaveBeenCalledWith('store-1', {
      writes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      deletes: [{ user: 'user:bob', relation: 'viewer', object: 'doc:2' }],
      onDuplicate: 'ignore',
      onMissing: 'ignore',
    })
  })

  it('maps duplicate tuple conflicts to a conflict response', async () => {
    applyTupleMutations.mockRejectedValueOnce(
      new DuplicateTupleError({ user: 'user:alice', relation: 'viewer', object: 'doc:1' }),
    )
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      },
    }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      code: 'conflict',
      message: 'tuple already exists: user:alice viewer doc:1',
    })
  })
})
