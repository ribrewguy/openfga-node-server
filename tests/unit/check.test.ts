import { describe, it, expect } from 'vitest'
import type { TypeDefinition } from '@openfga/sdk'
import { check } from '../../src/evaluator/check'
import { ModelIndex } from '../../src/evaluator/model-index'
import { InMemoryTupleStore } from '../../src/evaluator/tuple-store'

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeModel(...types: TypeDefinition[]): ModelIndex {
  return new ModelIndex(types)
}

const userType: TypeDefinition = { type: 'user' }

// ─── Tests ────────────────────────────────────────────────────────────────

describe('check evaluator — `this` rewrite', () => {
  it('returns true when user is directly related', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')

    expect(await check(model, store, 'user:alice', 'viewer', 'doc:1')).toBe(true)
  })

  it('returns false when no tuple exists', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')

    expect(await check(model, store, 'user:bob', 'viewer', 'doc:1')).toBe(false)
  })

  it('returns false when relation is not defined on type', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
    })
    const store = new InMemoryTupleStore()

    expect(await check(model, store, 'user:alice', 'editor', 'doc:1')).toBe(false)
  })

  it('matches typed wildcard `user:*`', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: {
        relations: {
          viewer: {
            directly_related_user_types: [{ type: 'user' }, { type: 'user', wildcard: {} }],
          },
        },
      },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:*')

    expect(await check(model, store, 'user:alice', 'viewer', 'doc:1')).toBe(true)
    expect(await check(model, store, 'user:bob', 'viewer', 'doc:1')).toBe(true)
  })

  it('does not match wildcard of a different type', async () => {
    const model = makeModel(userType, { type: 'group' }, {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'group', wildcard: {} }] } } },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'group:*')

    expect(await check(model, store, 'user:alice', 'viewer', 'doc:1')).toBe(false)
  })

  it('resolves userset reference `<type>:<id>#<rel>` recursively', async () => {
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

    expect(await check(model, store, 'user:alice', 'viewer', 'doc:1')).toBe(true)
    expect(await check(model, store, 'user:bob', 'viewer', 'doc:1')).toBe(false)
  })
})

describe('check evaluator — `computedUserset` rewrite', () => {
  it('aliases one relation to another on the same object', async () => {
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

    expect(await check(model, store, 'user:alice', 'viewer', 'doc:1')).toBe(true)
    expect(await check(model, store, 'user:bob', 'viewer', 'doc:1')).toBe(false)
  })
})

describe('check evaluator — `tupleToUserset` rewrite', () => {
  it('"viewer from parent_account" walks via parent', async () => {
    // Document inherits the parent_account's viewer set.
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
        metadata: {
          relations: {
            parent_account: { directly_related_user_types: [{ type: 'account' }] },
          },
        },
      },
    )
    const store = new InMemoryTupleStore()
    store.add('account:acme', 'viewer', 'user:alice')
    store.add('doc:1', 'parent_account', 'account:acme')

    expect(await check(model, store, 'user:alice', 'viewer', 'doc:1')).toBe(true)
    expect(await check(model, store, 'user:bob', 'viewer', 'doc:1')).toBe(false)
  })

  it('does not follow userset references stored in the tupleset', async () => {
    // A wildcard or `<type>:<id>#<rel>` entry on the tupleset relation
    // is invalid in well-formed models, but we should ignore rather
    // than crash if seen.
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
    store.add('doc:1', 'parent_account', 'account:*')
    store.add('doc:1', 'parent_account', 'account:acme#viewer')

    expect(await check(model, store, 'user:alice', 'viewer', 'doc:1')).toBe(false)
  })

  it('returns false when the tupleset relation has no tuples', async () => {
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
        metadata: {
          relations: { parent_account: { directly_related_user_types: [{ type: 'account' }] } },
        },
      },
    )
    const store = new InMemoryTupleStore()
    store.add('account:acme', 'viewer', 'user:alice')
    // Note: doc:1 has no parent_account tuple.

    expect(await check(model, store, 'user:alice', 'viewer', 'doc:1')).toBe(false)
  })
})

describe('check evaluator — `union` rewrite', () => {
  it('returns true if any child matches', async () => {
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
    store.add('doc:1', 'editor', 'user:bob')

    expect(await check(model, store, 'user:bob', 'can_view', 'doc:1')).toBe(true)
  })

  it('returns false if no child matches', async () => {
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

    expect(await check(model, store, 'user:bob', 'can_view', 'doc:1')).toBe(false)
  })
})

