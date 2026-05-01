/**
 * Storage layer for `openfga.idempotency_keys`.
 *
 * The middleware in `src/middleware/idempotency.ts` is the only
 * consumer. The functions here encapsulate the SQL and the
 * concurrency protocol so the middleware can stay readable.
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
import type { PoolClient } from 'pg'
import { getPool } from './pool'

export type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'in_flight' }
  | { kind: 'mismatch' }
  | { kind: 'replay'; status: number; body: unknown }

interface IdempotencyRow {
  request_hash: string
  status: 'in_flight' | 'completed'
  response_status: number | null
  response_body: unknown
}

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
  const pool = getPool()
  const client = await pool.connect()
  try {
    return await claimWithClient(client, key, fingerprint, ttlMs)
  }
  finally {
    client.release()
  }
}

async function claimWithClient(
  client: PoolClient,
  key: string,
  fingerprint: string,
  ttlMs: number,
): Promise<ClaimResult> {
  // Compute the TTL cutoff in SQL so it shares the clock that wrote
  // `created_at`. A JS-computed cutoff (Date.now() - ttlMs) compared
  // against the row's Postgres-assigned `created_at` is a clock-skew
  // race: even microsecond drift between the application container
  // and the DB can leave rows strictly after the JS cutoff, making
  // the DELETE silently miss them and the SELECT then return them
  // with a stale fingerprint.
  //
  // Postgres `now()` returns transaction-start time, which is
  // monotonic across separate (autocommit) transactions on the same
  // connection — so any row inserted by an earlier query can never
  // appear "future-dated" relative to a later cutoff.
  await client.query(
    `DELETE FROM openfga.idempotency_keys
      WHERE key = $1
        AND created_at < now() - $2::int * interval '1 millisecond'`,
    [key, ttlMs],
  )

  const insert = await client.query<{ key: string }>(
    `INSERT INTO openfga.idempotency_keys (key, request_hash, status)
     VALUES ($1, $2, 'in_flight')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, fingerprint],
  )

  if ((insert.rowCount ?? 0) === 1) return { kind: 'claimed' }

  const lookup = await client.query<IdempotencyRow>(
    `SELECT request_hash, status, response_status, response_body
       FROM openfga.idempotency_keys
      WHERE key = $1
        AND created_at >= now() - $2::int * interval '1 millisecond'`,
    [key, ttlMs],
  )
  const row = lookup.rows[0]

  // The row was deleted between our DELETE and INSERT (rare TTL race).
  // Retry once — the second attempt will succeed because no other
  // request is holding the slot.
  if (!row) {
    return claimWithClient(client, key, fingerprint, ttlMs)
  }

  if (row.request_hash !== fingerprint) return { kind: 'mismatch' }
  if (row.status === 'in_flight') return { kind: 'in_flight' }

  return {
    kind: 'replay',
    status: row.response_status ?? 500,
    body: row.response_body,
  }
}

export async function completeKey(
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE openfga.idempotency_keys
        SET status = 'completed',
            response_status = $1,
            response_body = $2,
            completed_at = now()
      WHERE key = $3`,
    [status, body === undefined ? null : body, key],
  )
}

export async function releaseKey(key: string): Promise<void> {
  const pool = getPool()
  await pool.query(
    `DELETE FROM openfga.idempotency_keys WHERE key = $1`,
    [key],
  )
}
