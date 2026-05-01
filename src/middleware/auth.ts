/**
 * Caller-authentication middleware.
 *
 * Mirrors the OpenFGA reference server's `--authn-method` surface so
 * existing OpenFGA SDK clients port over without code changes:
 *
 *   - 'none'      — no auth check (default; preserves current behavior).
 *   - 'preshared' — request must carry `Authorization: Bearer <key>`
 *                   matching one of the configured preshared keys.
 *
 * OIDC is a separate mode tracked by openfga-711; this file's
 * dispatcher leaves room for it without committing to its shape.
 *
 * Configuration:
 *   - OPENFGA_AUTH_MODE              'none' | 'preshared'  (default 'none')
 *   - OPENFGA_AUTH_PRESHARED_KEYS    comma-separated keys; required when
 *                                    mode is 'preshared'
 *
 * The comma-separated key list mirrors the upstream Go server's
 * `--authn-preshared-keys` flag and supports zero-downtime rotation:
 * deploy with both old and new keys, rotate clients, then deploy
 * without the old key.
 */
import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { logger } from '../logger'

export type AuthMode = 'none' | 'preshared'

export interface AuthConfig {
  mode: AuthMode
  presharedKeys: string[]
}

const ENVELOPE_401 = {
  code: 'unauthenticated',
  message: 'missing or invalid Authorization header',
}

/**
 * Read and validate auth configuration from environment variables.
 * Throws on bad config so the server fails fast at startup rather
 * than serving traffic with a misconfigured security posture.
 */
export function loadAuthConfigFromEnv(): AuthConfig {
  const rawMode = (process.env['OPENFGA_AUTH_MODE'] ?? 'none').trim().toLowerCase()
  if (rawMode !== 'none' && rawMode !== 'preshared') {
    throw new Error(
      `OPENFGA_AUTH_MODE must be 'none' or 'preshared'; got "${process.env['OPENFGA_AUTH_MODE']}"`,
    )
  }
  const mode = rawMode as AuthMode

  const rawKeys = (process.env['OPENFGA_AUTH_PRESHARED_KEYS'] ?? '').trim()
  const keys = rawKeys
    ? rawKeys.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
    : []

  if (mode === 'preshared' && keys.length === 0) {
    throw new Error(
      'OPENFGA_AUTH_MODE=preshared requires OPENFGA_AUTH_PRESHARED_KEYS to be set with at least one non-empty key',
    )
  }

  return { mode, presharedKeys: keys }
}

/**
 * Build the auth middleware for the given config. The dispatcher
 * picks the implementation at composition time (server boot) so
 * the per-request hot path doesn't repeat the mode check.
 */
export function authMiddleware(config: AuthConfig): MiddlewareHandler {
  if (config.mode === 'none') {
    return async (_c, next) => {
      await next()
    }
  }

  // Pre-encode keys to Buffers once so the request hot path is just
  // a length check + timingSafeEqual per configured key.
  const keyBuffers = config.presharedKeys.map((k) => Buffer.from(k, 'utf8'))

  return async (c, next) => {
    const header = c.req.header('Authorization')
    if (!header || !header.startsWith('Bearer ')) {
      logger.warn(
        { reason: 'missing_or_malformed_header', method: c.req.method, path: c.req.path },
        'auth_rejected',
      )
      return c.json(ENVELOPE_401, 401)
    }

    const presented = Buffer.from(header.slice('Bearer '.length), 'utf8')
    // timingSafeEqual requires equal-length buffers; the length check
    // is itself non-constant-time but only leaks the length of the
    // accepted key, which is not a useful oracle on its own.
    let matched = false
    for (const k of keyBuffers) {
      if (k.length === presented.length && timingSafeEqual(k, presented)) {
        matched = true
        // Do not break — keep work uniform across keys to limit
        // any timing signal about which key matched.
      }
    }

    if (!matched) {
      logger.warn(
        { reason: 'key_mismatch', method: c.req.method, path: c.req.path },
        'auth_rejected',
      )
      return c.json(ENVELOPE_401, 401)
    }

    await next()
  }
}