describe('check evaluator — `intersection` rewrite', () => {
  it('returns true only when every child matches', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: {
        owner: { this: {} },
        verified: { this: {} },
        can_publish: {
          intersection: {
            child: [
              { computedUserset: { relation: 'owner' } },
              { computedUserset: { relation: 'verified' } },
            ],
          },
        },
      },
      metadata: {
        relations: {
          owner: { directly_related_user_types: [{ type: 'user' }] },
          verified: { directly_related_user_types: [{ type: 'user' }] },
        },
      },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'owner', 'user:alice')
    store.add('doc:1', 'verified', 'user:alice')
    store.add('doc:1', 'owner', 'user:bob')
    // bob lacks verified

    expect(await check(model, store, 'user:alice', 'can_publish', 'doc:1')).toBe(true)
    expect(await check(model, store, 'user:bob', 'can_publish', 'doc:1')).toBe(false)
  })
})

describe('check evaluator — `difference` rewrite', () => {
  it('returns true when base matches and subtract does not', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: {
        member: { this: {} },
        banned: { this: {} },
        can_view: {
          difference: {
            base: { computedUserset: { relation: 'member' } },
            subtract: { computedUserset: { relation: 'banned' } },
          },
        },
      },
      metadata: {
        relations: {
          member: { directly_related_user_types: [{ type: 'user' }] },
          banned: { directly_related_user_types: [{ type: 'user' }] },
        },
      },
    })
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'member', 'user:alice')
    store.add('doc:1', 'member', 'user:bob')
    store.add('doc:1', 'banned', 'user:bob')

    expect(await check(model, store, 'user:alice', 'can_view', 'doc:1')).toBe(true)
    expect(await check(model, store, 'user:bob', 'can_view', 'doc:1')).toBe(false)
  })

  it('returns false when base does not match (regardless of subtract)', async () => {
    const model = makeModel(userType, {
      type: 'doc',
      relations: {
        member: { this: {} },
        banned: { this: {} },
        can_view: {
          difference: {
            base: { computedUserset: { relation: 'member' } },
            subtract: { computedUserset: { relation: 'banned' } },
          },
        },
      },
      metadata: {
        relations: {
          member: { directly_related_user_types: [{ type: 'user' }] },
          banned: { directly_related_user_types: [{ type: 'user' }] },
        },
      },
    })
    const store = new InMemoryTupleStore()
    // outsider is not a member; not banned either

    expect(await check(model, store, 'user:outsider', 'can_view', 'doc:1')).toBe(false)
  })
})

describe('check evaluator — compound nesting (real model patterns)', () => {
  it('handles `(maintainer or member) but not banned` from the team type', async () => {
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
    store.add('team:eng', 'maintainer', 'user:lead')
    store.add('team:eng', 'member', 'user:dev1')
    store.add('team:eng', 'member', 'user:dev2')
    store.add('team:eng', 'banned', 'user:dev2')

    expect(await check(model, store, 'user:lead', 'active_member', 'team:eng')).toBe(true)
    expect(await check(model, store, 'user:dev1', 'active_member', 'team:eng')).toBe(true)
    expect(await check(model, store, 'user:dev2', 'active_member', 'team:eng')).toBe(false)
    expect(await check(model, store, 'user:stranger', 'active_member', 'team:eng')).toBe(false)
  })

  it('handles `reader or admin from owner` (mixed direct + tupleToUserset under union)', async () => {
    const model = makeModel(
      userType,
      {
        type: 'organization',
        relations: { admin: { this: {} } },
        metadata: { relations: { admin: { directly_related_user_types: [{ type: 'user' }] } } },
      },
      {
        type: 'repo',
        relations: {
          owner: { this: {} },
          reader: { this: {} },
          can_read: {
            union: {
              child: [
                { computedUserset: { relation: 'reader' } },
                {
                  tupleToUserset: {
                    tupleset: { relation: 'owner' },
                    computedUserset: { relation: 'admin' },
                  },
                },
              ],
            },
          },
        },
        metadata: {
          relations: {
            owner: { directly_related_user_types: [{ type: 'organization' }] },
            reader: { directly_related_user_types: [{ type: 'user' }] },
          },
        },
      },
    )
    const store = new InMemoryTupleStore()
    store.add('repo:openfga', 'owner', 'organization:openfga-org')
    store.add('repo:openfga', 'reader', 'user:alice')
    store.add('organization:openfga-org', 'admin', 'user:carol')

    expect(await check(model, store, 'user:alice', 'can_read', 'repo:openfga')).toBe(true) // direct reader
    expect(await check(model, store, 'user:carol', 'can_read', 'repo:openfga')).toBe(true) // org admin
    expect(await check(model, store, 'user:bob', 'can_read', 'repo:openfga')).toBe(false)
  })
})
