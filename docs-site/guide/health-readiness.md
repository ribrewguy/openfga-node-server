# Health & Readiness

NodeFGA exposes two unauthenticated probe endpoints
for orchestrators (Kubernetes, ECS, systemd, etc.) to gate traffic.

## `/health` — liveness

```
GET /health → 200 OK
{ "status": "ok" }
```

Returns 200 as long as the HTTP server is accepting connections. Use
this as the **Kubernetes liveness probe**: if it ever returns
non-200, the orchestrator should restart the pod.

`/health` does **not** check the database. A pod with a degraded
database connection is not a liveness failure — it's a readiness
failure. Restarting the pod doesn't fix a downed database; it just
multiplies the disruption.

## `/ready` — readiness

```
GET /ready → 200 OK
{ "status": "ok" }
```

Or, if the database isn't reachable or the schema isn't migrated:

```
GET /ready → 503 Service Unavailable
{ "status": "unhealthy", "reason": "db_unreachable" }
```

```
GET /ready → 503 Service Unavailable
{ "status": "unhealthy", "reason": "schema_missing" }
```

Use this as the **Kubernetes readiness probe**: when it returns
non-200, the orchestrator removes the pod from the service mesh
without restarting it. When the database recovers, the next
probe returns 200 and traffic resumes.

The DB check runs one catalog query against the configured namespace
(Postgres: `to_regclass(...)` over each name; SQLite:
`sqlite_master` table-name lookup) to confirm the core tables exist:

- `<namespace>.store`
- `<namespace>.authorization_model`
- `<namespace>.tuple`
- `<namespace>.kysely_migration`

`kysely_migration`'s absence is the cleanest signal that no migration
has ever run against the configured namespace — the common
"forgot to `pnpm migrate up`" production misconfiguration.

The two reasons distinguish operator-visible failure modes:

| `reason` | What it means |
|---|---|
| `db_unreachable` | Connection acquire, catalog query, or driver init threw. Network, auth, DSN, or driver-level problem. |
| `schema_missing` | The query succeeded but at least one core table is absent. Run `pnpm migrate up`, or check that `OPENFGA_DB_NAMESPACE` points at the right schema. |

The response body intentionally does not leak DSN, host, schema, or
underlying error detail — only the classifying `reason`.

## Kubernetes example

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 30
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 3
  periodSeconds: 5
  failureThreshold: 2
```

`initialDelaySeconds: 5` for liveness lets the process bind and start
its event loop before the first probe. `periodSeconds: 30` is a calm
liveness interval; readiness ticks faster because it's the gating
signal for traffic.

## Auth exemption

Both probes are bypassed by the auth middleware regardless of
`auth.mode`. This is hardcoded — Kubernetes-style probes don't carry
credentials, and a misconfigured auth mode that blocked probes would
brick rolling updates.

If you need to keep probes private from the public network, put the
server behind an ingress and don't route `/health` or `/ready`
externally. The server doesn't gate them by IP because that's the
ingress controller's job.

## Self-bootstrap interaction

When `migrateOnStart: true` is set, the server runs migrations
before binding listeners. Liveness probes will fail with connection-
refused during this window because the process is up but the
socket isn't.

`initialDelaySeconds` on the liveness probe should account for the
worst-case migration duration. For a fresh schema on Postgres, that's
typically <2 seconds; for a database recovering from a hot-standby
promotion with pending migrations, it can be longer. Tune for your
deployment.

The recommended pattern for multi-instance deployments is
**`migrateOnStart: false`** plus an explicit `pnpm migrate up` deploy
step. That keeps probe semantics simple — the process is either up or
restarting; never "up but not bound."

## What probes don't catch

- **Misconfigured authorization model.** A store with a bad model
  loads on first request, not at boot. A model that doesn't parse
  returns 400 to clients; it doesn't fail readiness.
- **OIDC issuer downtime.** Once boot-time discovery succeeds, JWKS
  stays cached. An issuer outage doesn't flip readiness until the
  cache expires AND a request needs a fresh JWKS.
- **Slow database.** `/ready`'s query is sub-millisecond on a
  healthy connection. A pool fully saturated with slow queries
  *might* fail the readiness probe under the connection-acquire
  timeout, but that's a downstream effect, not a direct signal.

For deeper failure detection, instrument with [OpenTelemetry](/guide/observability)
and alert on the SLO derived from real evaluator traffic.

## See also

- [Logging](/guide/logging) — what the probes log on failure
- [Deployment Runbook](/runbooks/deployment) — orchestrator wiring
