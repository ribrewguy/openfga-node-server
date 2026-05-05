import { describe, expect, it } from 'vitest'
import type { TypeDefinition } from '@openfga/sdk'
import { ModelIndex } from '../../src/evaluator/model-index'
import { validateWriteTupleKey } from '../../src/routes/write-validation'

const userType: TypeDefinition = { type: 'user' }

function model(): ModelIndex {
  return new ModelIndex([
    userType,
    {
      type: 'group',
      relations: { member: { this: {} } },
      metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }] } } },
    },
    {
      type: 'doc',
      relations: { viewer: { this: {} }, parent: { this: {} } },
      metadata: {
        relations: {
          viewer: {
            directly_related_user_types: [
              { type: 'user' },
              { type: 'group', relation: 'member' },
              { type: 'user', wildcard: {} },
            ],
          },
          parent: { directly_related_user_types: [{ type: 'doc' }] },
        },
      },
    },
  ])
}

describe('write tuple validation', () => {
  it('accepts direct users, userset references, and typed wildcards allowed by relation metadata', () => {
    const index = model()

    expect(validateWriteTupleKey(index, { user: 'user:alice', relation: 'viewer', object: 'doc:1' })).toBeNull()
    expect(validateWriteTupleKey(index, { user: 'group:eng#member', relation: 'viewer', object: 'doc:1' })).toBeNull()
    expect(validateWriteTupleKey(index, { user: 'user:*', relation: 'viewer', object: 'doc:1' })).toBeNull()
  })

  it('rejects object relations that are not defined by the authorization model', () => {
    expect(validateWriteTupleKey(model(), { user: 'user:alice', relation: 'editor', object: 'doc:1' })).toEqual(
      'relation "editor" is not defined for type "doc"',
    )
  })

  it('rejects users that are not allowed for the target object relation', () => {
    expect(validateWriteTupleKey(model(), { user: 'team:eng#member', relation: 'viewer', object: 'doc:1' })).toEqual(
      'user "team:eng#member" is not allowed for doc#viewer',
    )
    expect(validateWriteTupleKey(model(), { user: 'group:*', relation: 'viewer', object: 'doc:1' })).toEqual(
      'user "group:*" is not allowed for doc#viewer',
    )
  })

  it('rejects implicit self-defining userset tuples', () => {
    const index = new ModelIndex([
      userType,
      {
        type: 'doc',
        relations: { viewer: { this: {} } },
        metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'doc', relation: 'viewer' }] } } },
      },
    ])

    expect(validateWriteTupleKey(index, { user: 'doc:1#viewer', relation: 'viewer', object: 'doc:1' })).toEqual(
      'cannot write implicit self-defining tuple "doc:1#viewer" for doc:1#viewer',
    )
  })
})
