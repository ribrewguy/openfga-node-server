/**
 * Storage layer for `openfga.idempotency_keys`.
 *
 * The middleware in `src/middleware/idempotency.ts` is the only
 * consumer. The functions here encapsulate the SQL and the
 * concurrency protocol so the middleware can stay readable.
 *
 * Routes through Kysely via `getDb()` (openfga-6tv). The TTL cutoff
 * is rendered by `dialectNowMinus(dialect, ms)` so the openfga-how
 * SQL-side cutoff (cutoff and `created_at` share the database's
 * clock) is preserved across both engines.
 *
 * Concurrency model:
 *
 *   - `claimKey` is the atomic entry point. It deletes any expired
 *     row for the key, then attempts an `INSERT ... ON CONFLICT
 *     (key) DO NOTHING`. If the insert wins, the caller owns the
 *     slot and must eventually call `completeKey` or `releaseKey`.
 *     If the insert loses, the caller reads the existing row to
 *     classify the result as in-flight, replay, or mismatch.
 *
 *   - `completeKey` records a final response so subsequent retries
 *     replay it.
 *
 *   - `releaseKey` removes an in-flight row when the handler errored
 *     (5xx or thrown exception) so the client can retry cleanly.
 */
import { sql } from 'kysely'
import { getDb, getDialect } from './db'
import { dialectNow, dialectNowMinus } from './dialect'

export type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'in_flight' }
  | { kind: 'mismatch' }
  | { kind: 'replay', status: number, body: unknown }

/**
 * Atomically claim an idempotency-key slot or classify the existing
 * record. The `ttlMs` is enforced here: rows older than the cutoff
 * are deleted before the claim attempt, so TTL needs no separate
 * cleanup job.
 *
 * Returns:
 *   - 'claimed' — the caller owns the slot and must follow up with
 *     `completeKey` (success / 4xx) or `releaseKey` (5xx / thrown).
 *   - 'in_flight' — a concurrent request holds the slot. Caller
 *     should respond 409.
 *   - 'mismatch' — the slot is claimed with a different fingerprint.
 *     Caller should respond 422.
 *   - 'replay' — the slot is completed and the cached response
 *     should be returned to the client.
 */
export async function claimKey(
  key: string,
  fingerprint: string,
  ttlMs: number,
): Promise<ClaimResult> {
  // The DELETE+INSERT+SELECT runs as three separate queries against
  // the configured Kysely instance. The original pool.connect()
  // wrapper on the legacy pg.Pool path was a perf optimization (one
  // checkout for three queries); we deliberately do NOT use Kysely's
  // analogous getDb().connection().execute() here because it
  // deadlocks under sequential claimKey() calls on the SqliteDialect
  // (the single-connection lock isn't released cleanly between
  // calls; see openfga-8ys investigation). The auto-checkout cost on
  // Postgres is negligible compared to the correctness win on
  // SQLite. ON CONFLICT DO NOTHING is row-atomic at the engine
  // level, so no wrapping transaction is needed for the three-step
  // protocol.
  const dialect = getDialect()
  return await claimWithDb(dialect, key, fingerprint, ttlMs)
}

async function claimWithDb(
  dialect: ReturnType<typeof getDialect>,
  key: string,
  fingerprint: string,
  ttlMs: number,
): Promise<ClaimResult> {
  const db = getDb()

  // Compute the TTL cutoff in SQL so it shares the clock that wrote
  // `created_at`. A JS-computed cutoff (Date.now() - ttlMs) compared
  // against the row's database-assigned `created_at` is a clock-skew
  // race: even microsecond drift between the application container
  // and the DB can leave rows strictly after the JS cutoff, making
  // the DELETE silently miss them and the SELECT then return them
  // with a stale fingerprint. See openfga-how.
  await db
    .deleteFrom('idempotency_keys')
    .where('key', '=', key)
    .where(sql<boolean>`created_at < ${dialectNowMinus(dialect, ttlMs)}`)
    .execute()

  const insertResult = await db
    .insertInto('idempotency_keys')
    .values({ key, request_hash: fingerprint, status: 'in_flight' })
    .onConflict(oc => oc.column('key').doNothing())
    .returning('key')
    .executeTakeFirst()

  if (insertResult) return { kind: 'claimed' }

  const lookup = await db
    .selectFrom('idempotency_keys')
    .select(['request_hash', 'status', 'response_status', 'response_body'])
    .where('key', '=', key)
    .where(sql<boolean>`created_at >= ${dialectNowMinus(dialect, ttlMs)}`)
    .executeTakeFirst()

  // The row was deleted between our DELETE and INSERT (rare TTL race).
  // Retry once — the second attempt will succeed because no other
  // request is holding the slot.
  if (!lookup) {
    return claimWithDb(dialect, key, fingerprint, ttlMs)
  }

  if (lookup.request_hash !== fingerprint) return { kind: 'mismatch' }
  if (lookup.status === 'in_flight') return { kind: 'in_flight' }

  return {
    kind: 'replay',
    status: lookup.response_status ?? 500,
    body: lookup.response_body,
  }
}

export async function completeKey(
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await getDb()
    .updateTable('idempotency_keys')
    .set({
      status: 'completed',
      response_status: status,
      // JSON column insert/update type is `string | null` per the
      // ColumnType deviation documented in db-schema.ts; the caller
      // hands us an arbitrary value, we stringify (or null when
      // undefined) to match the legacy contract.
      response_body: body === undefined ? null : JSON.stringify(body),
      completed_at: dialectNow(getDialect()),
    })
    .where('key', '=', key)
    .execute()
}

export async function releaseKey(key: string): Promise<void> {
  await getDb()
    .deleteFrom('idempotency_keys')
    .where('key', '=', key)
    .execute()
}
