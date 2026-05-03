/**
 * OpenFGA-Node-Server: storage schema (initial).
 *
 * Mirrors the OpenFGA reference server's Postgres schema for the
 * subset this project implements (stores, authorization models,
 * tuples). A future migration to the upstream OpenFGA Go server is
 * mechanical: `pg_dump --schema=<namespace>` and point the new
 * server's `--datastore-uri` at the dump.
 *
 * Postgres path: tables live under the configured schema (e.g.
 * `openfga.store`); RLS is enabled with no policies so direct
 * non-service-role queries are denied.
 *
 * SQLite path: tables live under the configured prefix (e.g.
 * `openfga_store`); RLS has no equivalent (the prefix isn't a
 * security boundary — application-level discipline is).
 *
 * Translated from migrations/1777680000000_initial-openfga-schema.sql
 * by openfga-g2j when the project moved off node-pg-migrate.
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

  // Postgres-only: create the namespace schema. SQLite has no schema
  // concept — the table prefix plugin handles namespacing on the
  // application side.
  if (isPostgres(dialect)) {
    await sql`create schema if not exists ${sql.id(ns)}`.execute(db)
    await sql`comment on schema ${sql.id(ns)} is 'OpenFGA-Node-Server state. Stores, authorization models, and relationship tuples.'`.execute(db)
  }

  const ts = () => dialectTimestampColumn(dialect)
  const tsDefault = () => dialectNow(dialect)

  // ─── Stores ────────────────────────────────────────────────
  await db.schema
    .createTable('store')
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('created_at', ts(), col => col.notNull().defaultTo(tsDefault()))
    .addColumn('updated_at', ts(), col => col.notNull().defaultTo(tsDefault()))
    .addColumn('deleted_at', ts())
    .execute()

  // ─── Authorization models ──────────────────────────────────
  await db.schema
    .createTable('authorization_model')
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('store_id', 'text', col =>
      col.notNull().references(`${qualifyTable(dialect, ns, 'store')}.id`).onDelete('cascade'))
    .addColumn('schema_version', 'text', col => col.notNull())
    .addColumn('model', dialectJsonColumn(dialect), col => col.notNull())
    .addColumn('created_at', ts(), col => col.notNull().defaultTo(tsDefault()))
    .execute()

  await db.schema
    .createIndex('authorization_model_store_idx')
    .on('authorization_model')
    .columns(['store_id', 'created_at desc'])
    .execute()

  // ─── Tuples ────────────────────────────────────────────────
  await db.schema
    .createTable('tuple')
    .addColumn('store_id', 'text', col =>
      col.notNull().references(`${qualifyTable(dialect, ns, 'store')}.id`).onDelete('cascade'))
    .addColumn('object_type', 'text', col => col.notNull())
    .addColumn('object_id', 'text', col => col.notNull())
    .addColumn('relation', 'text', col => col.notNull())
    .addColumn('user_str', 'text', col => col.notNull())
    .addColumn('inserted_at', ts(), col => col.notNull().defaultTo(tsDefault()))
    .addPrimaryKeyConstraint('tuple_pkey', ['store_id', 'object_type', 'object_id', 'relation', 'user_str'])
    .execute()

  // For check evaluation: "what objects does this user have this relation on?"
  await db.schema
    .createIndex('tuple_user_lookup_idx')
    .on('tuple')
    .columns(['store_id', 'user_str', 'relation'])
    .execute()

  // For listObjects evaluation: "who has this relation on this object type?"
  await db.schema
    .createIndex('tuple_object_lookup_idx')
    .on('tuple')
    .columns(['store_id', 'object_type', 'relation', 'user_str'])
    .execute()

  // ─── Row-level security (Postgres only) ────────────────────
  if (isPostgres(dialect)) {
    for (const table of ['store', 'authorization_model', 'tuple']) {
      await sql`alter table ${sql.id(ns, table)} enable row level security`.execute(db)
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const dialect = getDialect()
  const ns = getNamespace()
  await db.schema.dropTable('tuple').execute()
  await db.schema.dropTable('authorization_model').execute()
  await db.schema.dropTable('store').execute()
  if (isPostgres(dialect)) {
    await sql`drop schema if exists ${sql.id(ns)} cascade`.execute(db)
  }
}

/**
 * Qualify a table reference for a foreign-key target. Kysely's
 * `.references()` takes a `'table.column'` string and doesn't go
 * through the prefix plugin or `withSchema`, so callers must spell
 * out the schema-qualified or prefix-qualified physical name.
 */
function qualifyTable(dialect: ReturnType<typeof getDialect>, ns: string, table: string): string {
  return isPostgres(dialect) ? `${ns}.${table}` : `${ns}_${table}`
}
