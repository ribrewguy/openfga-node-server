/**
 * Repository for `openfga.store` rows.
 *
 * Stores are namespaces for tuples and authorization-model versions.
 * One store per environment is the typical shape.
 */
import { getPool } from './pool'
import { generateId } from './ids'

export interface StoreRow {
  id: string
  name: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export async function createStore(name: string): Promise<StoreRow> {
  const id = generateId()
  const pool = getPool()
  const { rows } = await pool.query<StoreRow>(
    `INSERT INTO openfga.store (id, name)
     VALUES ($1, $2)
     RETURNING id, name, created_at, updated_at, deleted_at`,
    [id, name],
  )
  return rows[0]!
}

export async function getStore(id: string): Promise<StoreRow | null> {
  const pool = getPool()
  const { rows } = await pool.query<StoreRow>(
    `SELECT id, name, created_at, updated_at, deleted_at
       FROM openfga.store
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  )
  return rows[0] ?? null
}

export async function findStoreByName(name: string): Promise<StoreRow | null> {
  const pool = getPool()
  const { rows } = await pool.query<StoreRow>(
    `SELECT id, name, created_at, updated_at, deleted_at
       FROM openfga.store
      WHERE name = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [name],
  )
  return rows[0] ?? null
}

export async function listStores(): Promise<StoreRow[]> {
  const pool = getPool()
  const { rows } = await pool.query<StoreRow>(
    `SELECT id, name, created_at, updated_at, deleted_at
       FROM openfga.store
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC`,
  )
  return rows
}

export interface ListStoresPage {
  rows: StoreRow[]
  /**
   * Cursor for the next page. `null` when there are no more rows.
   * The cursor is the (created_at, id) of the last row this page
   * returned; a follow-up call with this cursor returns rows strictly
   * older than it under the DESC ordering.
   */
  nextCursor: { created_at: string, id: string } | null
}

/**
 * Newest-first paginated listing of non-deleted stores. Pagination is
 * cursor-based on (created_at, id) so a row inserted at the head of
 * the table while a client is paging does not shift previously-seen
 * pages. The +1 fetch trick lets us decide "is there a next page"
 * without a separate COUNT query.
 */
export async function listStoresPage(
  pageSize: number,
  cursor: { created_at: string, id: string } | null,
): Promise<ListStoresPage> {
  const pool = getPool()
  const { rows } = await pool.query<StoreRow>(
    `SELECT id, name, created_at, updated_at, deleted_at
       FROM openfga.store
      WHERE deleted_at IS NULL
        AND ($1::timestamptz IS NULL
             OR (created_at, id) < ($1::timestamptz, $2::text))
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [cursor?.created_at ?? null, cursor?.id ?? null, pageSize + 1],
  )
  if (rows.length <= pageSize) {
    return { rows, nextCursor: null }
  }
  const page = rows.slice(0, pageSize)
  const last = page[page.length - 1]!
  return { rows: page, nextCursor: { created_at: last.created_at, id: last.id } }
}
