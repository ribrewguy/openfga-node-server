# Database Backends

NodeFGA runs against either **Postgres** (production)
or **SQLite** (single-instance, embedded, tests). The dialect is
picked from the scheme of `db.url`:

| `db.url` scheme | Dialect | Suitable for |
|---|---|---|
| `postgres://…`, `postgresql://…` | Postgres (via `pg` + `kysely`) | Production. Multi-instance. |
| `sqlite:…`, `file:…`, `:memory:` | SQLite (via `better-sqlite3` + `kysely`) | Local dev, single-instance, tests. |

All schema and query construction goes through [Kysely](https://kysely.dev),
so the dialect difference is invisible to evaluator and route code.
Schema migrations are dialect-aware and live in `src/storage/migrator.ts`.

## Postgres

The production target. Tested against Postgres 14, 15, 16, 17.

```yaml
db:
  url: postgres://openfga:secret@db.example.com:5432/openfga
  namespace: openfga
  applicationName: openfga-node-server
  pool:
    max: 50
    min: 0
    idleTimeoutMs: 30000
    connectionTimeoutMs: 5000
    statementTimeoutMs: 30000
    queryTimeoutMs: 0
```

### Schema namespace

`db.namespace` is the Postgres schema name (e.g., the `openfga` in
`openfga.tuple`). All this server's tables live under it.
Multi-tenant deployments can run multiple namespaces against the
same database — set `OPENFGA_DB_NAMESPACE=tenant_a` per instance.

The namespace pattern is enforced: `^[a-z][a-z0-9_]{0,62}$`.
Default: `openfga`.

### Pool tuning

- **`max`** — peak connections. Sized to your peak parallel request
  count. Production starting point: 50.
- **`min`** — idle pool floor. Default 0 keeps the pool empty when
  idle, which is fine for steady-state low traffic and lets PG-PgBouncer
  topologies reuse connections more freely. Bump to a small number
  (5–10) if you observe new-connection latency on cold periods.
- **`connectionTimeoutMs`** — how long acquires wait when the pool is
  full. **Always set this in production** (5000 is a good default).
  Without it, a saturated pool causes requests to hang indefinitely,
  which converts a temporary spike into a queue-of-death.
- **`statementTimeoutMs`** — server-side `statement_timeout` SET on
  every connection. Production: 30000.
- **`queryTimeoutMs`** — client-side timeout enforced by `pg`. Leave
  at 0 unless you have a reason; `statementTimeoutMs` is the
  authoritative bound.

### Why `application_name`

`db.applicationName` is what shows up in `pg_stat_activity.application_name`.
Operators querying connection state — "which app is holding this
lock?" — see `openfga-node-server` instead of an empty string. Use
the env var to differentiate between multiple deployments
(`OPENFGA_DB_APPLICATION_NAME=openfga-prod-us-east`).

### Connection pooling at scale

For very high request rates, put PgBouncer in front in transaction-
pool mode. The server uses parameterized queries throughout; nothing
relies on session state.

## SQLite

The dev target and the embedded/serverless target.

```yaml
db:
  url: file:./var/openfga.db
```

Or in-memory:

```yaml
db:
  url: ':memory:'
```

The SQLite backend uses `better-sqlite3` (synchronous, written in
C++). The `pool.max` setting is honored but only one connection is
strictly necessary; the pool exists for API symmetry with Postgres.

### Limitations vs Postgres

- **No advisory locks across processes.** SQLite serializes writes
  via file-level locking. Multi-instance writers on a shared SQLite
  file is *not* supported.
- **No schema namespaces.** `db.namespace` is used as a table prefix
  instead. A namespace of `openfga` produces tables like
  `openfga_tuple`, `openfga_tuple_change`, etc.
- **`pg`-specific config is ignored.** `applicationName`,
  `statementTimeoutMs`, `queryTimeoutMs` have no effect on SQLite.

### File vs memory

`:memory:` lives for the lifetime of the process and disappears on
restart. Useful for tests and ephemeral fixtures.

`file:./path/to.db` persists to disk. Make sure the directory
exists and the process has write access. WAL mode is enabled on the
connection so concurrent readers don't block the writer.

## Migrations

Migrations live in `src/storage/migrator.ts` and run via the
Kysely-typed CLI:

```sh
pnpm migrate up         # apply all pending
pnpm migrate down       # roll back the most recent
pnpm migrate status     # list applied/pending
```

The migrator handles both dialects transparently. See
[Schema Migrations](/runbooks/schema-migrations) for the deploy
workflow and rollback considerations.

### Self-bootstrap

```yaml
migrateOnStart: true
```

Runs `migrator.migrateToLatest()` before binding listeners. The
migrator advisory lock (Postgres) or file lock (SQLite) serializes
concurrent boots; only the first one actually applies.

**Recommended OFF for production multi-instance deployments.** Make
migrations an explicit deploy step. Recommended ON for single-
instance containers and embedded SQLite.

## Table layout

Both dialects expose the same logical tables:

| Table | Purpose |
|---|---|
| `tuple` | The store of `(store_id, object_type, object_id, relation, user, …)` rows. |
| `tuple_change` | The changelog feeding `/read-changes`. |
| `authorization_model` | Versioned model snapshots per store. |
| `store` | Store metadata. |
| `assertion` | Test-assertion sets per model. |
| `idempotency` | Idempotency-Key replay records. |
| `migration` | Migrator bookkeeping. |

Indexes are placed for the evaluator's hot-path queries — tuple
prefix scans by `(store_id, object_type, object_id)` and by
`(store_id, user_type, user_id)`. See the migrator source for the
authoritative definition.

## See also

- [Schema Migrations](/runbooks/schema-migrations) — deploy workflow
- [Installation](/guide/installation) — prereqs and bootstrap
