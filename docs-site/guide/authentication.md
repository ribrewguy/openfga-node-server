# Authentication

`/stores/*` endpoints can be gated by one of three caller-auth modes.
`/health` and `/ready` are always auth-exempt — Kubernetes-style
probes don't need credentials.

The active mode is `config.auth.mode` (or `OPENFGA_AUTH_MODE`).

## `none` — no authentication

Default. The server accepts every request to `/stores/*` without an
`Authorization` header. Use this when the server is protected by
upstream controls — a service mesh, a reverse proxy, network ACLs.

```yaml
auth:
  mode: none
```

## `preshared` — bearer-token auth with static keys

Static pre-shared keys carried as `Authorization: Bearer <key>`.
Multiple keys are supported so you can rotate without downtime:
deploy with both old and new, rotate clients, redeploy without old.

```yaml
auth:
  mode: preshared
  presharedKeys:
    - k_prod_a1b2c3d4e5f6
    - k_prod_g7h8i9j0k1l2
```

Comparison is constant-time (`crypto.timingSafeEqual`). Length
checks before the comparison only leak the length of the accepted
keys, which on its own is not a useful oracle.

See [Pre-Shared Keys](/guide/auth-preshared) for the rotation
runbook and operator notes.

## `oidc` — JWT validation against an issuer

Bearer JWTs validated against the configured issuer's published
JWKS via [jose](https://github.com/panva/jose). This is the mode
to use behind enterprise identity providers — Okta, Auth0,
Microsoft Entra ID, Keycloak, AWS Cognito.

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://auth.example.com
    audience: openfga-server
    # Optional restrictions.
    subjects: []      # accepted sub claim values (empty = any)
    clients: []       # accepted client_id/azp values (empty = any)
    algorithms: [RS256, RS384, RS512, ES256, ES384, PS256, PS512]
    clockSkewSec: 60
```

What the server validates per request:

1. **Signature** against the issuer's JWKS. The JWKS is fetched
   once at boot (or directly if `oidc.jwksUri` is set explicitly)
   and auto-refreshes when a token presents an unknown `kid`.
2. **`iss` claim** matches `issuer` or any value in `issuerAliases`.
3. **`aud` claim** contains `audience`.
4. **`exp` / `nbf` claims** with the configured `clockSkewSec`
   tolerance.
5. **`alg` header** is in the allowed algorithm set. HS256/384/512
   are rejected at schema-load time — see below.
6. **`sub` allowlist** (when configured).
7. **`client_id` / `azp` allowlist** (when configured).

### HS\* algorithms are rejected by design

`auth.oidc.algorithms` cannot include `HS256`, `HS384`, or `HS512`.
The schema rejects them at config-load with a clear error message.
JWKS is an asymmetric-key surface; an HS entry in the algorithm
list would always fail validation in practice, so accepting it
would only confuse operators.

### Boot-time discovery

When `auth.mode = oidc` is selected, the server runs OIDC discovery
**before binding any listener**. A misconfigured issuer URL surfaces
as `FATAL oidc_setup_failed; refusing to start`. The server never
binds sockets while in a known-bad auth state.

5-second timeout, one retry. See [Set Up OIDC Issuer](/runbooks/setup-oidc)
for issuer-side wiring.

### Failure reporting

All auth rejections return the same `401 unauthenticated` envelope to
the client — distinguishing "expired" vs "wrong audience" vs "bad
signature" in the response leaks JWT validation oracles to attackers.

Operators see the actual reason in structured logs via the
`reason` field. The full classification:

| Log `reason` | What it means |
|---|---|
| `missing_authorization` | No `Authorization` header. |
| `wrong_scheme` | Header present but not `Bearer …`. |
| `jwt_malformed` | Token isn't a valid JWT. |
| `signature_invalid` | Signature didn't verify against any key in the JWKS. |
| `iss_mismatch` | `iss` claim didn't match `issuer` or any alias. |
| `aud_mismatch` | `aud` claim didn't include `audience`. |
| `time_claim_invalid` | `exp` or `nbf` violated (with `clockSkewSec` applied). |
| `alg_disallowed` | Token's `alg` not in the configured allowlist. |
| `sub_disallowed` | `sub` claim not in `subjects` allowlist. |
| `client_disallowed` | `client_id` / `azp` not in `clients` allowlist. |
| `jwks_unavailable` | JWKS fetch failed (network, 5xx, or boot-time discovery failure). |

See [OIDC](/guide/auth-oidc) for the full validation contract and
issuer-setup checklist.

## Mode comparison

| | `none` | `preshared` | `oidc` |
|---|---|---|---|
| Auth header expected | No | `Authorization: Bearer <static-key>` | `Authorization: Bearer <jwt>` |
| Key rotation | N/A | Multi-key list; deploy both, rotate, redeploy | Issuer-managed JWKS rotation; automatic |
| Boot-time validation | None | Validates `presharedKeys` non-empty when mode=preshared | Full OIDC discovery; FATAL on issuer unreachable |
| External dependency | None | None | Reachable OIDC issuer at boot |
| Best for | Internal networks, service mesh | Static API tokens, machine-to-machine | Enterprise IdP integration |

## SDK integration

`@openfga/sdk` clients work against all three modes. The SDK's
`getCredentials()` hook is where you plug in either the static
pre-shared key or the OIDC client-credentials flow.
