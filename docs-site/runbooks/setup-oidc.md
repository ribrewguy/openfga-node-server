# Set Up OIDC Issuer

This runbook covers wiring NodeFGA to a real OIDC
issuer. Vendor-specific instructions for the common IdPs are below.

## Generic OIDC checklist

Regardless of vendor, you need:

1. **An issuer URL** — the root URL the IdP serves
   `.well-known/openid-configuration` from.
2. **An audience identifier** — the value the IdP places in the `aud`
   claim. Match it exactly in `auth.oidc.audience`.
3. **A client/app registered** with the IdP that callers exchange
   credentials with for a JWT.
4. **A signing algorithm in the asymmetric set** —
   RS256/384/512, ES256/384/512, PS256/384/512, or EdDSA. HS\* is
   rejected by this server.

## Server-side wiring

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://auth.example.com
    audience: openfga-server
    clockSkewSec: 60
```

Restart the server. On boot:

- `oidc_setup_ok` log line → discovery succeeded, JWKS primed.
- `FATAL oidc_setup_failed` → check the issuer URL, your DNS, and the
  IdP's discovery document.

## Auth0

1. **Create an API** in the Auth0 dashboard:
   - Identifier: `openfga-server` (this is your `audience`)
   - Signing algorithm: `RS256`
2. **Create a Machine-to-Machine application** authorized to call
   that API. Note its Client ID and Client Secret.
3. **Issuer URL** is `https://<your-tenant>.auth0.com/` (with
   trailing slash).

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://acme.us.auth0.com/
    audience: openfga-server
```

Callers exchange credentials at
`https://acme.us.auth0.com/oauth/token`:

```sh
TOKEN=$(curl -sS -X POST https://acme.us.auth0.com/oauth/token \
  -H 'Content-Type: application/json' \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "...",
    "client_secret": "...",
    "audience": "openfga-server"
  }' | jq -r .access_token)

curl -sS https://openfga.example.com/stores \
  -H "Authorization: Bearer $TOKEN"
```

## Okta

1. **Create an API services / OAuth Service app** in the Okta admin
   console.
2. The default authorization server (`default`) issues at
   `https://<your-domain>.okta.com/oauth2/default`.
3. **Add an audience** under Security → API → Authorization Servers →
   default → Settings. Set the audience to `openfga-server`.
4. **Register the client** under Applications. Grant client_credentials
   flow.

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://acme.okta.com/oauth2/default
    audience: openfga-server
```

## Microsoft Entra ID (formerly Azure AD)

1. **Register an application** in Entra. Note the Application (client)
   ID.
2. **Expose an API.** Add `openfga-server` (or your chosen name) as
   an Application ID URI.
3. **Define a scope** like `access` so callers can request
   `<app-id-uri>/.default`.
4. **Issuer URL** is
   `https://login.microsoftonline.com/<tenant-id>/v2.0`.

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://login.microsoftonline.com/<tenant-id>/v2.0
    audience: api://<application-id>      # or your custom App ID URI
```

Entra v2 tokens use `aud` = the Application ID URI (or the client ID
itself, depending on how the scope is configured). Test with a real
token and confirm the `aud` value matches.

## Keycloak

1. **Create a Realm** (or use an existing one).
2. **Create a Client** of type `confidential` or `bearer-only`.
3. **Set Access Type** appropriately for your callers (most
   service-to-service callers use `confidential` with the
   client-credentials grant).
4. **Issuer URL** is
   `https://<keycloak-host>/realms/<realm-name>`.

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://auth.example.com/realms/main
    audience: openfga-server
```

Keycloak audiences are configured per-client. If your tokens land
with an unexpected `aud` claim, check the client's "Audience
Resolve" mappers.

## AWS Cognito

1. **Create a User Pool** (for user tokens) or **Cognito as an
   identity provider** (for machine tokens).
2. The issuer URL is
   `https://cognito-idp.<region>.amazonaws.com/<pool-id>`.
3. Cognito tokens include the User Pool ID as `aud` when the token
   is an ID token; access tokens use the client ID. Pick which one
   your callers send.

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abcdef
    audience: <user-pool-id>     # or client id; match what callers send
```

## Google Workspace / Google IAP

Google's issuer is `https://accounts.google.com` for end-user tokens
or `https://cloud.google.com/iap` for IAP. The audience is the
IAP-protected backend's client ID.

```yaml
auth:
  mode: oidc
  oidc:
    issuer: https://accounts.google.com
    audience: <client-id>.apps.googleusercontent.com
```

## Verifying the wiring

After deploying:

1. **Check the boot log.** `oidc_setup_ok` with the resolved
   `jwks_uri` confirms discovery worked.
2. **Get a token** through your IdP's normal flow.
3. **Hit a protected endpoint** with the token:
   ```sh
   curl -sS https://openfga.example.com/stores \
     -H "Authorization: Bearer $TOKEN"
   ```
4. **Inspect the auth-rejected log** if it fails. The `reason` field
   tells you exactly what failed (see
   [Authentication](/guide/authentication#failure-reporting)).

## Common errors

| Symptom | Likely cause |
|---|---|
| `FATAL oidc_setup_failed` at boot | Issuer URL wrong, DNS unreachable, IdP rejected the discovery probe. Check the URL is reachable from the deployment target. |
| `iss_mismatch` on every request | Token's `iss` claim doesn't equal `auth.oidc.issuer` exactly. Trailing slashes matter. Add to `issuerAliases` if the IdP issues from multiple URLs. |
| `aud_mismatch` on every request | Token's `aud` claim doesn't include `auth.oidc.audience`. Match the IdP's configured audience exactly. |
| `alg_disallowed` | Token signed with HS\*. Configure the IdP to use RS256 (or another asymmetric algorithm). |

## See also

- [OIDC](/guide/auth-oidc) — full validation contract
- [Authentication](/guide/authentication) — failure-reason classification
