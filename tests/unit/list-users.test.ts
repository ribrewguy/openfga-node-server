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

// Regression for openfga-6e6: when a tuple grants access via a
// userset reference (e.g. `group:eng#member`) and the request's
// user_filter targets the underlying user type, the server must
// expand the userset to its concrete users. The previous
// implementation only emitted the userset shape and filtered it
// out for `{type: 'user'}` requests, returning [] instead of the
// actual members.
describe('listUsers — userset expansion under user_filter', () => {
  const usersetGrantModel: AuthorizationModel = {
    id: 'userset-grant',
    schema_version: '1.1',
    type_definitions: [
      { type: 'user' },
      {
        type: 'group',
        relations: { member: { this: {} } },
        metadata: {
          relations: {
            member: {
              directly_related_user_types: [{ type: 'user' }, { type: 'group', relation: 'member' }],
            },
          },
        },
      },
      {
        type: 'doc',
        relations: { viewer: { this: {} } },
        metadata: {
          relations: {
            viewer: {
              directly_related_user_types: [
                { type: 'user' },
                { type: 'group', relation: 'member' },
              ],
            },
          },
        },
      },
    ],
  }

  it("expands a single userset to its concrete users for a user-typed filter", async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'group:eng#member')
    store.add('group:eng', 'member', 'user:alice')
    store.add('group:eng', 'member', 'user:bob')

    const users = await listUsers(modelIndex(usersetGrantModel), store, 'doc', '1', 'viewer', { type: 'user' })
    const ids = users?.map((u) => u.object?.id).sort()
    expect(ids).toEqual(['alice', 'bob'])
  })

  it("preserves the userset shape when user_filter targets the userset type", async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'group:eng#member')
    store.add('group:eng', 'member', 'user:alice')

    // Request the userset shape — must NOT be subsumed by the
    // expansion. The result includes group:eng#member; the
    // expanded user:alice is filtered out by the type='group' filter.
    const users = await listUsers(
      modelIndex(usersetGrantModel),
      store,
      'doc',
      '1',
      'viewer',
      { type: 'group', relation: 'member' },
    )
    expect(users).toEqual([{ userset: { type: 'group', id: 'eng', relation: 'member' } }])
  })

  it("expands nested usersets recursively (group of groups)", async () => {
    const store = new InMemoryTupleStore()
    // doc:1 viewer ← group:a#member
    store.add('doc:1', 'viewer', 'group:a#member')
    // group:a member ← group:b#member  (group b is a member of a)
    store.add('group:a', 'member', 'group:b#member')
    // group:b member ← user:carol
    store.add('group:b', 'member', 'user:carol')

    const users = await listUsers(
      modelIndex(usersetGrantModel),
      store,
      'doc',
      '1',
      'viewer',
      { type: 'user' },
    )
    expect(users).toEqual([{ object: { type: 'user', id: 'carol' } }])
  })

  it("dedupes a user reachable via multiple userset paths", async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'group:a#member')
    store.add('doc:1', 'viewer', 'group:b#member')
    store.add('group:a', 'member', 'user:alice')
    store.add('group:b', 'member', 'user:alice')

    const users = await listUsers(
      modelIndex(usersetGrantModel),
      store,
      'doc',
      '1',
      'viewer',
      { type: 'user' },
    )
    expect(users).toEqual([{ object: { type: 'user', id: 'alice' } }])
  })

  it("does not infinite-loop on a userset cycle", async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'group:a#member')
    // Cycle: group:a member ← group:b#member, group:b member ← group:a#member
    store.add('group:a', 'member', 'group:b#member')
    store.add('group:b', 'member', 'group:a#member')
    // No concrete users in the cycle — but adding one should still
    // surface it without the recursion exploding.
    store.add('group:a', 'member', 'user:dana')

    const users = await listUsers(
      modelIndex(usersetGrantModel),
      store,
      'doc',
      '1',
      'viewer',
      { type: 'user' },
    )
    expect(users).toEqual([{ object: { type: 'user', id: 'dana' } }])
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
