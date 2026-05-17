# Rotate Pre-Shared Keys

Multi-key rotation is the supported pattern. No downtime required.

## When to rotate

- **Compromise.** A key value leaked (logs, screenshots, a former
  employee's laptop). Rotate immediately.
- **Scheduled rotation.** Quarterly or semi-annual rotation as part
  of your secret-rotation policy.
- **Operator turnover.** Anyone who had access to the keys is no
  longer on the team.

## Prerequisites

- Access to the deploy pipeline for NodeFGA.
- Access to each client's deployment surface (their `.env`,
  their config, their secret manager).
- A way to generate cryptographically random tokens. The repo
  pattern: `node -e "console.log('k_prod_' + crypto.randomBytes(24).toString('base64url'))"`.

## Procedure

### 1. Generate the new key

```sh
NEW_KEY=$(node -e "console.log('k_prod_' + require('crypto').randomBytes(24).toString('base64url'))")
echo "$NEW_KEY"   # save it to your secret manager NOW
```

Don't proceed without confirming the value landed in your secret
manager. There is no "recover the key" path.

### 2. Deploy server with BOTH keys

Update the deployment config to include the old AND new key:

```yaml
auth:
  mode: preshared
  presharedKeys:
    - k_prod_OLD_VALUE
    - k_prod_NEW_VALUE
```

Or via env var:

```sh
OPENFGA_AUTH_PRESHARED_KEYS=k_prod_OLD_VALUE,k_prod_NEW_VALUE
```

Deploy. The server now accepts requests carrying either key.

### 3. Roll clients to the new key

Update each client's secret to the new key. The order doesn't
matter — every client can keep using the old key in the interim.

For each client:

1. Update the secret in their environment.
2. Restart / redeploy the client.
3. Confirm the client is authenticating successfully against the
   server. Check the server's request logs for the client's traffic.

The fastest way to verify "did the client actually pick up the new
key?" is to check the server's auth-rejection log stream while the
client is exercising paths — if you see no `key_mismatch` for that
client over a sustained window, they're on the new key.

### 4. Wait the safety window

Wait long enough that any in-flight retries with the old key would
have completed. For most APIs, **5–10 minutes** is sufficient. For
queue-based clients with long retry windows, match the longest retry
deadline.

### 5. Deploy server with ONLY the new key

Update the deployment config to drop the old key:

```yaml
auth:
  mode: preshared
  presharedKeys:
    - k_prod_NEW_VALUE
```

Deploy. The server now rejects any request still carrying the old
key — those are clients that didn't update, and they need attention.

### 6. Verify the old key is dead

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://openfga.example.com/stores/$STORE_ID/check \
  -H "Authorization: Bearer k_prod_OLD_VALUE" \
  -H 'Content-Type: application/json' \
  -d '{}'
# Expected: 401
```

If you get 200, the deployment didn't pick up the new config. Check
your deployment pipeline.

## Emergency rotation (compromise)

When a key is known-compromised, skip the safety window:

1. Generate the new key.
2. Deploy with **only the new key** (do not include the compromised
   key as a transitional value).
3. Roll clients to the new key as fast as your deploy pipeline
   allows.
4. Every client request with the old key returns 401 until the
   client rolls. This causes errors for active clients, which is
   the correct behavior when you're racing an attacker.

Document the timeline. Compromise rotations usually need a postmortem.

## What if a client can't be rolled?

Sometimes a client is offline, deprecated, or owned by a team that's
on PTO. Options:

- **Leave the old key allowed.** The multi-key list supports any
  number of keys. There's no penalty for keeping a key you've
  declared "internal-only" or "deprecated, used by service X."
- **Give the slow client its own key.** Generate a separate key per
  client; you can rotate them independently. The cost is a longer
  `presharedKeys` list and a more careful inventory.

The model favors operators: pre-shared keys are cheap. Add and
remove them freely.

## Logging

Each auth rejection logs a structured `reason`:

```json
{ "level": 40, "msg": "auth_rejected", "reason": "key_mismatch", "reqId": "01HXYZ..." }
```

There is no log of *which* configured key would have accepted the
request — that would be an oracle. Operators sanity-checking
rotation status should watch the success-rate counter for the
client's traffic, not the rejection log.

## See also

- [Pre-Shared Keys](/guide/auth-preshared) — config reference
- [Authentication](/guide/authentication) — mode comparison
