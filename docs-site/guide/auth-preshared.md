# Pre-Shared Keys

`auth.mode: preshared` enables static Bearer-token authentication for
`/stores/*` endpoints. Clients send their key as an `Authorization`
header:

```
Authorization: Bearer k_prod_a1b2c3d4e5f6
```

## Configuration

```yaml
auth:
  mode: preshared
  presharedKeys:
    - k_prod_a1b2c3d4e5f6
    - k_prod_g7h8i9j0k1l2
```

Or via env var (comma-separated):

```sh
OPENFGA_AUTH_MODE=preshared
OPENFGA_AUTH_PRESHARED_KEYS=k_prod_a1b2c3d4e5f6,k_prod_g7h8i9j0k1l2
```

At least one non-empty key is required. The server refuses to start
in `preshared` mode with an empty key list.

## Comparison is constant-time

The auth middleware calls `crypto.timingSafeEqual` after a length
check. Length mismatches return immediately, but the only information
that leak reveals is the length distribution of accepted keys, which
on its own is not a useful oracle if you pick keys of uniform length.

## Recommended key shape

- **Use a CSPRNG.** `node -e "console.log('k_' + crypto.randomBytes(24).toString('base64url'))"` produces a 32-character base64url key prefixed for legibility in logs.
- **Pick a uniform length** for all keys so the length-check fast-path
  doesn't reveal anything useful.
- **Prefix by environment** (`k_prod_`, `k_stage_`). Operators
  glancing at log redactions can spot a misrouted key faster.
- **Don't reuse keys across tenants.** One key per service principal
  per environment.

## Rotation

The multi-key list is the rotation primitive. The flow:

1. Deploy with the **old key only**.
2. Generate the new key. Deploy with **both** keys in
   `auth.presharedKeys`.
3. Roll out the new key to clients. Verify each client is using the
   new key (log scrape for the old-key hash, or just wait the agreed
   rotation window).
4. Redeploy with the **new key only**. The old key now rejects on
   every request.

No downtime, no synchronized cutover. See
[Rotate Pre-Shared Keys](/runbooks/rotate-preshared-keys) for the
runbook.

## What gets logged

Auth rejections log a structured `reason`:

| `reason` | What it means |
|---|---|
| `missing_authorization` | No `Authorization` header. |
| `wrong_scheme` | Header present but not `Bearer …`. |
| `key_mismatch` | Token doesn't match any configured key. |

The key value itself is never logged — only the rejection reason and
request metadata. Operators wanting to confirm "did this client send
key X" should rotate X out of the allowlist and watch for the
expected `key_mismatch` failures.

## When to use pre-shared keys

- **Machine-to-machine traffic** inside a trust boundary.
- **CI / deploy scripts** that authenticate as a service principal.
- **Static API consumers** that don't have OIDC client credentials.

When you need per-user identity (audit trails by `sub`, allowlists by
`client_id`), use [OIDC](/guide/auth-oidc) instead.

## See also

- [Authentication Modes](/guide/authentication) — comparison across
  modes
- [Rotate Pre-Shared Keys](/runbooks/rotate-preshared-keys) — full
  rotation runbook
