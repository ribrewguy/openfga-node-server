/**
 * Repository for `openfga.assertions` rows.
 *
 * Assertions are model-author-supplied test cases pinned to a
 * specific authorization_model_id. The table stores one row per
 * (store, model) and the PUT API replaces the whole assertions
 * array in a single upsert — there is no per-assertion identity to
 * track outside the document.
 */
import type { Assertion } from '@openfga/sdk'
import { getPool } from './pool'

export async function getAssertions(
  storeId: string,
  authorizationModelId: string,
): Promise<Assertion[]> {
  const pool = getPool()
  const { rows } = await pool.query<{ assertions: Assertion[] }>(
    `SELECT assertions
       FROM openfga.assertions
      WHERE store_id = $1 AND authorization_model_id = $2`,
    [storeId, authorizationModelId],
  )
  return rows[0]?.assertions ?? []
}

export async function writeAssertions(
  storeId: string,
  authorizationModelId: string,
  assertions: Assertion[],
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO openfga.assertions (store_id, authorization_model_id, assertions, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (store_id, authorization_model_id) DO UPDATE
       SET assertions = EXCLUDED.assertions,
           updated_at = now()`,
    [storeId, authorizationModelId, JSON.stringify(assertions)],
  )
}
