# OIDC

`auth.mode: oidc` validates incoming Bearer JWTs against an OIDC
issuer's published JWKS. This is the mode for enterprise IdP
integration — Okta, Auth0, Microsoft Entra ID, Keycloak, AWS Cognito,
Google Workspace.

## Configuration

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://auth.example.com
    audience: openfga-server
    issuerAliases: []
    subjects: []
    clients: []
    algorithms: [RS256, RS384, RS512, ES256, ES384, ES512, PS256, PS384, PS512, EdDSA]
    clockSkewSec: 60
    jwksCacheMaxAgeMs: 600000
    jwksCooldownMs: 30000
```

`issuer` and `audience` are required when `auth.mode = oidc`. Everything
else has sensible defaults.

## What gets validated, per request

1. **Bearer scheme** — `Authorization: Bearer <jwt>`.
2. **JWT structure** — three base64url segments.
3. **`alg` header** in the allowed set. HS* are rejected at
   *config-load* (see below).
4. **Signature** against the issuer's JWKS. Unknown `kid` triggers
   a single JWKS refetch (rate-limited by `jwksCooldownMs`).
5. **`iss` claim** matches `issuer` or any value in `issuerAliases`.
6. **`aud` claim** contains `audience`.
7. **`exp` / `nbf`** with `clockSkewSec` tolerance.
8. **`sub` allowlist** (skipped when `subjects` is empty).
9. **`client_id` / `azp` allowlist** (skipped when `clients` is
   empty).

Every failure mode logs a structured `reason`; the response is
always `401 unauthenticated` with no oracle leakage. See
[Authentication](/guide/authentication#failure-reporting) for the
full classification.

## HS\* algorithms are rejected by design

`auth.oidc.algorithms` cannot include `HS256`, `HS384`, or `HS512`.
JWKS is an asymmetric-key surface; an HS entry in the algorithm list
would always fail validation in practice. Accepting it would only
confuse operators. The schema rejects them at config-load with a
clear error.

If your IdP signs with an HS\* algorithm, change the IdP — or use
[Pre-Shared Keys](/guide/auth-preshared) instead, which is the same
trust model.

## Boot-time discovery

When `auth.mode = oidc` is selected, the server runs OIDC discovery
**before binding any listener**:

1. Fetch `${issuer}/.well-known/openid-configuration` with a 5-second
   timeout. One retry.
2. Resolve `jwks_uri` from the discovery document (or use
   `oidc.jwksUri` directly if set).
3. Prime the in-memory JWKS cache from `jwks_uri`.
4. Log `oidc_setup_ok` with the resolved JWKS URI.

A misconfigured issuer URL surfaces as
`FATAL oidc_setup_failed; refusing to start`. The server never accepts
traffic in a known-bad auth state.

If the issuer becomes unreachable *after* boot, the running server
continues serving requests against its cached JWKS until
`jwksCacheMaxAgeMs` expires.

## JWKS caching

| Setting | Default | Purpose |
|---|---|---|
| `jwksCacheMaxAgeMs` | 600000 (10m) | How long a JWKS is reused without refetch. |
| `jwksCooldownMs` | 30000 (30s) | Minimum interval between `kid`-miss-triggered refetches. |

The cooldown prevents an attacker from triggering JWKS-fetch floods by
sending JWTs signed with random `kid` values. After a cooldown
violation, unknown-`kid` tokens fail with `signature_invalid` until
the cooldown expires.

## Identity claims

The middleware validates the token's `sub`, `client_id` / `azp`, and
`iss` claims against the configured allowlists and rejects mismatches
at the perimeter (logged with structured `reason` —
`sub_disallowed`, `client_disallowed`, `iss_mismatch`). Claims are
**not** surfaced onto the request context for downstream handlers
today; auth is a pure perimeter check and the evaluator trusts the
tuple shape for identity.

If you need per-caller identity inside handlers, that's a follow-up —
file a bead.

## Issuer aliases

`issuerAliases` is an accept-list for the JWT `iss` claim. Tokens
whose `iss` matches any entry (exact-string match) pass the
issuer-claim check. All accepted tokens are verified against the
**same JWKS** — the one resolved from `auth.oidc.issuer` (or
`auth.oidc.jwksUri` if set).

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://example.auth0.com/
    issuerAliases:
      - https://legacy.example.auth0.com/
    audience: openfga-server
```

This works when multiple `iss` strings share signing keys — typical
for issuer-URL migrations or front-door rewrites. It does **not**
support per-tenant JWKS (each tenant signing with its own keys); for
that pattern, run one server instance per signing surface.

## Configuring your IdP

Each IdP wires up slightly differently. The minimum:

1. **Register an API** in your IdP with audience = `openfga-server`
   (or whatever you set in `auth.oidc.audience`).
2. **Issue an asymmetric key** (RSA/ES/EdDSA) — most IdPs default to
   `RS256`, which is in the default `algorithms` allowlist.
3. **Distribute client credentials** to callers. Callers exchange
   their credentials for a JWT, then send the JWT as Bearer to
   NodeFGA.

See [Set Up OIDC Issuer](/runbooks/setup-oidc) for vendor-specific
wiring (Auth0, Okta, Entra ID, Keycloak).

## See also

- [Authentication](/guide/authentication) — modes overview
- [Set Up OIDC Issuer](/runbooks/setup-oidc) — IdP wiring runbook
