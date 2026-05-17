# Deployment

This runbook walks the path from a fresh image to a healthy
production instance.

## Prerequisites

- A Postgres instance reachable from the deployment target.
- The schema namespace pre-created (Postgres):
  `CREATE SCHEMA IF NOT EXISTS openfga;`
- A user with `USAGE`, `CREATE`, `SELECT`, `INSERT`, `UPDATE`,
  `DELETE` on that schema (or schema ownership).

## 1. Build the image

```sh
docker build -t openfga-node-server:latest .
```

The included `Dockerfile` produces a slim Node 22 image with the
production build emitted by `pnpm build`.

## 2. Run migrations

**Do not** start production pods with `migrateOnStart: true`. Run
migrations as a discrete deploy step from a one-shot job:

```sh
docker run --rm \
  -e OPENFGA_DB_URL=postgres://openfga:secret@db:5432/openfga \
  openfga-node-server:latest \
  pnpm migrate up
```

In Kubernetes, prefer a `Job` over an `initContainer` so multiple
replicas don't race against the same migration lock. The migrator's
advisory lock serializes correctly but the queue still slows down
every replica's boot.

## 3. Configure secrets

Provide secrets via your platform's secret manager. Minimum:

| Secret | Env var |
|---|---|
| Database DSN | `OPENFGA_DB_URL` |
| Pre-shared keys (if `auth.mode=preshared`) | `OPENFGA_AUTH_PRESHARED_KEYS` |
| OIDC client config (if any non-public IdP setting) | — |

OIDC issuers themselves are typically public URLs and live in
`openfga.config.yaml` rather than secrets.

## 4. Configure the runtime

A minimal production `openfga.config.yaml`:

```yaml
db:
  pool:
    max: 50
    connectionTimeoutMs: 5000
    statementTimeoutMs: 30000

listeners:
  http:
    enabled: true
    port: 8080

log:
  level: info

auth:
  mode: oidc      # or preshared
  oidc:
    issuer: https://auth.example.com
    audience: openfga-server

otel:
  enabled: true
  exporter:
    type: otlp-http
    endpoint: http://otel-collector.observability:4318/v1/traces
  sampler:
    type: parentbased_traceidratio
    ratio: 0.05
```

## 5. Wire health checks

```yaml
livenessProbe:
  httpGet: { path: /health, port: 8080 }
  initialDelaySeconds: 5
  periodSeconds: 30

readinessProbe:
  httpGet: { path: /ready, port: 8080 }
  initialDelaySeconds: 3
  periodSeconds: 5
```

See [Health & Readiness](/guide/health-readiness) for the full
contract.

## 6. Deploy

Roll out at your platform's normal pace. The server takes ~1 second
to bind sockets after the process starts; readiness probes will
fail-then-pass on each new pod.

### What to watch during rollout

- Log line `service_started` on each new pod.
- Log line `oidc_setup_ok` if `auth.mode = oidc` (boot-time
  discovery succeeded).
- Log line `otel_setup_ok` if `otel.enabled = true`.
- `/ready` probes flipping to 200.
- Error rate on `/stores/*` from your existing observability.

## 7. Smoke test

```sh
# Auth-exempt probe
curl -sS https://openfga.example.com/health
# {"status":"ok"}

# With a real token
TOKEN=$(get-token-from-idp)
STORE_ID=01HXYZ...
curl -sS -X POST https://openfga.example.com/stores/$STORE_ID/check \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "tuple_key": { "user": "user:smoke-test", "relation": "viewer", "object": "doc:smoke" } }'
```

## Rollback

The server has no in-process state to migrate. To roll back:

1. Deploy the previous image.
2. If the new release applied a migration the old image doesn't
   understand, **do not roll back the migration without confirming
   it's safe**. Most migrations in this codebase are additive (new
   tables, new indexes) and the previous image runs fine against the
   newer schema. Destructive migrations are flagged in the migrator
   source and should not be reverted without a coordinated
   maintenance window.

See [Schema Migrations](/runbooks/schema-migrations) for the
migration safety contract.

## See also

- [Schema Migrations](/runbooks/schema-migrations)
- [Enable OpenTelemetry](/runbooks/enable-otel)
- [Set Up OIDC Issuer](/runbooks/setup-oidc)
