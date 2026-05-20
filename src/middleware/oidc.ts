/**
 * OIDC bearer-token middleware.
 *
 * Per docs/features/oidc-auth.md. Validates `Authorization: Bearer <jwt>`
 * against the configured issuer's published JWKS using `jose.jwtVerify`
 * with the algorithm allowlist, issuer / audience / expiry / not-before
 * claims, and optional `sub` and `client_id`/`azp` allowlists.
 *
 * Client-facing failures are uniformly `401 { code: 'unauthenticated',
 * message: 'missing or invalid Authorization header' }`. Operators get
 * the actual distinguishing `reason` in structured logs (see the table
 * in oidc-auth.md §"Error Semantics"). Returning a more informative
 * client response leaks JWT validation oracles to attackers.
 *
 * The middleware factory does NOT block on JWKS contents — the set is
 * lazily fetched on first request via jose.createRemoteJWKSet. OIDC
 * issuer discovery (resolving the `jwks_uri` from
 * `${issuer}/.well-known/openid-configuration`) happens at factory
 * call time when no explicit `jwksUri` is configured. A discovery
 * failure is fatal: it surfaces as a thrown `OidcDiscoveryError` so
 * the server bootstrap can log FATAL and exit before binding any
 * listener.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import { logger } from '../logger'
import type { Config } from '../config-schema'

export type OidcConfig = Config['auth']['oidc']

const ENVELOPE_401 = {
  code: 'unauthenticated',
  message: 'missing or invalid Authorization header',
}

const DISCOVERY_TIMEOUT_MS = 5_000
const DISCOVERY_RETRY_COUNT = 1

interface OidcDiscoveryDocument {
  jwks_uri?: string
}

/**
 * Raised when OIDC issuer discovery fails at startup. Callers
 * (server bootstrap) are expected to log FATAL and exit non-zero;
 * the server must not bind listeners against a misconfigured
 * OIDC mode.
 */
export class OidcDiscoveryError extends Error {
  override readonly name = 'OidcDiscoveryError'
}

/**
 * Resolve the JWKS URI: explicit `jwksUri` config wins; otherwise
 * fetch `${issuer}/.well-known/openid-configuration` and read its
 * `jwks_uri`. One retry on transient failure. 5-second per-attempt
 * timeout. Throws `OidcDiscoveryError` if both attempts fail.
 */
