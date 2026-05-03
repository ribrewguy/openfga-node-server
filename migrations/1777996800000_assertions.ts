/**
 * OpenFGA-Node-Server: model assertion storage.
 *
 * Stores OpenFGA assertion sets — the "did this tuple_key resolve to
 * the expected boolean?" tests that an authorization model author
 * pins to a specific model version. Assertions are upserted in full
 * per (store, model) — the PUT API overwrites the whole array.
 *
 * Like idempotency_keys and tuple_change, this table is NOT part of
 * the OpenFGA-compatible state contract; exclude from pg_dump on
 * migration:
 *
 *   pg_dump --schema=<namespace> \
 *           --exclude-table='<namespace>.idempotency_keys' \
 *           --exclude-table='<namespace>.tuple_change' \
 *           --exclude-table='<namespace>.assertions'
 *
 * See docs/PRD.md and openfga-hqr for the full design.
 *
 * Translated from migrations/1777996800000_assertions.sql
 * by openfga-g2j.
 */
import { sql, type Kysely } from 'kysely'
import { getDialect, getNamespace } from '../src/storage/db'
import {
  dialectJsonColumn,
  dialectNow,
  dialectTimestampColumn,
  isPostgres,
} from '../src/storage/dialect'

export async function up(db: Kysely<unknown>): Promise<void> {
  const dialect = getDialect()
  const ns = getNamespace()
  const storeRef = isPostgres(dialect) ? `${ns}.store` : `${ns}_store`

  await db.schema
    .createTable('assertions')
    .addColumn('store_id', 'text', col => col.notNull().references(`${storeRef}.id`))
    // The model id is a soft reference. Models are immutable, so
    // there's no delete cascade to track. A row with a stale model
    // id is harmless.
    .addColumn('authorization_model_id', 'text', col => col.notNull())
    // The full assertions array stored as a single JSON document.
    .addColumn('assertions', dialectJsonColumn(dialect), col =>
      col.notNull().defaultTo(isPostgres(dialect) ? sql`'[]'::jsonb` : sql`'[]'`))
    .addColumn('updated_at', dialectTimestampColumn(dialect), col =>
      col.notNull().defaultTo(dialectNow(dialect)))
    .addPrimaryKeyConstraint('assertions_pkey', ['store_id', 'authorization_model_id'])
    .execute()

  if (isPostgres(dialect)) {
    await sql`alter table ${sql.id(ns, 'assertions')} enable row level security`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('assertions').execute()
}
