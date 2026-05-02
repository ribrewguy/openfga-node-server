/**
 * Unit tests for the list-users evaluator.
 *
 * Covers each rewrite shape and each User result discrimination
 * (concrete object, userset reference, typed wildcard) plus the
 * user_filter narrowing. Uses InMemoryTupleStore so the tests run
 * without a DB.
 */
import { describe, expect, it } from 'vitest'
import type { AuthorizationModel } from '@openfga/sdk'
import { InMemoryTupleStore } from '../../src/evaluator/tuple-store'
import { ModelIndex } from '../../src/evaluator/model-index'
import { listUsers } from '../../src/evaluator/list-users'

function modelIndex(model: AuthorizationModel): ModelIndex {
  return new ModelIndex(model.type_definitions ?? [])
}

const directModel: AuthorizationModel = {
  id: 'direct',
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: {
        relations: {
          viewer: {
            directly_related_user_types: [
              { type: 'user' },
              { type: 'user', wildcard: {} },
              { type: 'group', relation: 'member' },
            ],
          },
        },
      },
    },
  ],
}

describe('listUsers — direct grants and shape discrimination', () => {
  it('returns concrete user objects for plain type:id grants', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')
    store.add('doc:1', 'viewer', 'user:bob')

    const users = await listUsers(modelIndex(directModel), store, 'doc', '1', 'viewer', { type: 'user' })
    expect(users).toEqual([
      { object: { type: 'user', id: 'alice' } },
      { object: { type: 'user', id: 'bob' } },
    ])
  })

  it('returns typed wildcards as wildcard-shaped users', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:*')

    const users = await listUsers(modelIndex(directModel), store, 'doc', '1', 'viewer', { type: 'user' })
    expect(users).toEqual([{ wildcard: { type: 'user' } }])
  })

  it('returns userset references as userset-shaped users (when filter has matching relation)', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'group:eng#member')

    const users = await listUsers(modelIndex(directModel), store, 'doc', '1', 'viewer', { type: 'group', relation: 'member' })
    expect(users).toEqual([{ userset: { type: 'group', id: 'eng', relation: 'member' } }])
  })

  it('filters out usersets when user_filter has no relation', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')
    store.add('doc:1', 'viewer', 'group:eng#member')

    const users = await listUsers(modelIndex(directModel), store, 'doc', '1', 'viewer', { type: 'user' })
    expect(users).toEqual([{ object: { type: 'user', id: 'alice' } }])
  })

  it('filters out concrete users when user_filter has a relation', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')
    store.add('doc:1', 'viewer', 'group:eng#member')

    const users = await listUsers(modelIndex(directModel), store, 'doc', '1', 'viewer', { type: 'group', relation: 'member' })
    expect(users).toEqual([{ userset: { type: 'group', id: 'eng', relation: 'member' } }])
  })
})

describe('listUsers — rewrite algebra', () => {
  it('returns the union of children (set union, deduped)', async () => {
    const model = modelIndex({
      id: 'm',
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: {
            owner: { this: {} },
            editor: { this: {} },
            viewer: {
              union: {
                child: [
                  { computedUserset: { object: '', relation: 'owner' } },
                  { computedUserset: { object: '', relation: 'editor' } },
                ],
              },
            },
          },
          metadata: {
            relations: {
              owner: { directly_related_user_types: [{ type: 'user' }] },
              editor: { directly_related_user_types: [{ type: 'user' }] },
              viewer: { directly_related_user_types: [{ type: 'user' }] },
            },
          },
        },
      ],
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'owner', 'user:alice')
    store.add('doc:1', 'editor', 'user:alice')
    store.add('doc:1', 'editor', 'user:bob')

    const users = await listUsers(model, store, 'doc', '1', 'viewer', { type: 'user' })
    const ids = users?.map((u) => u.object?.id).sort()
    expect(ids).toEqual(['alice', 'bob'])
  })

  it('returns the intersection of children (set intersection)', async () => {
    const model = modelIndex({
      id: 'm',
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: {
            owner: { this: {} },
            editor: { this: {} },
            allowed: {
              intersection: {
                child: [
                  { computedUserset: { object: '', relation: 'owner' } },
                  { computedUserset: { object: '', relation: 'editor' } },
                ],
              },
            },
          },
          metadata: {
            relations: {
              owner: { directly_related_user_types: [{ type: 'user' }] },
              editor: { directly_related_user_types: [{ type: 'user' }] },
              allowed: { directly_related_user_types: [{ type: 'user' }] },
            },
          },
        },
      ],
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'owner', 'user:alice')
    store.add('doc:1', 'owner', 'user:bob')
    store.add('doc:1', 'editor', 'user:alice')

    const users = await listUsers(model, store, 'doc', '1', 'allowed', { type: 'user' })
    expect(users).toEqual([{ object: { type: 'user', id: 'alice' } }])
  })

  it('returns the difference of base minus subtract', async () => {
    const model = modelIndex({
      id: 'm',
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: {
            viewer: { this: {} },
            blocked: { this: {} },
            visible: {
              difference: {
                base: { computedUserset: { object: '', relation: 'viewer' } },
                subtract: { computedUserset: { object: '', relation: 'blocked' } },
              },
            },
          },
          metadata: {
            relations: {
              viewer: { directly_related_user_types: [{ type: 'user' }] },
              blocked: { directly_related_user_types: [{ type: 'user' }] },
              visible: { directly_related_user_types: [{ type: 'user' }] },
            },
          },
        },
      ],
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')
    store.add('doc:1', 'viewer', 'user:bob')
    store.add('doc:1', 'blocked', 'user:bob')

    const users = await listUsers(model, store, 'doc', '1', 'visible', { type: 'user' })
    expect(users).toEqual([{ object: { type: 'user', id: 'alice' } }])
  })

  it('inherits users through tupleToUserset (parent-folder pattern)', async () => {
    const model = modelIndex({
      id: 'm',
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'folder',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
        {
          type: 'doc',
          relations: {
            parent: { this: {} },
            viewer: {
              tupleToUserset: {
                tupleset: { object: '', relation: 'parent' },
                computedUserset: { object: '', relation: 'viewer' },
              },
            },
          },
          metadata: {
            relations: {
              parent: { directly_related_user_types: [{ type: 'folder' }] },
              viewer: { directly_related_user_types: [{ type: 'user' }] },
            },
          },
        },
      ],
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'parent', 'folder:f1')
    store.add('folder:f1', 'viewer', 'user:alice')

    const users = await listUsers(model, store, 'doc', '1', 'viewer', { type: 'user' })
    expect(users).toEqual([{ object: { type: 'user', id: 'alice' } }])
  })

  it('returns null when the relation is undefined on the type', async () => {
    const store = new InMemoryTupleStore()
    const users = await listUsers(modelIndex(directModel), store, 'doc', '1', 'editor', { type: 'user' })
    expect(users).toBeNull()
  })
})
