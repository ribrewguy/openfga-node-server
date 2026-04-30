/**
 * Repository for `openfga.authorization_model` rows.
 *
 * Per OpenFGA semantics, models are immutable once written. The latest
 * model is the active one unless a caller explicitly pins a previous
 * `authorization_model_id` on a check or write request.
 */
import type { AuthorizationModel, TypeDefinition, Condition } from '@openfga/sdk'
import { getPool } from './pool'
import { generateId } from './ids'

/**
 * The shape `transformDSLToJSONObject` from @openfga/syntax-transformer
 * returns. Contains everything except the server-assigned `id`.
 */
export type AuthorizationModelInput = Omit<AuthorizationModel, 'id'>

export interface AuthorizationModelRow {
  id: string
  store_id: string
  schema_version: string
  type_definitions: TypeDefinition[]
  conditions: { [k: string]: Condition } | null
  created_at: string
}

interface RawRow {
  id: string
  store_id: string
  schema_version: string
  model: AuthorizationModelInput
  created_at: string
}

function rowToModel(raw: RawRow): AuthorizationModelRow {
  return {
    id: raw.id,
    store_id: raw.store_id,
    schema_version: raw.schema_version,
    type_definitions: raw.model.type_definitions ?? [],
    conditions: raw.model.conditions ?? null,
    created_at: raw.created_at,
  }
}

export async function writeAuthorizationModel(
  storeId: string,
  model: AuthorizationModelInput,
): Promise<AuthorizationModelRow> {
  const id = generateId()
  const pool = getPool()
  const { rows } = await pool.query<RawRow>(
    `INSERT INTO openfga.authorization_model (id, store_id, schema_version, model)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, store_id, schema_version, model, created_at`,
    [id, storeId, model.schema_version ?? '1.1', JSON.stringify(model)],
  )
  return rowToModel(rows[0]!)
}

export async function getAuthorizationModel(
  storeId: string,
  modelId: string,
): Promise<AuthorizationModelRow | null> {
  const pool = getPool()
  const { rows } = await pool.query<RawRow>(
    `SELECT id, store_id, schema_version, model, created_at
       FROM openfga.authorization_model
      WHERE store_id = $1 AND id = $2`,
    [storeId, modelId],
  )
  return rows[0] ? rowToModel(rows[0]) : null
}

export async function getLatestAuthorizationModel(
  storeId: string,
): Promise<AuthorizationModelRow | null> {
  const pool = getPool()
  const { rows } = await pool.query<RawRow>(
    `SELECT id, store_id, schema_version, model, created_at
       FROM openfga.authorization_model
      WHERE store_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [storeId],
  )
  return rows[0] ? rowToModel(rows[0]) : null
}

export async function listAuthorizationModels(
  storeId: string,
  pageSize: number,
): Promise<AuthorizationModelRow[]> {
  const pool = getPool()
  const { rows } = await pool.query<RawRow>(
    `SELECT id, store_id, schema_version, model, created_at
       FROM openfga.authorization_model
      WHERE store_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [storeId, pageSize],
  )
  return rows.map(rowToModel)
}
