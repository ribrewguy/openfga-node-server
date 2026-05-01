# openfga-node-server

OpenFGA-wire-compatible authorization server in Node. Drop-in for the
OpenFGA reference (Go) server for the surface this project implements.

Built to fill a gap: serverless-friendly Node deployments (Vercel, Fly,
Cloud Run, etc.) often can't run the Go binary as a sidecar, and the
managed offerings (Auth0 FGA / openfga.cloud) aren't always the right
shape. This server runs anywhere Node runs, talks the OpenFGA HTTP
protocol byte-for-byte, and stores state in Postgres in a schema that
mirrors the upstream's reference schema — so a future migration to the
Go server is `pg_dump --schema=openfga` (with one excluded table for
idempotency state, see [Idempotency keys](#idempotency-keys)) plus an
env-var flip.

## Status

Prototype. Not all OpenFGA endpoints are implemented. See **Implemented
endpoints** below for the supported surface.

## Quick start

```sh
pnpm install

# Configure environment. Copy the template and fill in OPENFGA_DB_URL.
cp .env.example .env
$EDITOR .env

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
| `POST` | `/stores` | Create a store. Idempotent. |
| `POST` | `/stores/:storeId/authorization-models` | Write a new authorization model (immutable). Idempotent. |
| `GET`  | `/stores/:storeId/authorization-models` | List models, newest first. |
| `GET`  | `/stores/:storeId/authorization-models/:id` | Read a specific model. |
| `POST` | `/stores/:storeId/check` | Authorization check. |
| `POST` | `/stores/:storeId/write` | Write or delete tuples. Idempotent. |
| `POST` | `/stores/:storeId/read` | Read tuples (filterable). |
| `POST` | `/stores/:storeId/list-objects` | List objects of a type a user has a relation on. |
| `GET`  | `/health` | Liveness check. |

"Idempotent" endpoints honor the `Idempotency-Key` HTTP header. See
[Idempotency keys](#idempotency-keys) below.

Everything else (`expand`, `batch-check`, `list-users`, `assertions`,
`changes`) returns `501 Not Implemented`.

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

26 unit tests in `tests/unit/` cover every rewrite type. 2 integration
tests in `tests/integration/` (run when `OPENFGA_DB_URL` is reachable)
prove tuples persist across pool resets.

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

Idempotency state lives in `openfga.idempotency_keys`. It is **not**
part of the OpenFGA-compatible state contract. When migrating to the
upstream OpenFGA Go server, exclude this table from the dump:

```sh
pg_dump --schema=openfga \
        --exclude-table='openfga.idempotency_keys'
```

See [`docs/features/idemnpotency-keys.md`](docs/features/idemnpotency-keys.md)
for the full specification.

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
