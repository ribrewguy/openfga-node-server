/**
 * Unit tests for the expand evaluator.
 *
 * Covers each rewrite shape: this (direct), computedUserset,
 * tupleToUserset, union, intersection, difference. Uses
 * InMemoryTupleStore so the evaluator runs without a DB.
 */
import { describe, expect, it } from 'vitest'
import type { AuthorizationModel } from '@openfga/sdk'
import { InMemoryTupleStore } from '../../src/evaluator/tuple-store'
import { ModelIndex } from '../../src/evaluator/model-index'
import { expand } from '../../src/evaluator/expand'

function modelIndex(model: AuthorizationModel): ModelIndex {
  return new ModelIndex(model.type_definitions ?? [])
}

describe('expand evaluator', () => {
  it('returns a leaf with users for a `this` rewrite', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')
    store.add('doc:1', 'viewer', 'user:bob')
    const model = modelIndex({
      id: 'm',
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
      ],
    })
    const node = await expand(model, store, 'doc', '1', 'viewer')
    expect(node?.name).toBe('doc:1#viewer')
    expect(node?.leaf?.users?.users.sort()).toEqual(['user:alice', 'user:bob'])
  })

  it('returns a leaf with computed userset for a `computedUserset` rewrite', async () => {
    const store = new InMemoryTupleStore()
    const model = modelIndex({
      id: 'm',
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: {
            owner: { this: {} },
            editor: { computedUserset: { object: '', relation: 'owner' } },
          },
          metadata: { relations: { owner: { directly_related_user_types: [{ type: 'user' }] } } },
        },
      ],
    })
    const node = await expand(model, store, 'doc', '1', 'editor')
    expect(node?.name).toBe('doc:1#editor')
    expect(node?.leaf?.computed?.userset).toBe('doc:1#owner')
  })

  it('returns a leaf with tupleToUserset list for a `tupleToUserset` rewrite', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'parent', 'folder:f1')
    store.add('doc:1', 'parent', 'folder:f2')
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
    const node = await expand(model, store, 'doc', '1', 'viewer')
    expect(node?.name).toBe('doc:1#viewer')
    expect(node?.leaf?.tupleToUserset?.tupleset).toBe('doc:1#parent')
    const usersets = (node?.leaf?.tupleToUserset?.computed ?? []).map((c) => c.userset).sort()
    expect(usersets).toEqual(['folder:f1#viewer', 'folder:f2#viewer'])
  })

  it('returns a node with union/nodes for a `union` rewrite', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'owner', 'user:alice')
    const model = modelIndex({
      id: 'm',
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: {
            owner: { this: {} },
            viewer: {
              union: {
                child: [
                  { this: {} },
                  { computedUserset: { object: '', relation: 'owner' } },
                ],
              },
            },
          },
          metadata: {
            relations: {
              owner: { directly_related_user_types: [{ type: 'user' }] },
              viewer: { directly_related_user_types: [{ type: 'user' }] },
            },
          },
        },
      ],
    })
    const node = await expand(model, store, 'doc', '1', 'viewer')
    expect(node?.name).toBe('doc:1#viewer')
    expect(node?.union?.nodes).toHaveLength(2)
    expect(node?.union?.nodes[0]?.leaf?.users?.users).toEqual([])
    expect(node?.union?.nodes[1]?.leaf?.computed?.userset).toBe('doc:1#owner')
  })

  it('returns a node with intersection/nodes for an `intersection` rewrite', async () => {
    const store = new InMemoryTupleStore()
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
    const node = await expand(model, store, 'doc', '1', 'allowed')
    expect(node?.intersection?.nodes).toHaveLength(2)
    expect(node?.intersection?.nodes[0]?.leaf?.computed?.userset).toBe('doc:1#owner')
    expect(node?.intersection?.nodes[1]?.leaf?.computed?.userset).toBe('doc:1#editor')
  })

  it('returns a node with difference/{base,subtract} for a `difference` rewrite', async () => {
    const store = new InMemoryTupleStore()
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
    const node = await expand(model, store, 'doc', '1', 'visible')
    expect(node?.difference?.base.leaf?.computed?.userset).toBe('doc:1#viewer')
    expect(node?.difference?.subtract.leaf?.computed?.userset).toBe('doc:1#blocked')
  })

  it('returns null when the relation is not defined on the type', async () => {
    const store = new InMemoryTupleStore()
    const model = modelIndex({
      id: 'm',
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
      ],
    })
    const node = await expand(model, store, 'doc', '1', 'editor')
    expect(node).toBeNull()
  })
})
