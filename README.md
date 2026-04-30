# openfga-node-server

OpenFGA-wire-compatible authorization server in Node. Drop-in for the
OpenFGA reference (Go) server for the surface this project implements.

Built to fill a gap: serverless-friendly Node deployments (Vercel, Fly,
Cloud Run, etc.) often can't run the Go binary as a sidecar, and the
managed offerings (Auth0 FGA / openfga.cloud) aren't always the right
shape. This server runs anywhere Node runs, talks the OpenFGA HTTP
protocol byte-for-byte, and stores state in Postgres in a schema that
mirrors the upstream's reference schema — so a future migration to the
Go server is `pg_dump --schema=openfga` plus an env-var flip.

## Status

Prototype. Not all OpenFGA endpoints are implemented. See **Implemented
endpoints** below for the supported surface.

## Quick start

```sh
pnpm install

# Apply the schema migration to a Postgres of your choice. Any tool
# that runs raw SQL works — psql, sqlx, supabase migration up, etc.
psql "$OPENFGA_DB_URL" -f migrations/001_openfga_schema.sql

# Boot the server.
OPENFGA_DB_URL=postgresql://... PORT=8080 pnpm dev

# In another shell: load the example model.
OPENFGA_API_URL=http://localhost:8080 pnpm load-model tests/fixtures/github.fga
# (Copy the printed OPENFGA_STORE_ID into your environment for subsequent calls.)
```

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `OPENFGA_DB_URL` | yes | — | Postgres DSN for the `openfga` schema. |
| `PORT` | no | `8080` | HTTP port to listen on. |
| `OPENFGA_API_URL` | CLI only | `http://localhost:8080` | Used by `load-model` to reach the running server. |
| `OPENFGA_STORE_ID` | CLI only | — | If set, `load-model` writes the model into this store. If unset, a new store is created and the id is printed. |

## Implemented endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/stores` | Create a store. |
| `POST` | `/stores/:storeId/authorization-models` | Write a new authorization model (immutable). |
| `GET`  | `/stores/:storeId/authorization-models` | List models, newest first. |
| `GET`  | `/stores/:storeId/authorization-models/:id` | Read a specific model. |
| `POST` | `/stores/:storeId/check` | Authorization check. |
| `POST` | `/stores/:storeId/write` | Write or delete tuples. |
| `POST` | `/stores/:storeId/read` | Read tuples (filterable). |
| `POST` | `/stores/:storeId/list-objects` | List objects of a type a user has a relation on. |
| `GET`  | `/health` | Liveness check. |

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
