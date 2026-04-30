/**
 * Repository for `openfga.tuple` rows.
 *
 * The evaluator depends on tuples through the `TupleStore` interface
 * (see `../evaluator/tuple-store.ts`) so unit tests can swap an
 * in-memory implementation in.
 *
 * Object references on the wire have the form `<type>:<id>`. We split
 * them at the boundary so the table schema stays normalized — that way
 * indexes on (object_type, relation, …) are useful for lookup.
 *
 * `user_str` is stored verbatim — it can be a direct user reference
 * (`user:<id>`), a userset reference (`<type>:<id>#<relation>`), or a
 * typed wildcard (`<type>:*`). The evaluator parses it on read.
 */
import type { TupleKey, TupleKeyWithoutCondition } from '@openfga/sdk'
import { getPool } from './pool'

export interface TupleRow {
  store_id: string
  object_type: string
  object_id: string
  relation: string
  user_str: string
  inserted_at: string
}

export interface ObjectRef {
  type: string
  id: string
}

export function parseObject(s: string): ObjectRef {
  const idx = s.indexOf(':')
  if (idx < 0) {
    throw new Error(`Invalid object reference (expected "type:id"): ${s}`)
  }
  return { type: s.slice(0, idx), id: s.slice(idx + 1) }
}

export interface ReadFilter {
  /** `<type>:<id>` exact match. */
  object?: string
  /** Object type when listing across all ids. Used with optional `relation`. */
  objectType?: string
  relation?: string
  /** Direct or userset user reference. */
  user?: string
  pageSize?: number
}

export async function writeTuples(
  storeId: string,
  tuples: TupleKey[] | TupleKeyWithoutCondition[],
): Promise<void> {
  if (tuples.length === 0) return
  const pool = getPool()
  const values: string[] = []
  const params: unknown[] = []
  let p = 1
  for (const t of tuples) {
    const obj = parseObject(t.object)
    values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`)
    params.push(storeId, obj.type, obj.id, t.relation, t.user)
  }
  await pool.query(
    `INSERT INTO openfga.tuple (store_id, object_type, object_id, relation, user_str)
     VALUES ${values.join(',')}
     ON CONFLICT DO NOTHING`,
    params,
  )
}

export async function deleteTuples(
  storeId: string,
  tuples: TupleKeyWithoutCondition[] | TupleKey[],
): Promise<void> {
  if (tuples.length === 0) return
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const t of tuples) {
      const obj = parseObject(t.object)
      await client.query(
        `DELETE FROM openfga.tuple
          WHERE store_id = $1
            AND object_type = $2
            AND object_id = $3
            AND relation = $4
            AND user_str = $5`,
        [storeId, obj.type, obj.id, t.relation, t.user],
      )
    }
    await client.query('COMMIT')
  }
  catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
  finally {
    client.release()
  }
}

export async function readTuples(
  storeId: string,
  filter: ReadFilter,
): Promise<TupleRow[]> {
  const pool = getPool()
  const where: string[] = ['store_id = $1']
  const params: unknown[] = [storeId]
  let p = 2

  if (filter.object) {
    const obj = parseObject(filter.object)
    where.push(`object_type = $${p++}`)
    params.push(obj.type)
    where.push(`object_id = $${p++}`)
    params.push(obj.id)
  }
  else if (filter.objectType) {
    where.push(`object_type = $${p++}`)
    params.push(filter.objectType)
  }
  if (filter.relation) {
    where.push(`relation = $${p++}`)
    params.push(filter.relation)
  }
  if (filter.user) {
    where.push(`user_str = $${p++}`)
    params.push(filter.user)
  }

  const limit = filter.pageSize ?? 100
  const { rows } = await pool.query<TupleRow>(
    `SELECT store_id, object_type, object_id, relation, user_str, inserted_at
       FROM openfga.tuple
      WHERE ${where.join(' AND ')}
      ORDER BY inserted_at ASC
      LIMIT $${p}`,
    [...params, limit],
  )
  return rows
}

/**
 * Evaluator helper: list all `user_str` values directly assigned to
 * (objectType:objectId, relation). Used during `check` to enumerate
 * candidate users including direct refs, wildcards, and usersets.
 */
export async function listUsersForRelation(
  storeId: string,
  objectType: string,
  objectId: string,
  relation: string,
): Promise<string[]> {
  const pool = getPool()
  const { rows } = await pool.query<{ user_str: string }>(
    `SELECT user_str
       FROM openfga.tuple
      WHERE store_id = $1
        AND object_type = $2
        AND object_id = $3
        AND relation = $4`,
    [storeId, objectType, objectId, relation],
  )
  return rows.map(r => r.user_str)
}

/**
 * Evaluator helper: list all `object_id`s of `objectType` directly
 * assigned to a user via `relation`. Used during `list-objects` to seed
 * the candidate set for `this` rewrites.
 *
 * Also returns objects where the user is reachable via a typed wildcard
 * (`user:*`) — the evaluator caller is responsible for passing those as
 * additional `userStr` values when relevant.
 */
export async function listObjectIdsForUser(
  storeId: string,
  objectType: string,
  relation: string,
  userStr: string,
): Promise<string[]> {
  const pool = getPool()
  const { rows } = await pool.query<{ object_id: string }>(
    `SELECT DISTINCT object_id
       FROM openfga.tuple
      WHERE store_id = $1
        AND object_type = $2
        AND relation = $3
        AND user_str = $4`,
    [storeId, objectType, relation, userStr],
  )
  return rows.map(r => r.object_id)
}

/**
 * Evaluator helper: list every (object_id, user_str) pair for a given
 * (objectType, relation). Used by `list-objects` when walking
 * `tupleToUserset` rewrites — we need to discover related objects
 * regardless of which user reaches them.
 */
export async function listAllForRelation(
  storeId: string,
  objectType: string,
  relation: string,
): Promise<Array<{ object_id: string, user_str: string }>> {
  const pool = getPool()
  const { rows } = await pool.query<{ object_id: string, user_str: string }>(
    `SELECT object_id, user_str
       FROM openfga.tuple
      WHERE store_id = $1
        AND object_type = $2
        AND relation = $3`,
    [storeId, objectType, relation],
  )
  return rows
}
