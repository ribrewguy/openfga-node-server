# Schema Migrations

Schema migrations live in `src/storage/migrator.ts` and run via
`pnpm migrate`. This runbook covers the deploy workflow and the
rollback considerations.

## CLI

```sh
pnpm migrate up        # apply all pending migrations
pnpm migrate down      # roll back the most recent migration
pnpm migrate status    # list applied / pending
```

All commands honor `OPENFGA_DB_URL` and `OPENFGA_DB_NAMESPACE`.

## Deploy workflow

The recommended sequence for production:

1. **Deploy the migrate-only job** with the new image. This runs
   `pnpm migrate up` against the production database and exits.
2. **Verify** that `pnpm migrate status` shows no pending migrations
   from the target image.
3. **Roll out the server pods** with the new image. New pods boot
   against the freshly migrated schema.

Why separate? **Migrations should not race against pod startup.**
The migrator's advisory lock serializes correctly, but multiple
pods racing for the lock at boot:

- Queues every pod on the lock — readiness probes flap.
- Hides migration failures behind the first pod's success — a
  partial migration leaves the system in a degraded state that's
  hard to diagnose from the pod's perspective.

Run migrations explicitly. Boot the server against the result.

## Self-bootstrap mode

For single-instance deployments (containers, embedded SQLite), the
self-bootstrap option is appropriate:

```yaml
migrateOnStart: true
```

The server runs `migrator.migrateToLatest()` before binding sockets.
Boot fails fast if the migration fails — the server refuses to
accept traffic against a half-migrated database.

**Recommended OFF for multi-instance production.** ON for:

- Single-process Docker containers
- SQLite-backed embedded deployments
- Local development
- CI fixtures

## Migration safety contract

Migrations in this codebase are **additive by default**:

- **New tables** — safe; old code ignores them.
- **New columns with defaults** — safe; old code ignores them.
- **New indexes** — safe; may be slow on large tables (use
  `CREATE INDEX CONCURRENTLY` patterns where applicable).
- **Renamed columns** — NOT safe across a rolling deploy. Add the
  new column, dual-write, deprecate the old.
- **Dropped columns** — NOT safe across a rolling deploy. Remove
  reads first, then drop in a separate release.
- **Type changes** — case-by-case.

When you're authoring a destructive migration:

1. Flag it in the migration comment.
2. Document the required deploy procedure (full drain? blue/green?).
3. Pair-review with someone who's done destructive PG migrations
   before.

## Rollback

`pnpm migrate down` rolls back the most recent migration. This is
implemented for all migrations as a matter of policy, but rollback
of a *destructive* migration is generally not recoverable — once
data is dropped, `down` can recreate the table shape but not the
data.

Use rollback only when:

1. You just deployed a migration in a non-production environment
   and discovered a bug.
2. The migration was strictly additive (new table, new column with
   default).

For production rollback of a real outage, **roll the application
back without rolling the migration back**. The previous image
typically runs fine against the newer schema because the migrations
are additive. Once you've stabilized, fix the migration forward in
the next release.

## Migration during cutover

On a coordinated maintenance window (rare for this server, more
common for major-version IdP changes):

1. Drain traffic (DNS / load balancer to maintenance page).
2. `pnpm migrate up` against production.
3. Deploy the new image.
4. Verify with smoke tests.
5. Resume traffic.

The migrator's advisory lock prevents concurrent runs, so it's also
safe to fire `pnpm migrate up` from multiple places — only one will
do the work.

## Authoring a new migration

Migrations are TypeScript modules:

```
src/storage/migrations/
  001_initial_schema.ts
  002_add_assertions_table.ts
  003_add_idempotency_table.ts
  ...
```

Each module exports `up` and `down` functions taking a Kysely
instance:

```ts
import type { Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('foo')
    .addColumn('id', 'text', col => col.primaryKey())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('foo').execute()
}
```

The migrator picks up files matching `\d{3}_*.ts` and applies them
in numeric order. New migrations:

1. Add the file with the next sequential prefix.
2. Run `pnpm migrate up` against a fresh database.
3. Verify the resulting schema.
4. Run `pnpm migrate down` to verify rollback works.
5. Run the full test suite (`pnpm test`) — there are migration
   tests that catch ordering bugs.

## See also

- [Database Backends](/guide/database) — table layout and dialect
  differences
- [Deployment](/runbooks/deployment) — production rollout
