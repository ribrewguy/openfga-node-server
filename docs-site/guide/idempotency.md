# Idempotency

Mutating endpoints (writes, model changes, store creates) can be
gated by an `Idempotency-Key` header. The server records the request
fingerprint and the response, and replays the same response if the
key is reused within the configured window.

This is opt-in behavior. The default `idempotency.mode: off` makes
the header a no-op.

## Configuration

```yaml
idempotency:
  mode: off       # off | optional | required
  ttlMs: 86400000 # replay window (24h default)
```

| `mode` | Behavior |
|---|---|
| `off` | Header is ignored. Every request executes. |
| `optional` | When present and well-formed, the key is honored. Missing key → request executes normally. |
| `required` | Mutating endpoints in scope **must** include `Idempotency-Key`. Missing or empty → `400 invalid_argument`. |

`ttlMs` is the replay window. After `ttlMs` since the original
request, the same key is treated as fresh and the request executes
again.

## Header shape

```
Idempotency-Key: <unique-token>
```

The key is opaque to the server. Recommended:

- A UUIDv4 or ULID, generated client-side per logical operation.
- 16–256 characters.
- Stable across retries of the **same logical operation** — if your
  client retries a write because the network blipped, the retry MUST
  reuse the same key. Otherwise the server treats it as a new request
  and executes again.

The key value is hashed before storage. The plaintext is never
persisted.

## Replay semantics

On a key hit:

| Situation | Response |
|---|---|
| Fingerprint matches, prior request complete | Replay — original status code and body. |
| Fingerprint matches, prior request still in-flight | `409 idempotency_in_flight` |
| Fingerprint differs (same key, different request body) | `422 idempotency_fingerprint_mismatch` |
| Idempotency store unavailable (DB error) | `503 idempotency_store_unavailable` |

Fingerprint is `SHA-256(METHOD + ' ' + REQUEST_PATH + '\n' + BODY)`.
The path is the **concrete request URL** (e.g.
`/stores/01ABC.../write`), not the route pattern — same key reused
across different stores produces a different fingerprint, so there's
no cross-store replay leak.

## Storage

Idempotency state lives in a single table — `<namespace>.idempotency`
— scoped to the store via `store_id`. Each row carries the key hash,
the request fingerprint, the captured response, and the expiry
timestamp.

A background sweep deletes expired rows. The sweep is best-effort;
expired keys are also rejected at read-time, so the table doesn't
need to be perfectly trimmed.

## Which endpoints honor idempotency

The scoped routes are:

- `POST /stores` — store creation
- `POST /stores/:storeId/authorization-models` — new model version
- `POST /stores/:storeId/write` — tuple writes / deletes

All other routes ignore the header. Read endpoints (`check`,
`expand`, `list-objects`, `list-users`, `read`, `read-changes`,
`batch-check`) are inherently idempotent.

## When you actually want this

- **Retry-prone clients.** Mobile clients, edge functions, queues
  with at-least-once delivery. Without idempotency, a network blip
  during a write produces a duplicate tuple in the store.
- **Workflow engines.** Temporal, Step Functions, Airflow — anything
  that retries activities on transient failure. The activity
  produces the same `Idempotency-Key` from a deterministic seed
  (workflow run id + step id).
- **Multi-region writes.** Two regions racing to apply the same
  business event each carry the same key derived from the event id.
  Only the first wins; the second replays the response.

## When you don't

If your client never retries writes, or your writes are inherently
idempotent at the model layer (writing the same tuple is a no-op),
leaving `idempotency.mode: off` is fine. The cost of enabling it
is one extra round-trip to the idempotency table per mutating
request.

## OpenTelemetry integration

When `otel.spans.idempotency = true` (the default when otel is
enabled), every claim/complete/replay produces a span:

- `openfga.idempotency.claim` — first-time write reserving the key
- `openfga.idempotency.replay` — repeat request returning the stored
  response
- `openfga.idempotency.in_flight` — concurrent retry hitting the
  in-flight gate

Useful for debugging "is this client actually getting the replay or
re-executing?"

## See also

- [Configuration](/guide/configuration) — schema shape
- [Observability](/guide/observability) — idempotency span attributes
