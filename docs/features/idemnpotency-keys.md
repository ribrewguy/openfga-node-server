# Idempotency Keys

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md`, "Idempotency keys".
- External protocol: `Idempotency-Key` HTTP header behavior from the IETF HTTPAPI draft, as implemented by `idempot-js`.
- Implementation candidate: `idempot-js` Hono middleware with a persistent store.

## Business Intent

Clients call OpenFGA write-style endpoints during request handling, setup flows, and deployment automation. These clients can retry after timeouts, dropped connections, or ambiguous responses. Without idempotency, a retry can create duplicate stores or authorization models, or can apply the same mutating operation more than once.

The server should support client-provided idempotency keys for mutating requests. A repeated request with the same key and same fingerprint should return the original response. A repeated request with the same key and a different fingerprint should be rejected.

## Goals

- Support the `Idempotency-Key` header for configured mutating endpoints.
- Preserve existing OpenFGA response bodies for successful first requests and replayed successful requests.
- Use persistent idempotency storage so retry protection survives process restarts and horizontal scaling.
- Keep idempotency state outside the `openfga` schema to preserve the migration path to upstream OpenFGA.
- Make rollout configurable so existing clients are not broken by default.

## Non-Goals

- Do not add idempotency to evaluator internals or storage repositories.
- Do not require idempotency keys for read-style endpoints by default.
- Do not generate idempotency keys for clients.
- Do not add idempotency records to the `openfga` schema.

## Endpoint Scope

Idempotency applies to mutating endpoints:

- `POST /stores`
- `POST /stores/:storeId/authorization-models`
- `POST /stores/:storeId/write`

Idempotency does not apply by default to read-style POST endpoints:

- `POST /stores/:storeId/check`
- `POST /stores/:storeId/read`
- `POST /stores/:storeId/list-objects`

If a future endpoint mutates persistent state, it must explicitly decide whether idempotency applies before implementation.

## Configuration

Use a mode switch rather than a boolean so rollout behavior is explicit:

- `OPENFGA_IDEMPOTENCY_MODE=off` disables idempotency. This is the default.
- `OPENFGA_IDEMPOTENCY_MODE=optional` enables idempotency when a request includes `Idempotency-Key`, but permits requests without a key.
- `OPENFGA_IDEMPOTENCY_MODE=required` requires `Idempotency-Key` on scoped mutating endpoints.

Additional configuration:

- `OPENFGA_IDEMPOTENCY_TTL_MS` sets record retention. The default should follow the middleware default of 24 hours unless this project chooses a different value.
- `OPENFGA_IDEMPOTENCY_STORE` selects the backing store. Supported values should be introduced only when implemented.
- Store-specific settings must not reuse `OPENFGA_DB_URL` if doing so would create idempotency tables in the `openfga` schema.

## Middleware Ordering

Authentication must run before idempotency. Unauthorized requests must not create, replay, or inspect idempotency records.

Request logging should continue to record method, path, status, and duration. It must not log idempotency keys.

Idempotency middleware should run before route handlers for scoped mutating endpoints. Route handlers should not need to know whether a response is original or replayed unless the selected middleware exposes response headers that are safe and useful to clients.

## Storage

Idempotency requires persistent storage. In-memory storage is not acceptable for production because it does not survive process restarts and cannot coordinate horizontally scaled instances.

Preferred storage options:

- A separate Postgres schema or database that is not `openfga`.
- Redis with persistence enabled.

The implementation must not add idempotency tables to the `openfga` schema. That schema is reserved for OpenFGA-compatible state and must remain suitable for `pg_dump --schema=openfga` migration to the upstream server.

## Request Fingerprint

The request fingerprint must include at least:

- HTTP method.
- Route path.
- Request body.

The fingerprint may exclude non-semantic fields only when there is a documented use case. The initial implementation should not exclude fields by default.

## Expected Behavior

When idempotency is off:

- Requests behave as they do today.

When idempotency is optional:

- Requests without `Idempotency-Key` behave as they do today.
- Requests with a new key process normally and persist the response.
- Requests with the same key and same fingerprint return the persisted response.
- Requests with the same key and a different fingerprint return a client error.
- Concurrent requests with the same key return a conflict while the first request is still processing.

When idempotency is required:

- Scoped mutating requests without `Idempotency-Key` return a client error before the route handler runs.
- Scoped mutating requests with invalid keys return a client error before the route handler runs.

## Error Semantics

The implementation should follow the middleware's IETF-compliant behavior unless it conflicts with this project's established error envelope:

- Missing required key: `400`.
- Same key with different fingerprint: `422`.
- Concurrent request with same key while the original is processing: `409`.
- Idempotency store unavailable after retries or an open circuit: `503`.

Errors must be client-safe and must not include raw idempotency keys, database details, or secret configuration values.

## Observability

The server should expose enough structured logging to diagnose idempotency behavior without leaking keys:

- Whether idempotency was disabled, optional, or required.
- Whether a scoped request was original, replayed, rejected for conflict, or rejected for fingerprint mismatch.
- Store failure and circuit-breaker events, if exposed by the middleware.

Logs must avoid raw `Idempotency-Key` values. If correlation is needed, log a stable hash of the key.

## Acceptance Criteria

- The PRD includes idempotency-key support in current scope.
- A configured mutating endpoint can replay the original response for the same `Idempotency-Key` and same request fingerprint.
- Reusing a key with a different request fingerprint returns `422`.
- Concurrent requests with the same key return `409` for the later request while the first is still processing.
- Required mode rejects scoped mutating requests that omit `Idempotency-Key`.
- Optional mode permits requests without `Idempotency-Key`.
- Read-style POST endpoints are not subject to idempotency by default.
- Idempotency records persist outside the `openfga` schema.
- Tests cover off, optional, and required modes.
- Documentation describes configuration, endpoint scope, storage requirements, and retention.

## Open Questions

- Which backing store should be implemented first: separate-schema Postgres or Redis?
- Should `/stores` require idempotency in production when idempotency is enabled, or should all scoped endpoints share the same mode?
- Should replayed responses include idempotency status headers if the middleware provides them?
