import { describe, it, expect } from 'vitest'
import type { TypeDefinition } from '@openfga/sdk'
import { listObjects } from '../../src/evaluator/list-objects'
import { ModelIndex } from '../../src/evaluator/model-index'
import { InMemoryTupleStore } from '../../src/evaluator/tuple-store'

const userType: TypeDefinition = { type: 'user' }

function makeModel(...types: TypeDefinition[]): ModelIndex {
  return new ModelIndex(types)
}

describe('list-objects evaluator', () => {
  it('returns directly-assigned object ids for `this`', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')
    store.add('doc:2', 'viewer', 'user:alice')
    store.add('doc:3', 'viewer', 'user:bob')

    const ids = await listObjects(model, store, 'user:alice', 'viewer', 'doc')
    expect(ids.sort()).toEqual(['1', '2'])
  })

  it('returns objects reachable via typed wildcard `user:*`', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: {
        relations: {
          viewer: { directly_related_user_types: [{ type: 'user' }, { type: 'user', wildcard: {} }] },
        },
      },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:*')
    store.add('doc:2', 'viewer', 'user:alice')

    const ids = await listObjects(model, store, 'user:bob', 'viewer', 'doc')
    expect(ids.sort()).toEqual(['1'])
  })

  it('returns objects reachable via userset reference', async () => {
    const model = makeModel(
      userType,
      {
        type: 'group',
        relations: { member: { this: {} } },
        metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }] } } },
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
    )
    const store = new InMemoryTupleStore()
    store.add('group:eng', 'member', 'user:alice')
    store.add('doc:1', 'viewer', 'group:eng#member')
    store.add('doc:2', 'viewer', 'user:bob')

    const ids = await listObjects(model, store, 'user:alice', 'viewer', 'doc')
    expect(ids.sort()).toEqual(['1'])
  })

  it('expands `computedUserset` to the aliased relation', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: {
        owner: { this: {} },
        viewer: { computedUserset: { relation: 'owner' } },
      },
      metadata: { relations: { owner: { directly_related_user_types: [{ type: 'user' }] } } },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'owner', 'user:alice')

    const ids = await listObjects(model, store, 'user:alice', 'viewer', 'doc')
    expect(ids).toEqual(['1'])
  })

  it('walks `tupleToUserset` ("viewer from parent_account")', async () => {
    const model = makeModel(
      userType,
      {
        type: 'account',
        relations: { viewer: { this: {} } },
        metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
      },
      {
        type: 'doc',
        relations: {
          parent_account: { this: {} },
          viewer: {
            tupleToUserset: {
              tupleset: { relation: 'parent_account' },
              computedUserset: { relation: 'viewer' },
            },
          },
        },
        metadata: { relations: { parent_account: { directly_related_user_types: [{ type: 'account' }] } } },
      },
    )
    const store = new InMemoryTupleStore()
    store.add('account:acme', 'viewer', 'user:alice')
    store.add('doc:1', 'parent_account', 'account:acme')
    store.add('doc:2', 'parent_account', 'account:other')

    const ids = await listObjects(model, store, 'user:alice', 'viewer', 'doc')
    expect(ids).toEqual(['1'])
  })

  it('unions candidates across `union` children', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: {
        owner: { this: {} },
        editor: { this: {} },
        can_view: {
          union: {
            child: [
              { computedUserset: { relation: 'owner' } },
              { computedUserset: { relation: 'editor' } },
            ],
          },
        },
      },
      metadata: {
        relations: {
          owner: { directly_related_user_types: [{ type: 'user' }] },
          editor: { directly_related_user_types: [{ type: 'user' }] },
        },
      },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'owner', 'user:alice')
    store.add('doc:2', 'editor', 'user:alice')
    store.add('doc:3', 'editor', 'user:bob')

    const ids = await listObjects(model, store, 'user:alice', 'can_view', 'doc')
    expect(ids.sort()).toEqual(['1', '2'])
  })

  it('filters by `intersection` correctness', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: {
        member: { this: {} },
        verified: { this: {} },
        active_member: {
          intersection: {
            child: [
              { computedUserset: { relation: 'member' } },
              { computedUserset: { relation: 'verified' } },
            ],
          },
        },
      },
      metadata: {
        relations: {
          member: { directly_related_user_types: [{ type: 'user' }] },
          verified: { directly_related_user_types: [{ type: 'user' }] },
        },
      },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'member', 'user:alice')
    store.add('doc:1', 'verified', 'user:alice')
    store.add('doc:2', 'member', 'user:alice') // not verified

    const ids = await listObjects(model, store, 'user:alice', 'active_member', 'doc')
    expect(ids).toEqual(['1'])
  })

  it('subtracts `difference.subtract` candidates', async () => {
    const model = makeModel(userType, {
      type: 'team',
      relations: {
        maintainer: { this: {} },
        member: { this: {} },
        banned: { this: {} },
        active_member: {
          difference: {
            base: {
              union: {
                child: [
                  { computedUserset: { relation: 'maintainer' } },
                  { computedUserset: { relation: 'member' } },
                ],
              },
            },
            subtract: { computedUserset: { relation: 'banned' } },
          },
        },
      },
      metadata: {
        relations: {
          maintainer: { directly_related_user_types: [{ type: 'user' }] },
          member: { directly_related_user_types: [{ type: 'user' }] },
          banned: { directly_related_user_types: [{ type: 'user' }] },
        },
      },
    })
    const store = new InMemoryTupleStore()
    store.add('team:eng', 'member', 'user:dev')
    store.add('team:eng', 'banned', 'user:dev')
    store.add('team:platform', 'member', 'user:dev')

    const ids = await listObjects(model, store, 'user:dev', 'active_member', 'team')
    expect(ids).toEqual(['platform'])
  })

  it('returns empty for unknown type', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
    })
    const store = new InMemoryTupleStore()

    const ids = await listObjects(model, store, 'user:alice', 'viewer', 'unknown_type')
    expect(ids).toEqual([])
  })
})
