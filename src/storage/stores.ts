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
