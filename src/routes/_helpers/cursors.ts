/**
 * Continuation-token encoders / decoders shared across paginated
 * routes. All cursors are base64url(JSON(payload)) so they round-trip
 * cleanly through any HTTP client and so a malformed token can be
 * rejected at the decode boundary (400 invalid_argument) rather than
 * surfacing as a Postgres error inside the handler.
 *
 * Cursor shapes:
 *
 *   StoreCursor   { created_at, id }              — GET /stores
 *   ReadTupleCursor (re-exported from storage)    — POST /stores/:storeId/read
 *   ChangeCursor  { inserted_at, seq, type|null } — GET /stores/:storeId/changes
 */
import type { ReadTupleCursor } from '../../storage/tuples'

export interface StoreCursor {
  created_at: string
  id: string
}

/**
 * Continuation tokens for /changes pagination. Carries (inserted_at,
 * seq) for deterministic per-insertion ordering (see openfga-ra9
 * migration 1778083200000_tuple-change-seq.sql) plus the type filter
 * that produced the token. The type field lets the route handler
 * reject cross-filter token reuse: a token issued by `?type=doc`
 * cannot be replayed without `?type=doc` (or with a different type),
 * which would otherwise leak unrelated object-type changes into a
 * filtered polling stream.
 */
export interface ChangeCursor {
  inserted_at: string
  seq: string
  /** Object-type filter active when the cursor was issued; null when no filter. */
  type: string | null
}

/**
 * True when `value` parses as a real ISO 8601 / RFC 3339 timestamp.
 * Cursor decoders use this so a base64url-JSON token carrying
 * `inserted_at: "not-a-timestamp"` is rejected at the decode boundary
 * (400 invalid_argument) instead of reaching Postgres which would
 * surface a 22007 invalid_datetime_format error as a 500. See
 * openfga-5uv review.
 */
function isParseableTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

export function encodeStoreCursor(c: StoreCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

export function decodeStoreCursor(token: string): StoreCursor | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as StoreCursor).created_at === 'string'
      && isParseableTimestamp((parsed as StoreCursor).created_at)
      && typeof (parsed as StoreCursor).id === 'string'
    ) {
      return parsed as StoreCursor
    }
    return null
  }
  catch {
    return null
  }
}

export function encodeReadCursor(c: ReadTupleCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

export function decodeReadCursor(token: string): ReadTupleCursor | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as ReadTupleCursor).inserted_at === 'string'
      && isParseableTimestamp((parsed as ReadTupleCursor).inserted_at)
      && typeof (parsed as ReadTupleCursor).object_type === 'string'
      && typeof (parsed as ReadTupleCursor).object_id === 'string'
      && typeof (parsed as ReadTupleCursor).relation === 'string'
      && typeof (parsed as ReadTupleCursor).user_str === 'string'
    ) {
      return parsed as ReadTupleCursor
    }
    return null
  }
  catch {
    return null
  }
}

export function encodeChangeCursor(c: ChangeCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

export function decodeChangeCursor(token: string): ChangeCursor | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as ChangeCursor).inserted_at === 'string'
      && isParseableTimestamp((parsed as ChangeCursor).inserted_at)
      && typeof (parsed as ChangeCursor).seq === 'string'
      && (
        (parsed as ChangeCursor).type === null
        || typeof (parsed as ChangeCursor).type === 'string'
      )
    ) {
      return parsed as ChangeCursor
    }
    return null
  }
  catch {
    return null
  }
}
