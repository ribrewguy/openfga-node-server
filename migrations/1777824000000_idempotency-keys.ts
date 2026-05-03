/**
 * OpenFGA-Node-Server: idempotency-key storage.
 *
 * Stores Idempotency-Key state for mutating endpoints so retries
 * after timeouts, network failures, or ambiguous responses replay
 * the original response instead of duplicating side effects.
 *
 * This table lives alongside the OpenFGA tables in the configured
 * namespace for operational simplicity. It is NOT part of the
 * OpenFGA-compatible state contract and must be excluded from schema
 * dumps that target upstream OpenFGA migration:
 *
 *   pg_dump --schema=<namespace> \
 *           --exclude-table='<namespace>.idempotency_keys'
 *
 * See docs/PRD.md §"Idempotency keys" and
 * docs/features/idemnpotency-keys.md for the full design.
 *
 * Translated from migrations/1777824000000_idempotency-keys.sql
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

  await db.schema
    .createTable('idempotency_keys')
    .addColumn('key', 'text', col => col.primaryKey())
    .addColumn('request_hash', 'text', col => col.notNull())
    .addColumn('status', 'text', col =>
      col.notNull().check(sql`status in ('in_flight', 'completed')`))
    .addColumn('response_status', 'integer')
    .addColumn('response_body', dialectJsonColumn(dialect))
    .addColumn('created_at', dialectTimestampColumn(dialect), col =>
      col.notNull().defaultTo(dialectNow(dialect)))
    .addColumn('completed_at', dialectTimestampColumn(dialect))
    .execute()

  // Supports the TTL-aware cleanup query that removes expired rows
  // before a fresh claim. Without this index, cleanup would scan the
  // whole table on every contended claim.
  await db.schema
    .createIndex('idempotency_keys_created_at_idx')
    .on('idempotency_keys')
    .columns(['created_at'])
    .execute()

  // Match the schema-wide RLS posture: deny by default, server
  // bypasses as service-role.
  if (isPostgres(dialect)) {
    await sql`alter table ${sql.id(ns, 'idempotency_keys')} enable row level security`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('idempotency_keys').execute()
}
