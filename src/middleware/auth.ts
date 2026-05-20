/**
 * Caller-authentication middleware.
 *
 * Mirrors the OpenFGA reference server's `--authn-method` surface so
 * existing OpenFGA SDK clients port over without code changes:
 *
 *   - 'none'      — no auth check (default; preserves current behavior).
 *   - 'preshared' — request must carry `Authorization: Bearer <key>`
 *                   matching one of the configured preshared keys.
 *   - 'oidc'      — request must carry a Bearer JWT validated against
 *                   the configured issuer's JWKS (see docs/features/
 *                   oidc-auth.md for the validation pipeline).
 *
 * Configuration: see `docs/features/configuration.md`. The relevant
 * fields are `auth.mode`, `auth.presharedKeys`, and `auth.oidc.*`.
 * Env vars `OPENFGA_AUTH_*` continue to work as overrides per the
 * configuration spec's env-overlay rules.
 */
import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { logger } from '../logger'
import { config } from '../config'
import type { AuthMode, Config } from '../config-schema'
import { oidcMiddleware } from './oidc'

export type { AuthMode } from '../config-schema'

export interface AuthConfig {
  mode: AuthMode
  presharedKeys: string[]
  oidc: Config['auth']['oidc']
}

const ENVELOPE_401 = {
  code: 'unauthenticated',
  message: 'missing or invalid Authorization header',
}

/**
 * Return the resolved auth configuration. Reads from the loaded
 * `config.auth` so env-var overrides, file-based defaults, and
 * cross-field validation are all already applied. The function shape
 * is kept (rather than a bare property reference) so callers can mock
 * via `vi.spyOn(authConfigModule, 'getAuthConfig')` if needed.
 */
export function getAuthConfig(): AuthConfig {
  return {
    mode: config.auth.mode,
    presharedKeys: config.auth.presharedKeys,
    oidc: config.auth.oidc,
  }
}

/**
 * Build the auth middleware for the given config. The dispatcher
 * picks the implementation at composition time (server boot) so
 * the per-request hot path doesn't repeat the mode check.
 */
export function authMiddleware(authConfig: AuthConfig): MiddlewareHandler {
  if (authConfig.mode === 'none') {
    return async (_c, next) => {
      await next()
    }
  }

  if (authConfig.mode === 'oidc') {
    return oidcMiddleware(authConfig.oidc)
  }

  // Pre-encode keys to Buffers once so the request hot path is just
  // a length check + timingSafeEqual per configured key.
  const keyBuffers = authConfig.presharedKeys.map((k) => Buffer.from(k, 'utf8'))

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
