/**
 * Idempotency-Key middleware.
 *
 * Implements the design in docs/features/idemnpotency-keys.md and
 * the PRD §"Idempotency keys" section. Lets clients safely retry
 * mutating requests after timeouts, dropped connections, or
 * ambiguous responses without duplicating side effects.
 *
 * Modes:
 *   - 'off'      — middleware is a no-op. Default.
 *   - 'optional' — Idempotency-Key is honored when present, ignored
 *                  when absent.
 *   - 'required' — scoped mutating requests must include
 *                  Idempotency-Key; missing keys return 400.
 *
 * Scope:
 *
 * The middleware applies only to paths whose `(method, path)` pair
 * is registered via `idempotencyMiddleware({ scopes: [...] })`. Other
 * requests pass through unchanged. The path matcher uses Hono's
 * route-style placeholders (e.g. '/stores/:storeId/write').
 *
 * Concurrency:
 *
 * - Same key + same fingerprint, no in-flight request → replay the
 *   original cached response.
 * - Same key + same fingerprint, in-flight request → 409.
 * - Same key + different fingerprint → 422.
 *
 * Fingerprint = SHA-256 of `<METHOD> <ROUTE>\n<RAW BODY>`, where
 * <ROUTE> is the matched route pattern (so different stores hitting
 * the same route share the same scope but different bodies still
 * produce different fingerprints via the body bytes).
 *
 * Storage failures bubble up as 503 so retries can succeed once the
 * store recovers.
 */
import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { logger } from '../logger'
import { claimKey, completeKey, releaseKey } from '../storage/idempotency'

export type IdempotencyMode = 'off' | 'optional' | 'required'

export interface IdempotencyScope {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /**
   * Hono-style route pattern. Must match the route registration the
   * handler uses (e.g. '/stores/:storeId/write'). The pattern is used
   * verbatim as the matchedPath component of the fingerprint, so it
   * is stable across stores while still distinguishing routes.
   */
  path: string
}

export interface IdempotencyOptions {
  scopes: IdempotencyScope[]
  /** Override env-derived mode. Primarily for tests. */
  mode?: IdempotencyMode
  /** Override env-derived TTL. Primarily for tests. */
  ttlMs?: number
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

const ERROR_ENVELOPES = {
  missing_key: { code: 'invalid_argument', message: 'Idempotency-Key header is required' },
  empty_key: { code: 'invalid_argument', message: 'Idempotency-Key header must not be empty' },
  in_flight: { code: 'idempotency_in_flight', message: 'a previous request with this Idempotency-Key is still being processed' },
  mismatch: { code: 'idempotency_fingerprint_mismatch', message: 'Idempotency-Key was reused with a different request fingerprint' },
  unavailable: { code: 'idempotency_store_unavailable', message: 'idempotency store is unavailable; retry later' },
} as const

function readModeFromEnv(): IdempotencyMode {
  const raw = (process.env['OPENFGA_IDEMPOTENCY_MODE'] ?? 'off').trim().toLowerCase()
  if (raw === 'off' || raw === 'optional' || raw === 'required') return raw
  throw new Error(
    `[openfga] OPENFGA_IDEMPOTENCY_MODE must be one of: off, optional, required. Got "${raw}".`,
  )
}

function readTtlFromEnv(): number {
  const raw = process.env['OPENFGA_IDEMPOTENCY_TTL_MS']
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`[openfga] OPENFGA_IDEMPOTENCY_TTL_MS must be a positive integer; got "${raw}".`)
  }
  return n
}

function pathMatches(routePattern: string, requestPath: string): boolean {
  if (routePattern === requestPath) return true
  const patternParts = routePattern.split('/')
  const requestParts = requestPath.split('/')
  if (patternParts.length !== requestParts.length) return false
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!
    const r = requestParts[i]!
    if (p.startsWith(':')) continue
    if (p !== r) return false
  }
  return true
}

function findScope(scopes: IdempotencyScope[], method: string, path: string): IdempotencyScope | null {
  for (const scope of scopes) {
    if (scope.method === method && pathMatches(scope.path, path)) return scope
  }
  return null
}

