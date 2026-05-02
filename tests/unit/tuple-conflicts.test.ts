import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const release = vi.fn()
const connect = vi.fn(() => ({ query, release }))

vi.mock('../../src/storage/pool', () => ({
  getPool: () => ({ connect }),
}))

const {
  DuplicateTupleError,
  MissingTupleError,
  applyTupleMutations,
} = await import('../../src/storage/tuples')

describe('tuple mutation conflict handling', () => {
  beforeEach(() => {
    query.mockReset()
    release.mockReset()
    connect.mockClear()
  })

  it('rolls back duplicate writes by default', async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({})

    await expect(applyTupleMutations('store-1', {
      writes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      deletes: [],
      onDuplicate: 'error',
      onMissing: 'error',
    })).rejects.toBeInstanceOf(DuplicateTupleError)

    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO openfga.tuple'),
      'ROLLBACK',
    ])
    expect(release).toHaveBeenCalledOnce()
  })

  it('ignores duplicate writes when requested', async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({})

    await applyTupleMutations('store-1', {
      writes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      deletes: [],
      onDuplicate: 'ignore',
      onMissing: 'error',
    })

    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO openfga.tuple'),
      'COMMIT',
    ])
  })

  it('rolls back missing deletes by default after earlier writes in the same request', async () => {
    query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT tuple — success
      .mockResolvedValueOnce({}) // INSERT tuple_change (write) — recorded transactionally
      .mockResolvedValueOnce({ rowCount: 0 }) // DELETE tuple — missing
      .mockResolvedValueOnce({}) // ROLLBACK

    await expect(applyTupleMutations('store-1', {
      writes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      deletes: [{ user: 'user:bob', relation: 'viewer', object: 'doc:1' }],
      onDuplicate: 'error',
      onMissing: 'error',
    })).rejects.toBeInstanceOf(MissingTupleError)

    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO openfga.tuple '),
      expect.stringContaining('INSERT INTO openfga.tuple_change'),
      expect.stringContaining('DELETE FROM openfga.tuple'),
      'ROLLBACK',
    ])
  })
})
