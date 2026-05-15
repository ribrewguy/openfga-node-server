# openfga-node-server

[![codecov](https://codecov.io/gh/ribrewguy/openfga-node-server/graph/badge.svg)](https://codecov.io/gh/ribrewguy/openfga-node-server)

OpenFGA-wire-compatible authorization server in Node. Drop-in for the
OpenFGA reference (Go) server for the surface this project implements.

Built to fill a gap: serverless-friendly Node deployments (Vercel, Fly,
Cloud Run, etc.) often can't run the Go binary as a sidecar, and the
managed offerings (Auth0 FGA / openfga.cloud) aren't always the right
shape. This server runs anywhere Node runs and talks the OpenFGA HTTP
protocol byte-for-byte.

State is stored via a Kysely-typed storage layer with two supported
backends:

- **Postgres** (production-recommended) — schema mirrors the upstream
  OpenFGA reference schema, so a future migration to the Go server is
  `pg_dump --schema=openfga` (excluding the operational tables that
  aren't part of the OpenFGA reference contract; see
  [Migrating to upstream OpenFGA](#migrating-to-upstream-openfga))
  plus an env-var flip.
- **SQLite** (test backend; embedded-deployment option) — for unit
  tests, single-process embedded use, and small SaaS deployments
  where Postgres is overkill. The upstream-migration `pg_dump` path
  is not available on this backend.

The backend is selected from the scheme of `OPENFGA_DB_URL`; no
separate driver flag.

## Status

Prototype. The full OpenFGA REST surface is implemented and SDK
conformance tests pass against it (see openfga-68n).
See **Implemented endpoints** below for the supported surface.

## Quick start

```sh
pnpm install

# Configure. Pick one (or both — env vars override file values):
#   - File-based (recommended): copy openfga.config.example.yaml to
#     openfga.config.yaml. Supports per-env override blocks
#     ($development / $production / $test).
cp openfga.config.example.yaml openfga.config.yaml
$EDITOR openfga.config.yaml
#   - Env-only (twelve-factor / platform-managed): copy .env.example
#     to .env. Useful for Vercel, Kubernetes secrets, etc.
cp .env.example .env
$EDITOR .env
# See docs/features/configuration.md for the full mapping table and
# precedence order (defaults < file < per-env block < env vars).

# (Optional) generate locally-trusted HTTPS certs via mkcert.
# Prints the OPENFGA_TLS_* and NODE_EXTRA_CA_CERTS values to paste into .env.
pnpm cert:create

# Apply schema migrations.
pnpm migrate up

# Boot the server.
pnpm dev

# In another shell: load the example model.
pnpm load-model tests/fixtures/github.fga
# (Copy the printed OPENFGA_STORE_ID into your environment for subsequent calls.)
```

## Configuration

The full set of environment variables — required, optional, defaults,
and tuning knobs for the connection pool — is documented inline in
[`.env.example`](.env.example). Copy it to `.env` for local dev; the
server loads it automatically via `dotenv/config`.

The minimum required for the server to start is `OPENFGA_DB_URL`.

## Implemented endpoints

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/stores` | List stores, newest first. Cursor-paginated via `continuation_token`. |
| `POST` | `/stores` | Create a store. Idempotent. |
| `POST` | `/stores/:storeId/authorization-models` | Write a new authorization model (immutable). Idempotent. Accepts `application/json` (default) or `application/x-openfga-dsl` / `text/plain` (DSL — server-side compile). |
| `GET`  | `/stores/:storeId/authorization-models` | List models, newest first. |
| `GET`  | `/stores/:storeId/authorization-models/:id` | Read a specific model. |
| `POST` | `/stores/:storeId/check` | Authorization check. Honors `contextual_tuples`. |
| `POST` | `/stores/:storeId/write` | Write or delete tuples. Idempotent. Records changes transactionally for `/changes`. |
| `POST` | `/stores/:storeId/read` | Read tuples (filterable). Cursor-paginated via `continuation_token`. |
| `POST` | `/stores/:storeId/list-objects` | List objects of a type a user has a relation on. Honors `contextual_tuples`. |
| `POST` | `/stores/:storeId/expand` | Returns the userset tree for a (object, relation). Honors `contextual_tuples`. |
| `POST` | `/stores/:storeId/batch-check` | Up to 50 checks in one request, results keyed by `correlation_id`. Per-item `contextual_tuples`. |
| `POST` | `/stores/:storeId/list-users` | List users with a relation on an object. Filter by user type/relation; userset memberships expanded. Honors `contextual_tuples`. |
| `GET`  | `/stores/:storeId/changes` | Tuple changelog, oldest-first. Cursor-paginated; supports `?type=` filter and `?start_time=` cutoff. Polling-tail token semantics. |
| `GET`  | `/stores/:storeId/assertions/:authorizationModelId` | Read assertion set for a model. |
| `PUT`  | `/stores/:storeId/assertions/:authorizationModelId` | Upsert assertions for a model. |
| `GET`  | `/health` | Liveness check (auth-exempt). |

"Idempotent" endpoints honor the `Idempotency-Key` HTTP header. See
[Idempotency keys](#idempotency-keys) below.

The write-model endpoint also accepts the OpenFGA DSL directly. Set
`Content-Type: application/x-openfga-dsl` (or `text/plain`) and POST
`.fga` bytes; the server compiles them via `@openfga/syntax-transformer`
and produces the same `{ "authorization_model_id": "<id>" }` response
as the JSON path. DSL parse errors return `400 invalid_argument` with
line/column information. The JSON path is unchanged — `@openfga/sdk`
clients work as before. See
[`docs/features/dsl-write-model.md`](docs/features/dsl-write-model.md).

All routes above are wire-compatible with `@openfga/sdk` — the
SDK conformance suite in `tests/integration/sdk-conformance.test.ts`
exercises every endpoint via the high-level `OpenFgaClient` over real
HTTP and asserts no in-scope endpoint returns `501`.

## Evaluation algebra

The check evaluator implements the full OpenFGA rewrite-rule set:

- `this` — direct relation (incl. typed wildcards `<type>:*` and
  userset references `<type>:<id>#<relation>`).
- `computedUserset` — alias to another relation on the same object.
- `tupleToUserset` — "X from Y" — for each tuple via Y, evaluate X.
- `union`, `intersection`, `difference`.

`list-objects` is a forward-walk reverse expansion that filters
candidates through `check()` so `intersection` and `difference`
correctness is preserved.

Unit tests in `tests/unit/` cover every rewrite type for `check`,
`list-objects`, `expand`, and `list-users` — including userset
expansion, contextual-tuple overlays, and cycle detection.
Integration tests in `tests/integration/` cover persistence,
transactional changelog, cursor pagination, store-existence guards,
idempotency cross-store isolation, and end-to-end `@openfga/sdk`
conformance against a live HTTP listener. They run against in-memory
SQLite by default (`pnpm test:integration` / `pnpm coverage` need no
Postgres setup); the same suite re-runs against Postgres in CI as a
dialect-portability check (`pnpm test:integration-pg` against a
reachable `OPENFGA_DB_URL=postgres://…`).

## Idempotency keys

Mutating endpoints (`POST /stores`, `POST /stores/:storeId/authorization-models`,
`POST /stores/:storeId/write`) honor the `Idempotency-Key` HTTP header
so clients can safely retry after timeouts, dropped connections, or
ambiguous responses.

The middleware is opt-in. Set `OPENFGA_IDEMPOTENCY_MODE` to control
rollout:

| Mode | Behavior |
|---|---|
| `off` (default) | Middleware is a no-op. Existing clients are unaffected. |
| `optional` | `Idempotency-Key` is honored when present, ignored when absent. |
| `required` | Scoped mutating requests must include `Idempotency-Key`; missing keys return `400`. |

Replay semantics, within `OPENFGA_IDEMPOTENCY_TTL_MS` (default 24 h):

| Situation | Result |
|---|---|
| Same key, same request body | Cached response is replayed. |
| Same key, in-flight retry | `409 idempotency_in_flight`. |
| Same key, different request body | `422 idempotency_fingerprint_mismatch`. |
| Idempotency store unavailable | `503 idempotency_store_unavailable`. |

Idempotency state lives in `<namespace>.idempotency_keys` (where
`<namespace>` is the value of `OPENFGA_DB_NAMESPACE`, default
`openfga`). It is **not** part of the OpenFGA-compatible state
contract — see
[Migrating to upstream OpenFGA](#migrating-to-upstream-openfga) for
the full exclude list.

See [`docs/features/idemnpotency-keys.md`](docs/features/idemnpotency-keys.md)
for the full specification.

## Migrating to upstream OpenFGA

This path is **Postgres-only** — SQLite has no `pg_dump` analog. If
you're running the SQLite backend and want to move to the upstream Go
server, you'll need to bring up a Postgres backend on this server
first, then follow this recipe.

The configured namespace (default `openfga`) mirrors the upstream
OpenFGA reference schema for the tables that ARE part of the wire
contract (`store`, `authorization_model`, `tuple`). Three additional
tables back this server's operational features and are NOT part of
the reference contract; the Kysely Migrator's two tracking tables are
also excluded since they're not OpenFGA state:

| Table | Backs |
|---|---|
| `<namespace>.idempotency_keys` | `Idempotency-Key` HTTP header (see [Idempotency keys](#idempotency-keys)) |
| `<namespace>.tuple_change` | `GET /stores/:storeId/changes` changelog with deterministic per-insertion ordering |
| `<namespace>.assertions` | `GET/PUT /stores/:storeId/assertions/:authorizationModelId` |
| `<namespace>.kysely_migration` | Kysely Migrator's applied-migrations tracking |
| `<namespace>.kysely_migration_lock` | Kysely Migrator's advisory-lock row |

When migrating to the upstream OpenFGA Go server, exclude all five
tables from the dump (substitute your configured namespace for
`<namespace>`; the default is `openfga`):

```sh
pg_dump --schema=<namespace> \
        --exclude-table='<namespace>.idempotency_keys' \
        --exclude-table='<namespace>.tuple_change' \
        --exclude-table='<namespace>.assertions' \
        --exclude-table='<namespace>.kysely_migration' \
        --exclude-table='<namespace>.kysely_migration_lock'
```

The migration files for each operational table document the same
recipe inline — see `migrations/1777824000000_idempotency-keys.ts`,
`migrations/1777910400000_tuple-changes.ts`, and
`migrations/1777996800000_assertions.ts`.

## Status: tradeoffs of the current implementation

- **No graph-traversal optimizations.** Straight DFS. Acceptable at
  prototype scale; revisit if check latency becomes a hot path.
- **`list-objects` filters via `check()`.** O(candidates × check).
  Same prototype-scale acceptance.
- **No conditional tuples / ABAC.** The schema reserves space for
  conditions but the evaluator ignores them. Add when you need them.

## Design

See [`docs/PRD.md`](docs/PRD.md) for the project's guiding goals,
non-goals, and the migration path to the upstream OpenFGA Go server
(which is `pg_dump --schema=openfga` plus an env-var flip on
consuming applications).
