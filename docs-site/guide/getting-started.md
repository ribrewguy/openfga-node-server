# Getting Started

NodeFGA is a fine-grained authorization server for Node. It implements
the OpenFGA authorization-model semantics — stores, authorization
models, tuples, and check / list / expand evaluations over a
relationship graph.

The fastest path to a running server:

```sh
# 1. Clone and install.
git clone https://github.com/ribrewguy/openfga-node-server.git
cd openfga-node-server
pnpm install

# 2. Configure. Choose ONE of these surfaces (file wins for shared
#    layout, env vars win for per-deployment secrets).
cp openfga.config.example.yaml openfga.config.yaml
$EDITOR openfga.config.yaml          # set db.url at minimum
# — OR —
cp .env.example .env
$EDITOR .env

# 3. Apply migrations.
pnpm migrate up

# 4. Boot.
pnpm dev
```

The server listens on `:8080` by default. Hit `/health` to confirm
it's alive:

```sh
curl http://localhost:8080/health
# {"status":"ok"}
```

## Pick a database

NodeFGA ships with two backends, selected from the scheme of
`db.url`:

| Scheme | Backend | When to use |
|---|---|---|
| `postgres://…` `postgresql://…` | Postgres | Production. Multi-instance horizontal scaling. |
| `sqlite:…` `file:…` `:memory:` | SQLite | Tests, embedded single-process deployments. Single-writer model; no multi-instance support. |

The same Kysely-typed storage layer drives both — your application
behavior doesn't change between backends.

See [Database Backends](/guide/database) for the operational details
of each.

## What you'll set up next

A typical first session covers, in order:

1. **[Installation](/guide/installation)** — `pnpm install`, schema
   migrations, and where the binaries live.
2. **[Configuration](/guide/configuration)** — the c12-backed
   hierarchical config surface and how it relates to the
   `OPENFGA_*` env vars.
3. **[First authorization check](/guide/first-check)** — load a
   model, write a tuple, run `POST /stores/.../check`.
4. **[Authentication](/guide/authentication)** — gate `/stores/*`
   with pre-shared keys or OIDC.
5. **[Observability](/guide/observability)** — turn on OpenTelemetry
   traces at every API boundary.

## When things go wrong

The server is intentionally fail-fast at boot:

| Symptom | Where to look |
|---|---|
| `OPENFGA_DB_URL is not set` | The database URL is required. Set it in `openfga.config.yaml`'s `db.url` or in `OPENFGA_DB_URL`. |
| `oidc_setup_failed; refusing to start` | OIDC discovery couldn't reach the issuer. Verify `auth.oidc.issuer` and network connectivity. See [Set Up OIDC Issuer](/runbooks/setup-oidc). |
| `otel_setup_failed; refusing to start` | The OTel SDK couldn't initialize. Check the exporter URL and `OTEL_EXPORTER_OTLP_*` env. See [Enable OpenTelemetry](/runbooks/enable-otel). |
| `storage_probe_failed; refusing to start` | The database is unreachable or the schema isn't migrated. Run `pnpm migrate up` or check the `db.url`. |
| 500 responses on `/stores/...` calls | Likely a missing schema. Use `pnpm migrate up` or set `migrateOnStart: true` on single-instance deployments. |

The structured log line preceding the fatal error always carries the
diagnostic field — `reason`, `err`, the offending env var. Tail the
JSON log with `jq` to find the answer.