function fingerprint(method: string, routePattern: string, rawBody: string): string {
  return createHash('sha256').update(`${method} ${routePattern}\n${rawBody}`).digest('hex')
}

function keyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Build a Hono middleware that enforces Idempotency-Key for the
 * configured scopes. Reads `OPENFGA_IDEMPOTENCY_MODE` and
 * `OPENFGA_IDEMPOTENCY_TTL_MS` from the environment unless overrides
 * are passed.
 */
export function idempotencyMiddleware(options: IdempotencyOptions): MiddlewareHandler {
  const mode = options.mode ?? readModeFromEnv()
  const ttlMs = options.ttlMs ?? readTtlFromEnv()
  const scopes = options.scopes

  return async (c, next) => {
    if (mode === 'off') return next()

    const scope = findScope(scopes, c.req.method, c.req.path)
    if (!scope) return next()

    const headerValue = c.req.header('Idempotency-Key')
    const key = headerValue?.trim() ?? ''

    if (key === '') {
      if (mode === 'required') {
        const envelope = headerValue === undefined ? ERROR_ENVELOPES.missing_key : ERROR_ENVELOPES.empty_key
        return c.json(envelope, 400)
      }
      return next()
    }

    let rawBody: string
    try {
      rawBody = await c.req.text()
    }
    catch (err) {
      logger.warn({ err, key_hash: keyHash(key) }, 'idempotency_body_read_failed')
      return c.json(ERROR_ENVELOPES.unavailable, 503)
    }

    const fp = fingerprint(scope.method, scope.path, rawBody)
    const keyLog = { key_hash: keyHash(key), method: scope.method, route: scope.path }

    let claim
    try {
      claim = await claimKey(key, fp, ttlMs)
    }
    catch (err) {
      logger.error({ err, ...keyLog }, 'idempotency_store_unavailable')
      return c.json(ERROR_ENVELOPES.unavailable, 503)
    }

    if (claim.kind === 'in_flight') {
      logger.info(keyLog, 'idempotency_in_flight')
      return c.json(ERROR_ENVELOPES.in_flight, 409)
    }
    if (claim.kind === 'mismatch') {
      logger.info(keyLog, 'idempotency_fingerprint_mismatch')
      return c.json(ERROR_ENVELOPES.mismatch, 422)
    }
    if (claim.kind === 'replay') {
      logger.info({ ...keyLog, replay_status: claim.status }, 'idempotency_replay')
      return new Response(JSON.stringify(claim.body), {
        status: claim.status,
        headers: { 'content-type': 'application/json' },
      })
    }

    // claim.kind === 'claimed' — we own the slot. Run the handler,
    // capture the response, persist it for replay (or drop the slot
    // on 5xx so retries can succeed).
    try {
      await next()
    }
    catch (err) {
      logger.warn({ err, ...keyLog }, 'idempotency_handler_threw')
      try {
        await releaseKey(key)
      }
      catch (releaseErr) {
        logger.error({ err: releaseErr, ...keyLog }, 'idempotency_release_failed')
      }
      throw err
    }

    const status = c.res.status
    if (status >= 500) {
      logger.info({ ...keyLog, status }, 'idempotency_release_5xx')
      try {
        await releaseKey(key)
      }
      catch (err) {
        logger.error({ err, ...keyLog }, 'idempotency_release_failed')
      }
      return
    }

    let body: unknown
    try {
      const cloned = c.res.clone()
      const text = await cloned.text()
      body = text === '' ? null : JSON.parse(text)
    }
    catch (err) {
      logger.warn({ err, ...keyLog }, 'idempotency_response_capture_failed')
      try {
        await releaseKey(key)
      }
      catch (releaseErr) {
        logger.error({ err: releaseErr, ...keyLog }, 'idempotency_release_failed')
      }
      return
    }

    try {
      await completeKey(key, status, body)
      logger.info({ ...keyLog, status }, 'idempotency_complete')
    }
    catch (err) {
      logger.error({ err, ...keyLog }, 'idempotency_complete_failed')
      // Best-effort cleanup. The original response still goes to the
      // client; the row will eventually be reaped by TTL.
      try {
        await releaseKey(key)
      }
      catch { /* swallow */ }
    }
  }
}