async function resolveJwksUri(oidc: OidcConfig): Promise<string> {
  if (oidc.jwksUri) return oidc.jwksUri

  const issuer = oidc.issuer
  if (!issuer) {
    // Schema-level validation should have caught this. Defensive throw
    // so a tampered Config object surfaces here rather than during
    // request handling.
    throw new OidcDiscoveryError('auth.oidc.issuer is not set; cannot run OIDC discovery')
  }
  const discoveryUrl = new URL('.well-known/openid-configuration', issuer.endsWith('/') ? issuer : `${issuer}/`)

  let lastErr: unknown
  for (let attempt = 0; attempt <= DISCOVERY_RETRY_COUNT; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
      try {
        const res = await fetch(discoveryUrl, { signal: controller.signal })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} from ${discoveryUrl}`)
        }
        const doc = (await res.json()) as OidcDiscoveryDocument
        if (!doc.jwks_uri) {
          throw new Error(`discovery document at ${discoveryUrl} missing jwks_uri`)
        }
        return doc.jwks_uri
      }
      finally {
        clearTimeout(timeout)
      }
    }
    catch (err) {
      lastErr = err
    }
  }
  throw new OidcDiscoveryError(
    `OIDC discovery failed for ${discoveryUrl.toString()}: ${(lastErr as Error)?.message ?? String(lastErr)}`,
  )
}

interface LogContext {
  method: string
  path: string
}

function reject(c: Context, ctx: LogContext, reason: string, extra: Record<string, unknown> = {}): Response {
  logger.warn({ ...ctx, ...extra, reason }, 'auth_rejected')
  return c.json(ENVELOPE_401, 401)
}

/**
 * Build the OIDC middleware. Resolves the JWKS URI eagerly (issuer
 * discovery or explicit config) so a misconfigured issuer is fatal
 * before any listener binds. Per-request validation runs entirely
 * via jose.jwtVerify against the constructed JWKS.
 */
type JwksReady =
  | { ok: true, jwks: JWTVerifyGetKey }
  | { ok: false, err: unknown }

export function oidcMiddleware(oidc: OidcConfig): MiddlewareHandler {
  // Kick off JWKS resolution at factory time so a follow-up request
  // doesn't pay the cold-start cost. The result is materialized into
  // a *non-rejecting* promise — Node's unhandled-rejection signal
  // fires for promises whose rejection nobody has awaited yet, so a
  // raw rejected promise here would crash the process on boot when
  // discovery fails even though we intend to surface the failure
  // per-request below. The sentinel pattern keeps the promise
  // resolved-always; the middleware checks .ok at request time.
  //
  // For fail-fast boot behavior, callers should await
  // prefetchOidcJwks(oidc) BEFORE binding any listener so the
  // OidcDiscoveryError is observed by the bootstrap rather than the
  // first request handler.
  const jwksReady: Promise<JwksReady> = buildJWKS(oidc).then(
    (jwks): JwksReady => ({ ok: true, jwks }),
    (err: unknown): JwksReady => {
      logger.fatal({ err, reason: 'oidc_discovery_failed' }, 'oidc_setup_failed')
      return { ok: false, err }
    },
  )

  const issuerAccepts = [
    oidc.issuer!, // schema enforces presence
    ...oidc.issuerAliases,
  ]
  const subjectAllowlist = new Set(oidc.subjects)
  const clientAllowlist = new Set(oidc.clients)
  const algorithms = oidc.algorithms

  return async (c, next) => {
    const ctx: LogContext = { method: c.req.method, path: c.req.path }

    const header = c.req.header('Authorization')
    if (!header) {
      return reject(c, ctx, 'missing_authorization')
    }
    if (!header.startsWith('Bearer ')) {
      return reject(c, ctx, 'wrong_scheme')
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token) {
      return reject(c, ctx, 'missing_authorization')
    }

    const ready = await jwksReady
    if (!ready.ok) {
      return reject(c, ctx, 'jwks_unavailable', { err: errString(ready.err) })
    }
    const jwks = ready.jwks

    let payload: JWTPayload
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: issuerAccepts,
        audience: oidc.audience!, // schema enforces presence
        algorithms: [...algorithms],
        clockTolerance: oidc.clockSkewSec,
      })
      payload = result.payload
    }
    catch (err) {
      return reject(c, ctx, classifyJoseError(err), { err: errString(err) })
    }

    if (subjectAllowlist.size > 0) {
      const sub = typeof payload.sub === 'string' ? payload.sub : ''
      if (!subjectAllowlist.has(sub)) {
        return reject(c, ctx, 'sub_disallowed', { sub })
      }
    }

    if (clientAllowlist.size > 0) {
      const clientId = typeof payload['client_id'] === 'string'
        ? (payload['client_id'] as string)
        : typeof payload.azp === 'string'
          ? payload.azp
          : ''
      if (!clientAllowlist.has(clientId)) {
        return reject(c, ctx, 'client_disallowed', { client: clientId })
      }
    }

    await next()
  }
}

/**
 * Boot-time fail-fast helper. Server bootstrap awaits this before
 * binding any listener so an unreachable OIDC issuer surfaces as a
 * FATAL log at boot rather than as 401s on every authenticated
 * request. Throws `OidcDiscoveryError` on failure.
 *
 * The middleware factory itself runs an independent lazy promise so
 * non-server callers (e.g., tests that mount the middleware directly
 * onto a Hono router) continue to work without a separate prefetch
 * step.
 */
export async function prefetchOidcJwks(oidc: OidcConfig): Promise<void> {
  try {
    await buildJWKS(oidc)
  }
  catch (err) {
    if (err instanceof OidcDiscoveryError) throw err
    throw new OidcDiscoveryError(String(err))
  }
}

/**
 * Eagerly build the remote JWKS so the boot path can await it. The
 * function returned by createRemoteJWKSet is a stable reference that
 * memoizes fetches internally via the configured cacheMaxAge and
 * cooldownDuration.
 */
async function buildJWKS(oidc: OidcConfig): Promise<JWTVerifyGetKey> {
  const jwksUri = await resolveJwksUri(oidc)
  return createRemoteJWKSet(new URL(jwksUri), {
    cacheMaxAge: oidc.jwksCacheMaxAgeMs,
    cooldownDuration: oidc.jwksCooldownMs,
  })
}

/**
 * Map a thrown jose error to one of the structured `reason` strings
 * documented in oidc-auth.md §"Error Semantics". Falls through to
 * `jwt_malformed` for unrecognized errors so operators still see a
 * single classifying string in the log, with the actual error
 * appended in `err`.
 */
function classifyJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'time_claim_invalid'
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') return 'iss_mismatch'
    if (err.claim === 'aud') return 'aud_mismatch'
    if (err.claim === 'nbf' || err.claim === 'iat' || err.claim === 'exp') return 'time_claim_invalid'
    return 'claim_invalid'
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'signature_invalid'
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'alg_disallowed'
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'signature_invalid'
  if (err instanceof joseErrors.JWKSMultipleMatchingKeys) return 'signature_invalid'
  // Network failures fetching the JWKS during per-request verification
  // surface as raw TypeError from Node's fetch (jose doesn't wrap
  // them). Classify these as jwks_unavailable so operators see the
  // right reason in logs rather than the misleading 'jwt_malformed'.
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return 'jwks_unavailable'
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return 'jwt_malformed'
  return 'jwt_malformed'
}

function errString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
