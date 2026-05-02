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
import { generateId } from './ids'

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

export class InvalidObjectReferenceError extends Error {
  constructor(public readonly value: string) {
    super(`invalid object reference (expected "type:id" or "type:" for type-only filters): "${value}"`)
    this.name = 'InvalidObjectReferenceError'
  }
}

export function parseObject(s: string): ObjectRef {
  const idx = s.indexOf(':')
  if (idx < 0) {
    throw new InvalidObjectReferenceError(s)
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

/**
 * Cursor for /read pagination. The 5-field row-tuple is the smallest
 * stable total order on `openfga.tuple` since the table has no
 * synthetic id column — (object_type, object_id, relation, user_str)
 * is the natural unique key, and `inserted_at` provides the chrono
 * ordering. ASC pagination uses `(inserted_at, ...) > $cursor`.
 */
export interface ReadTupleCursor {
  inserted_at: string
  object_type: string
  object_id: string
  relation: string
  user_str: string
}

export interface ReadTuplesPage {
  rows: TupleRow[]
  /** Cursor for the next page; null when there are no more rows. */
  nextCursor: ReadTupleCursor | null
}

export type TupleConflictMode = 'error' | 'ignore'

export interface TupleMutations {
  writes: TupleKey[] | TupleKeyWithoutCondition[]
  deletes: TupleKeyWithoutCondition[] | TupleKey[]
  onDuplicate: TupleConflictMode
  onMissing: TupleConflictMode
}

export class DuplicateTupleError extends Error {
  constructor(readonly tuple: TupleKey | TupleKeyWithoutCondition) {
    super(`tuple already exists: ${tuple.user} ${tuple.relation} ${tuple.object}`)
  }
}

export class MissingTupleError extends Error {
  constructor(readonly tuple: TupleKey | TupleKeyWithoutCondition) {
    super(`tuple does not exist: ${tuple.user} ${tuple.relation} ${tuple.object}`)
  }
}

export async function applyTupleMutations(
  storeId: string,
  mutations: TupleMutations,
): Promise<void> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    for (const t of mutations.writes) {
      const obj = parseObject(t.object)
      const result = await client.query(
        `INSERT INTO openfga.tuple (store_id, object_type, object_id, relation, user_str)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [storeId, obj.type, obj.id, t.relation, t.user],
      )
      if (result.rowCount === 0 && mutations.onDuplicate === 'error') {
        throw new DuplicateTupleError(t)
      }
      // Record the change in the same transaction as the mutation
      // so a crash between the two cannot leave the changelog out of
      // sync with tuple state. Skip when ON CONFLICT silently ignored
      // — the caller asked for at-most-once semantics on duplicates.
      if (result.rowCount && result.rowCount > 0) {
        await client.query(
          `INSERT INTO openfga.tuple_change
             (id, store_id, object_type, object_id, relation, user_str, operation)
           VALUES ($1, $2, $3, $4, $5, $6, 'TUPLE_OPERATION_WRITE')`,
          [generateId(), storeId, obj.type, obj.id, t.relation, t.user],
        )
      }
    }

    for (const t of mutations.deletes) {
      const obj = parseObject(t.object)
      const result = await client.query(
        `DELETE FROM openfga.tuple
          WHERE store_id = $1
            AND object_type = $2
            AND object_id = $3
            AND relation = $4
            AND user_str = $5`,
        [storeId, obj.type, obj.id, t.relation, t.user],
      )
      if (result.rowCount === 0 && mutations.onMissing === 'error') {
        throw new MissingTupleError(t)
      }
      // Same transactional invariant as writes: only record a change
      // when the DELETE actually removed a row.
      if (result.rowCount && result.rowCount > 0) {
        await client.query(
          `INSERT INTO openfga.tuple_change
             (id, store_id, object_type, object_id, relation, user_str, operation)
           VALUES ($1, $2, $3, $4, $5, $6, 'TUPLE_OPERATION_DELETE')`,
          [generateId(), storeId, obj.type, obj.id, t.relation, t.user],
        )
      }
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

export async function writeTuples(
  storeId: string,
  tuples: TupleKey[] | TupleKeyWithoutCondition[],
): Promise<void> {
  if (tuples.length === 0) return
  await applyTupleMutations(storeId, {
    writes: tuples,
    deletes: [],
    onDuplicate: 'ignore',
    onMissing: 'ignore',
  })
}

export async function deleteTuples(
  storeId: string,
  tuples: TupleKeyWithoutCondition[] | TupleKey[],
): Promise<void> {
  if (tuples.length === 0) return
  await applyTupleMutations(storeId, {
    writes: [],
    deletes: tuples,
    onDuplicate: 'ignore',
    onMissing: 'ignore',
  })
}

export async function readTuples(
  storeId: string,
  filter: ReadFilter,
): Promise<TupleRow[]> {
  // Backwards-compatible non-paginated wrapper. New callers that need
  // continuation tokens should use readTuplesPage directly.
  const page = await readTuplesPage(storeId, filter, null)
  return page.rows
}

/**
 * Cursor-paginated read of tuples for a store. Same filter surface as
 * readTuples plus an optional `cursor` arg; returns a page of rows
 * plus a next-cursor (null when exhausted). The +1 fetch trick lets
 * us decide "is there a next page" without a separate COUNT query.
 *
 * Ordering is ASC by (inserted_at, object_type, object_id, relation,
 * user_str). The natural unique key (the latter four fields)
 * provides total order so pagination is stable under inserts at the
 * head of the timeline.
 */
export async function readTuplesPage(
  storeId: string,
  filter: ReadFilter,
  cursor: ReadTupleCursor | null,
): Promise<ReadTuplesPage> {
  const pool = getPool()
  const where: string[] = ['store_id = $1']
  const params: unknown[] = [storeId]
  let p = 2

  if (filter.object) {
    const obj = parseObject(filter.object)
    where.push(`object_type = $${p++}`)
    params.push(obj.type)
    // OpenFGA wire format admits type-only filters of the form
    // "type:" — distinguish those from full references "type:id" and
    // skip the object_id predicate so the query returns every tuple
    // for the requested type. Adding `object_id = ''` would silently
    // return zero rows.
    if (obj.id !== '') {
      where.push(`object_id = $${p++}`)
      params.push(obj.id)
    }
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

  if (cursor) {
    // Five-field row-tuple comparison gives a stable total order on
    // the page boundary. Postgres compares row tuples lexicographically.
    where.push(
      `(inserted_at, object_type, object_id, relation, user_str)`
      + ` > ($${p++}::timestamptz, $${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text)`,
    )
    params.push(cursor.inserted_at, cursor.object_type, cursor.object_id, cursor.relation, cursor.user_str)
  }

  const pageSize = filter.pageSize ?? 100
  const { rows } = await pool.query<TupleRow>(
    `SELECT store_id, object_type, object_id, relation, user_str, inserted_at
       FROM openfga.tuple
      WHERE ${where.join(' AND ')}
      ORDER BY inserted_at ASC, object_type ASC, object_id ASC, relation ASC, user_str ASC
      LIMIT $${p}`,
    [...params, pageSize + 1],
  )
  if (rows.length <= pageSize) {
    return { rows, nextCursor: null }
  }
  const page = rows.slice(0, pageSize)
  const last = page[page.length - 1]!
  return {
    rows: page,
    nextCursor: {
      inserted_at: last.inserted_at,
      object_type: last.object_type,
      object_id: last.object_id,
      relation: last.relation,
      user_str: last.user_str,
    },
  }
}

export interface TupleChangeRow {
  id: string
  seq: string
  object_type: string
  object_id: string
  relation: string
  user_str: string
  operation: 'TUPLE_OPERATION_WRITE' | 'TUPLE_OPERATION_DELETE'
  inserted_at: string
}

export interface ListChangesPage {
  rows: TupleChangeRow[]
  /**
   * Cursor for the next page; null when there are no more rows.
   * The cursor uses (inserted_at, seq) — `seq` is a Postgres-side
   * bigserial column that breaks same-millisecond ties
   * deterministically, in insertion order. See openfga-ra9.
   */
  nextCursor: { inserted_at: string, seq: string } | null
}

/**
 * Oldest-first (ASCENDING) paginated read of the changelog for a
 * store. This matches the OpenFGA ReadChanges API which sequences
 * tuple changes chronologically so polling-tail consumers can
 * advance through history without missing or reordering events.
 *
 * Optional filters narrow by `objectType` (the OpenFGA `?type=`
 * query) and `startTime` (only changes recorded at or after the
 * timestamp).
 *
 * Pagination uses (inserted_at, id) row-tuple comparison with a
 * strictly-greater-than predicate so a change recorded at the
 * tail while a client is paging surfaces on the next call rather
 * than shifting previously-seen pages. The +1 fetch trick lets us
 * decide "is there a next page" without a separate COUNT query.
 *
 * See openfga-ra9 for the ordering inversion from the prior
 * newest-first implementation.
 */
export async function listChangesPage(
  storeId: string,
  pageSize: number,
  cursor: { inserted_at: string, seq: string } | null,
  opts: { objectType?: string, startTime?: string } = {},
): Promise<ListChangesPage> {
  const pool = getPool()
  const where: string[] = ['store_id = $1']
  const params: unknown[] = [storeId]
  let p = 2
  if (opts.objectType) {
    where.push(`object_type = $${p++}`)
    params.push(opts.objectType)
  }
  if (opts.startTime) {
    where.push(`inserted_at >= $${p++}::timestamptz`)
    params.push(opts.startTime)
  }
  if (cursor) {
    where.push(`(inserted_at, seq) > ($${p++}::timestamptz, $${p++}::bigint)`)
    params.push(cursor.inserted_at, cursor.seq)
  }

  const { rows } = await pool.query<TupleChangeRow>(
    `SELECT id, seq, object_type, object_id, relation, user_str, operation, inserted_at
       FROM openfga.tuple_change
      WHERE ${where.join(' AND ')}
      ORDER BY inserted_at ASC, seq ASC
      LIMIT $${p}`,
    [...params, pageSize + 1],
  )
  if (rows.length <= pageSize) {
    return { rows, nextCursor: null }
  }
  const page = rows.slice(0, pageSize)
  const last = page[page.length - 1]!
  return { rows: page, nextCursor: { inserted_at: last.inserted_at, seq: last.seq } }
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
