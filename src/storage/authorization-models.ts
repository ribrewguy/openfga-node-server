/**
 * Repository for `openfga.authorization_model` rows.
 *
 * Per OpenFGA semantics, models are immutable once written. The latest
 * model is the active one unless a caller explicitly pins a previous
 * `authorization_model_id` on a check or write request.
 *
 * Routes through Kysely via `getDb()` (openfga-n0m). The `model`
 * column is declared as `JSONColumnType` in `db-schema.ts`, so
 * inserts pass a `JSON.stringify`'d value and selects return the
 * parsed object — the explicit `::jsonb` cast that the legacy
 * pg.Pool path used is no longer needed. Postgres' jsonb auto-parses
 * on select; SQLite parses via `ParseJSONResultsPlugin` registered
 * by `getDb()`.
 */
import type { AuthorizationModel, TypeDefinition, Condition } from '@openfga/sdk'
import { getDb } from './db'
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

interface ParsedModel {
  schema_version?: string
  type_definitions?: TypeDefinition[]
  conditions?: { [k: string]: Condition }
}

interface RawRow {
  id: string
  store_id: string
  schema_version: string
  model: ParsedModel
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

const MODEL_COLUMNS = ['id', 'store_id', 'schema_version', 'model', 'created_at'] as const

export async function writeAuthorizationModel(
  storeId: string,
  model: AuthorizationModelInput,
): Promise<AuthorizationModelRow> {
  const id = generateId()
  const row = await getDb()
    .insertInto('authorization_model')
    .values({
      id,
      store_id: storeId,
      schema_version: model.schema_version ?? '1.1',
      // JSONColumnType<T> insert type is `string` — Kysely sends the
      // value as-is to the driver, which writes to a jsonb column on
      // Postgres or a TEXT column on SQLite.
      model: JSON.stringify(model),
    })
    .returning(MODEL_COLUMNS)
    .executeTakeFirstOrThrow()
  return rowToModel(row)
}

export async function getAuthorizationModel(
  storeId: string,
  modelId: string,
): Promise<AuthorizationModelRow | null> {
  const row = await getDb()
    .selectFrom('authorization_model')
    .select(MODEL_COLUMNS)
    .where('store_id', '=', storeId)
    .where('id', '=', modelId)
    .executeTakeFirst()
  return row ? rowToModel(row) : null
}

export async function getLatestAuthorizationModel(
  storeId: string,
): Promise<AuthorizationModelRow | null> {
  const row = await getDb()
    .selectFrom('authorization_model')
    .select(MODEL_COLUMNS)
    .where('store_id', '=', storeId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row ? rowToModel(row) : null
}

export async function listAuthorizationModels(
  storeId: string,
  pageSize: number,
): Promise<AuthorizationModelRow[]> {
  const rows = await getDb()
    .selectFrom('authorization_model')
    .select(MODEL_COLUMNS)
    .where('store_id', '=', storeId)
    .orderBy('created_at', 'desc')
    .limit(pageSize)
    .execute()
  return rows.map(rowToModel)
}
