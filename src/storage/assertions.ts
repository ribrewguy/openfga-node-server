/**
 * Repository for `openfga.assertions` rows.
 *
 * Assertions are model-author-supplied test cases pinned to a
 * specific authorization_model_id. The table stores one row per
 * (store, model) and the PUT API replaces the whole assertions
 * array in a single upsert — there is no per-assertion identity to
 * track outside the document.
 *
 * Routes through Kysely via `getDb()` (openfga-19w). The `assertions`
 * column is declared as `JSONColumnType<Assertion[]>` in
 * `db-schema.ts`, so inserts pass a JSON-stringified value and
 * selects return the parsed array (auto-parsed on Postgres jsonb;
 * parsed via `ParseJSONResultsPlugin` on SQLite). The legacy
 * `::jsonb` cast at the call site is no longer needed.
 */
import type { Assertion } from '@openfga/sdk'
import { getDb, getDialect } from './db'
import { dialectNow } from './dialect'

export async function getAssertions(
  storeId: string,
  authorizationModelId: string,
): Promise<Assertion[]> {
  const row = await getDb()
    .selectFrom('assertions')
    .select('assertions')
    .where('store_id', '=', storeId)
    .where('authorization_model_id', '=', authorizationModelId)
    .executeTakeFirst()
  return row?.assertions ?? []
}

export async function writeAssertions(
  storeId: string,
  authorizationModelId: string,
  assertions: Assertion[],
): Promise<void> {
  const now = dialectNow(getDialect())
  await getDb()
    .insertInto('assertions')
    .values({
      store_id: storeId,
      authorization_model_id: authorizationModelId,
      // JSONColumnType<Assertion[]> insert type is `string` per Kysely's
      // contract (see authorization-models.ts for the same pattern).
      assertions: JSON.stringify(assertions),
      updated_at: now,
    })
    .onConflict(oc => oc
      .columns(['store_id', 'authorization_model_id'])
      .doUpdateSet(eb => ({
        // EXCLUDED.<col> references the row that would have been
        // inserted — both Postgres (since 9.5) and SQLite (since
        // 3.24) support this in ON CONFLICT DO UPDATE.
        assertions: eb.ref('excluded.assertions'),
        updated_at: now,
      })),
    )
    .execute()
}
