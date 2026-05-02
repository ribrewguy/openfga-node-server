# openfga-node-server — Guiding PRD

## Why this project exists

The OpenFGA ecosystem has the upstream Go reference server, the cloud
hosted offering (Auth0 FGA / openfga.cloud), and not much else for
Node. Many serverless deployment targets (Vercel, Cloud Run as a
single image, smaller PaaS platforms) cannot run the Go binary
natively as a sidecar, and the managed offerings aren't always the
right shape (cost, data residency, latency, vendor preference).

This project fills that gap: an OpenFGA-wire-compatible authorization
server in Node, runnable anywhere Node runs.

## Non-goals

- Replacing the OpenFGA reference server in performance-critical
  deployments. The reference Go server has years of optimization on
  the rewrite-algebra hot path; we have straight DFS. If your check
  QPS or model depth pushes those limits, run the Go binary.
- ABAC / conditional tuples. The Postgres schema reserves space for
  conditions but the evaluator ignores them. Add when needed.

## Design principles

1. **Wire-compatible byte-for-byte.** The HTTP request and response
   shapes match the OpenFGA REST API. `@openfga/sdk` clients work
   unchanged.
2. **Schema-compatible byte-for-byte.** The Postgres schema mirrors
   the OpenFGA reference server's reference schema. A future
   migration is `pg_dump --schema=openfga` and a single env-var flip
   on the consuming application.
3. **Boundary-thin core.** The evaluator depends on a `TupleStore`
   interface, not on Postgres directly. Unit tests drive the
   evaluator with an in-memory store; the production wiring uses pg.
   This is what made the original extraction from a Nitro module
   into this standalone project mechanical.
4. **No startup magic.** The server does not auto-load a model on
   boot. Models are written via the regular write-model endpoint,
   same as the OpenFGA reference server. A small `load-model` CLI is
   provided for first-time setup.

## Scope (current)

### Endpoints

Target: full OpenFGA REST API wire compliance for the supported
authorization model and storage semantics. Implemented endpoints must
match OpenFGA request and response shapes so `@openfga/sdk` clients work
unchanged.

Currently implemented:

- `GET /stores` (cursor-paginated)
- `POST /stores`
- `{POST,GET} /stores/:storeId/authorization-models`
- `GET /stores/:storeId/authorization-models/:id`
- `POST /stores/:storeId/check` (with `contextual_tuples`)
- `POST /stores/:storeId/write` (transactional, records changelog)
- `POST /stores/:storeId/read` (cursor-paginated)
- `POST /stores/:storeId/list-objects` (with `contextual_tuples`)
- `POST /stores/:storeId/expand` (with `contextual_tuples`)
- `POST /stores/:storeId/batch-check` (per-item `contextual_tuples`,
  results keyed by `correlation_id`)
- `POST /stores/:storeId/list-users` (userset memberships expanded
  when `user_filter` targets the underlying user type)
- `GET /stores/:storeId/changes` (oldest-first, polling-tail tokens,
  `?type=` and `?start_time=` filters)
- `{GET,PUT} /stores/:storeId/assertions/:authorizationModelId`
- `GET /health` (auth-exempt liveness probe)

The full OpenFGA REST wire-compliance epic (`openfga-68n`) closed
with all seven endpoint children shipped (`openfga-7ct`,
`openfga-rvz`, `openfga-5xn`, `openfga-rae`, `openfga-bh9`,
`openfga-hqr`) plus a `@openfga/sdk` conformance suite
(`openfga-don`) that exercises every endpoint via the high-level
`OpenFgaClient` over real HTTP and asserts no in-scope endpoint
returns `501`.

Cross-cutting OpenFGA-aligned features tracked separately:

- `openfga-371` — OpenTelemetry HTTP instrumentation (see §OpenTelemetry observability)
- `openfga-711` — OIDC authentication mode (`none` and `preshared`
  modes shipped under `openfga-ywi`; OIDC layers onto the same
  middleware dispatch — see §API caller authentication)

### Evaluation algebra

The check evaluator implements the full OpenFGA rewrite-rule set:

- `this` — direct relation. Tuples can be direct user refs
  (`user:<id>`), userset refs (`<type>:<id>#<relation>`), or typed
  wildcards (`<type>:*`).
- `computedUserset` — alias another relation on the same object.
- `tupleToUserset` — "X from Y" — for each tuple via Y, evaluate X.
- `union`, `intersection`, `difference`.

`list-objects` is a forward-walk reverse expansion that filters
candidates through `check()` to preserve correctness across
intersections and differences.

### Storage

Postgres schema named `openfga`. Tables: `store`,
`authorization_model`, `tuple`. Composite primary key on `tuple`
serves as natural deduplication. Indexes on
`(store_id, user_str, relation)` and
`(store_id, object_type, relation, user_str)` cover the two read
patterns the evaluator uses.

RLS is enabled with no policies — direct queries from a non-service
role are blocked at the database, on top of the application-level
boundary discipline.

### API caller authentication

The server supports OpenFGA-aligned API caller authentication modes:

- `none` — default for private-network deployments where the server is
  protected by platform, service mesh, or reverse-proxy controls.
- `shared_key` — bearer-token authentication for deployments that need
  a simple static credential at the API boundary.
- `oidc` — JWT/OIDC validation for deployments that need issuer,
  audience, and key-set based verification.

Authentication is enforced at the HTTP middleware boundary and must not
change OpenFGA request or response shapes for authorized calls.

### Idempotency keys

The server supports the `Idempotency-Key` HTTP header for mutating API
requests so clients can safely retry requests after timeouts, network
failures, or ambiguous connection resets.

Idempotency is enforced at the HTTP middleware boundary for configured
mutating endpoints. It must not change successful OpenFGA response
shapes. Idempotency persistence lives in the `openfga` schema for
operational simplicity; the schema-compatible migration path to
upstream OpenFGA is preserved by excluding the idempotency table at
dump time
(`pg_dump --schema=openfga --exclude-table='openfga.idempotency_keys'`),
which operators run when cutting over.

### OpenTelemetry observability

The server supports OpenTelemetry tracing at the HTTP middleware
boundary. Tracing must respect incoming OpenTelemetry propagation
headers so this server can participate in traces that started upstream.

The default captured request headers must include the standard
propagation headers `traceparent`, `tracestate`, and `baggage`.
Operators can override captured request headers, captured response
headers, service metadata, exporter configuration, and related
OpenTelemetry settings through environment variables.

## Operational shape

- Single Node process. No external service dependencies beyond
  Postgres.
- Connects as a service-role / superuser to bypass RLS. Other
  applications sharing the same Postgres instance must use a
  different role.
- Connection pooling via `pg.Pool` with conservative defaults
  (max 10, idle timeout 30s).
- Stateless above the database — horizontal scaling works without
  coordination.

## Migration path FROM this server TO upstream OpenFGA

Built into the design. When you outgrow this server (performance,
operational maturity, or a need for the not-yet-implemented
endpoints):

1. Provision an upstream OpenFGA Go server with a Postgres datastore.
2. `pg_dump --schema=openfga` from this server's database, restore
   into the new datastore.
3. Update the new OpenFGA server's `--datastore-uri`.
4. Flip `OPENFGA_API_URL` on consuming applications.

No application code changes. No SDK changes. No model changes.

## Future scope (non-binding)

- Authorization model conditions / ABAC.
- Caching layer in front of `check` (the upstream server has one).
- A reverse-expansion algorithm for `list-objects` that doesn't fall
  back to per-candidate `check()`.

## Out of scope

- Hosted / managed offering of this server.
