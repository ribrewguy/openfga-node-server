# Request Validation

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md`, "Design principles", especially wire-compatible request and response shapes.
- PRD: `docs/PRD.md`, "Scope (current)", implemented endpoint list.
- Middleware: `@hono/zod-validator` for Hono request validation.

## Business Intent

The server exposes an OpenFGA-compatible HTTP API. Clients should receive deterministic, client-safe validation errors when request bodies, route parameters, query parameters, or headers do not match the supported OpenFGA surface.

The current implementation performs ad hoc checks in route handlers. That makes validation inconsistent and allows malformed input to reach storage and evaluator code. Request validation should move those checks to the HTTP boundary while preserving OpenFGA-compatible behavior.

## Goals

- Validate request bodies for implemented OpenFGA endpoints with Zod schemas.
- Validate route parameters, query parameters, and relevant headers where they affect behavior.
- Keep validation at the Hono route boundary before evaluator and storage calls.
- Preserve OpenFGA-compatible success response shapes.
- Return client-safe validation errors that do not expose raw Zod internals.
- Reuse validation schemas in tests so route tests and implementation share the same contract.

## Non-Goals

- Do not add model-semantic validation that requires evaluating an authorization model. That belongs to write/check/list behavior, not generic request shape validation.
- Do not change OpenFGA response shapes for valid requests.
- Do not expose raw `ZodError` objects as public API responses.
- Do not replace TypeScript types from `@openfga/sdk`; Zod schemas complement those types at runtime.
- Do not introduce OpenAPI generation in the initial feature.

## Middleware Choice

Use `@hono/zod-validator`.

The middleware validates incoming values with Zod and lets handlers read typed values through `c.req.valid(...)`. It supports validation targets such as JSON bodies, query values, route params, and headers.

Use a local wrapper around `zValidator` rather than the package default response. The default middleware response includes the validation result shape, which is not the public API contract for this server. The wrapper should map failures into this project's OpenFGA-compatible error envelope.

## Validation Scope

Validate JSON bodies for:

- `POST /stores`
- `POST /stores/:storeId/authorization-models`
- `POST /stores/:storeId/check`
- `POST /stores/:storeId/write`
- `POST /stores/:storeId/read`
- `POST /stores/:storeId/list-objects`

Validate route params for:

- `:storeId`
- `:id` on `GET /stores/:storeId/authorization-models/:id`

Validate query params for:

- `page_size` on `GET /stores/:storeId/authorization-models`

Validate headers only when a feature makes them behaviorally relevant:

- `Authorization` for shared-key and OIDC auth.
- `Idempotency-Key` for idempotency.
- OpenTelemetry propagation headers only for explicit OTel configuration checks, not for request rejection by default.

## Schema Design

Schemas should be colocated near the route layer, for example under `src/routes/validation.ts` or `src/routes/schemas.ts`.

Schemas should model the supported wire contract, not internal storage rows. Body schemas should use snake_case because OpenFGA uses snake_case on the wire.

Object references should be validated enough to prevent malformed boundary input from reaching storage:

- Full object reference: `<type>:<id>`.
- Type-only object filter where OpenFGA permits it: `<type>:`.
- Userset reference where OpenFGA permits it: `<type>:<id>#<relation>`.
- Typed wildcard where OpenFGA permits it: `<type>:*`.

The schema layer should distinguish syntax validation from semantic authorization-model validation. For example, a tuple relation can be syntactically valid even if the current authorization model does not allow it. Model-aware validation remains part of write/check behavior.

## Unknown Fields

The server should not reject unknown fields by default unless OpenFGA rejects them for the same request shape. Use permissive object schemas where wire compatibility requires clients to send fields this server does not currently use, such as `consistency`, `context`, or `trace`.

When a field is accepted but ignored because the feature is out of scope, the route behavior must be documented or covered by a separate feature/bug bead.

## Error Semantics

Validation failures should return `400` with a flat, client-safe error body.

Minimum error body:

```json
{
  "code": "invalid_argument",
  "message": "request validation failed"
}
```

The implementation may include structured `details` for field errors if doing so remains compatible with OpenFGA client behavior. Details must not include raw request bodies, secrets, tokens, or raw `ZodError` objects.

Malformed JSON should return the same validation envelope as other invalid request bodies.

## Middleware Ordering

Recommended route order:

1. OpenTelemetry middleware.
2. Request logging.
3. Authentication.
4. Idempotency for scoped mutating endpoints.
5. Route-specific Zod validation.
6. Route handler.

Authentication runs before validation so unauthorized callers cannot use validation responses to probe endpoint schemas. Idempotency runs before validation only when the selected idempotency middleware requires access to the raw request body for fingerprinting. If idempotency can safely run after validation without changing fingerprints, validation may run first for invalid-request efficiency.

## Endpoint-Specific Notes

### Stores

`POST /stores` requires a non-empty `name` string after trimming.

### Authorization Models

`POST /stores/:storeId/authorization-models` requires `type_definitions` to be an array. `schema_version` defaults to `1.1` when omitted. The schema should allow `conditions` even though the evaluator currently ignores conditional tuples.

### Check

`POST /stores/:storeId/check` requires `tuple_key.user`, `tuple_key.relation`, and `tuple_key.object`.

The schema should allow OpenFGA request fields such as `authorization_model_id`, `contextual_tuples`, `context`, `trace`, and `consistency`. Unsupported behavior should be handled by the relevant implementation bead, not rejected here unless the OpenFGA contract requires rejection.

### Write

`POST /stores/:storeId/write` accepts `writes`, `deletes`, or both. At least one tuple operation must be present.

Shape validation should cover `writes.tuple_keys`, `writes.on_duplicate`, `deletes.tuple_keys`, and `deletes.on_missing`. Model-aware tuple validation belongs to the write semantics implementation.

### Read

`POST /stores/:storeId/read` allows omitted `tuple_key`. When present, `tuple_key.object` can be a full object reference or an allowed type-only filter.

### List Objects

`POST /stores/:storeId/list-objects` requires `type`, `relation`, and `user`.

The schema should allow `authorization_model_id`, `contextual_tuples`, `context`, and `consistency`.

## Acceptance Criteria

- A request-validation feature spec exists under `docs/features/`.
- Route handlers use Zod-validated values instead of manually parsing unchecked request bodies.
- Implemented endpoints have route-level schemas for JSON body validation where they accept JSON bodies.
- Route params and query params that affect behavior are validated before storage calls.
- Validation errors return client-safe `400` responses with `code: "invalid_argument"`.
- Raw Zod errors are not returned to clients.
- Unknown fields are allowed where required for OpenFGA wire compatibility.
- Tests cover valid requests, malformed JSON, missing required fields, invalid object references, invalid pagination values, and unknown-field compatibility.
- Documentation explains the validation boundary and the difference between syntactic validation and model-aware validation.

## Open Questions

- Should validation error `details` be exposed, and if so, what exact field-error shape is compatible with OpenFGA clients?
- Should schemas live in a single route validation module or be colocated per endpoint group?
- Should `@openfga/sdk` generated types be used in tests to assert Zod schema compatibility?
