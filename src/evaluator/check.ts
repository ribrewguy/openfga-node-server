/**
 * OpenFGA `check` evaluator.
 *
 * Implements the full rewrite algebra from the OpenFGA spec:
 *   - `this`              direct relation (incl. usersets and wildcards)
 *   - `computedUserset`   alias to another relation on the same object
 *   - `tupleToUserset`    "X from Y" — for each tuple via Y, evaluate X
 *   - `union`             OR over child rewrites
 *   - `intersection`      AND over child rewrites
 *   - `difference`        base rewrite minus subtract rewrite
 *
 * The evaluator depends on the `TupleStore` interface, not on Postgres
 * directly, so unit tests can drive it with an in-memory store.
 */
import type { Userset } from '@openfga/sdk'
import type { ModelIndex } from './model-index'
import type { TupleStore } from './tuple-store'

export async function check(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  relation: string,
  object: string,
): Promise<boolean> {
  const { type: objectType, id: objectId } = parseObject(object)
  return evaluateRelation(model, store, user, objectType, objectId, relation)
}

async function evaluateRelation(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  objectType: string,
  objectId: string,
  relation: string,
): Promise<boolean> {
  const def = model.getRelation(objectType, relation)
  if (!def) return false
  return evaluateUserset(model, store, user, objectType, objectId, relation, def.rewrite)
}

async function evaluateUserset(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  objectType: string,
  objectId: string,
  relation: string,
  rewrite: Userset,
): Promise<boolean> {
  if (rewrite.this !== undefined) {
    return evaluateDirect(model, store, user, objectType, objectId, relation)
  }
  if (rewrite.computedUserset) {
    const target = rewrite.computedUserset.relation
    if (!target) return false
    return evaluateRelation(model, store, user, objectType, objectId, target)
  }
  if (rewrite.tupleToUserset) {
    const tuplesetRel = rewrite.tupleToUserset.tupleset?.relation
    const computedRel = rewrite.tupleToUserset.computedUserset?.relation
    if (!tuplesetRel || !computedRel) return false
    // Find related objects via the tupleset relation. Each user_str on
    // those tuples is a `<type>:<id>` reference to the related object.
    const relatedUsers = await store.listUsersForRelation(objectType, objectId, tuplesetRel)
    for (const relatedUser of relatedUsers) {
      // Skip wildcards/usersets here — tupleset entries are object refs.
      if (relatedUser.endsWith(':*') || relatedUser.includes('#')) continue
      const { type: refType, id: refId } = parseObject(relatedUser)
      if (await evaluateRelation(model, store, user, refType, refId, computedRel)) {
        return true
      }
    }
    return false
  }
  if (rewrite.union) {
    for (const child of rewrite.union.child ?? []) {
      if (await evaluateUserset(model, store, user, objectType, objectId, relation, child)) {
        return true
      }
    }
    return false
  }
  if (rewrite.intersection) {
    const children = rewrite.intersection.child ?? []
    if (children.length === 0) return false
    for (const child of children) {
      if (!(await evaluateUserset(model, store, user, objectType, objectId, relation, child))) {
        return false
      }
    }
    return true
  }
  if (rewrite.difference) {
    const base = rewrite.difference.base
    const subtract = rewrite.difference.subtract
    if (!base || !subtract) return false
    const baseMatch = await evaluateUserset(model, store, user, objectType, objectId, relation, base)
    if (!baseMatch) return false
    const subtractMatch = await evaluateUserset(model, store, user, objectType, objectId, relation, subtract)
    return !subtractMatch
  }
  return false
}

async function evaluateDirect(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  objectType: string,
  objectId: string,
  relation: string,
): Promise<boolean> {
  const userType = parseObject(user).type
  const users = await store.listUsersForRelation(objectType, objectId, relation)
  for (const u of users) {
    // Direct user reference: exact match.
    if (u === user) return true
    // Typed wildcard `<type>:*` matches every member of that type.
    if (u.endsWith(':*')) {
      const wildcardType = u.slice(0, -2)
      if (wildcardType === userType) return true
      continue
    }
    // Userset reference `<type>:<id>#<rel>` — recurse.
    const hashIdx = u.indexOf('#')
    if (hashIdx >= 0) {
      const refObject = u.slice(0, hashIdx)
      const refRelation = u.slice(hashIdx + 1)
      const { type: refType, id: refId } = parseObject(refObject)
      if (await evaluateRelation(model, store, user, refType, refId, refRelation)) {
        return true
      }
    }
  }
  return false
}

function parseObject(s: string): { type: string, id: string } {
  const idx = s.indexOf(':')
  if (idx < 0) throw new Error(`Invalid object reference: ${s}`)
  return { type: s.slice(0, idx), id: s.slice(idx + 1) }
}
