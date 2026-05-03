/**
 * SQLite smoke tests for the ported `tuples.ts` and `idempotency.ts`
 * modules (recovered under openfga-8ys after the openfga-6tv vitest
 * hang investigation).
 *
 * Comprehensive coverage lands in openfga-yg9 (child #7) when SQLite
 * is wired into the vitest unit project as the default driver. This
 * file is a focused smoke test that exercises each function against
 * an in-memory SQLite to catch port mistakes locally; integration
 * tests on real Postgres validate the production path in CI.
 *
 * Bootstrap: openfga-g2j has shipped Kysely Migrator support, so
 * this file uses migrator.migrateToLatest() against the in-memory
 * SQLite to bring up the schema. That replaces the hand-rolled
 * `bootstrap()` pattern that the openfga-6tv smoke tests used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import {
  applyTupleMutations,
  DuplicateTupleError,
  listAllForRelation,
  listChangesPage,
  listObjectIdsForUser,
  listUsersForRelation,
  MissingTupleError,
  readTuplesPage,
  writeTuples,
} from '../../src/storage/tuples'
import {
  claimKey,
  completeKey,
  releaseKey,
} from '../../src/storage/idempotency'

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

async function bootstrap(): Promise<void> {
  // Hand-rolled DDL mirroring migrations/*.ts for the SQLite path.
  // The migrations themselves are validated by `pnpm migrate up`
  // against a real SQLite file (manual smoke during openfga-g2j) and
  // by CI integration tests on Postgres. Using the Kysely Migrator
  // here causes a vitest-specific hang under sequential tests
  // (see openfga-8ys investigation): two or more tests that each
  // call migrator.migrateToLatest() against fresh :memory: DBs in
  // sequence hang the worker; the same migrator works fine in
  // isolation and via the production CLI under tsx. The scope of
  // these smoke tests is to catch storage-module port mistakes,
  // not to re-validate migrations, so we sidestep the issue by
  // creating tables directly.
  const db = getDb()
  await sql`
    create table openfga_store (
      id text primary key, name text not null,
      created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at text
    )
  `.execute(db)
  await sql`
    create table openfga_authorization_model (
      id text primary key,
      store_id text not null references openfga_store(id) on delete cascade,
      schema_version text not null,
      model text not null,
      created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `.execute(db)
  await sql`
    create table openfga_tuple (
      store_id text not null references openfga_store(id) on delete cascade,
      object_type text not null, object_id text not null,
      relation text not null, user_str text not null,
      inserted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      primary key (store_id, object_type, object_id, relation, user_str)
    )
  `.execute(db)
  await sql`
    create table openfga_tuple_change (
      id text primary key,
      seq integer not null default 0,
      store_id text not null references openfga_store(id),
      object_type text not null, object_id text not null,
      relation text not null, user_str text not null,
      operation text not null,
      inserted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `.execute(db)
  await sql`
    create trigger openfga_tuple_change_seq_assign
    after insert on openfga_tuple_change
    begin
      update openfga_tuple_change set seq = NEW.rowid where id = NEW.id;
    end
  `.execute(db)
  await sql`
    create table openfga_idempotency_keys (
      key text primary key,
      request_hash text not null,
      status text not null,
      response_status integer,
      response_body text,
      created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at text
    )
  `.execute(db)
}

async function makeStore(id = 's1'): Promise<string> {
  await sql`insert into openfga_store (id, name) values (${id}, ${id})`.execute(getDb())
  return id
}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  await resetDb()
  process.env['OPENFGA_DB_URL'] = ':memory:'
  delete process.env['OPENFGA_DB_NAMESPACE']
  await bootstrap()
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetDb()
})

describe('tuples (Kysely port)', () => {
  it('writes a tuple and records a changelog entry transactionally', async () => {
    const storeId = await makeStore()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])
    const tuples = await getDb().selectFrom('tuple').selectAll().where('store_id', '=', storeId).execute()
    expect(tuples).toHaveLength(1)
    const changes = await getDb().selectFrom('tuple_change').selectAll().where('store_id', '=', storeId).execute()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.operation).toBe('TUPLE_OPERATION_WRITE')
  })

  it('skips changelog when ON CONFLICT DO NOTHING ignores a duplicate', async () => {
    const storeId = await makeStore()
    const t = { user: 'user:alice', relation: 'viewer', object: 'doc:1' }
    await writeTuples(storeId, [t])
    await writeTuples(storeId, [t])
    const tuples = await getDb().selectFrom('tuple').selectAll().where('store_id', '=', storeId).execute()
    const changes = await getDb().selectFrom('tuple_change').selectAll().where('store_id', '=', storeId).execute()
    expect(tuples).toHaveLength(1)
    expect(changes).toHaveLength(1)
  })

  it('throws DuplicateTupleError when onDuplicate=error and tuple already exists', async () => {
    const storeId = await makeStore()
    const t = { user: 'user:alice', relation: 'viewer', object: 'doc:1' }
    await writeTuples(storeId, [t])
    await expect(applyTupleMutations(storeId, {
      writes: [t], deletes: [], onDuplicate: 'error', onMissing: 'ignore',
    })).rejects.toThrow(DuplicateTupleError)
  })

  it('throws MissingTupleError when onMissing=error and tuple does not exist', async () => {
    const storeId = await makeStore()
    await expect(applyTupleMutations(storeId, {
      writes: [],
      deletes: [{ user: 'user:bob', relation: 'viewer', object: 'doc:1' }],
      onDuplicate: 'ignore', onMissing: 'error',
    })).rejects.toThrow(MissingTupleError)
  })

  it('rolls back the entire transaction when one operation fails', async () => {
    const storeId = await makeStore()
    const ok = { user: 'user:a', relation: 'viewer', object: 'doc:1' }
    const dupe = { user: 'user:b', relation: 'viewer', object: 'doc:2' }
    await writeTuples(storeId, [dupe])
    await expect(applyTupleMutations(storeId, {
      writes: [ok, dupe], deletes: [], onDuplicate: 'error', onMissing: 'ignore',
    })).rejects.toThrow(DuplicateTupleError)
    const tuples = await getDb().selectFrom('tuple').select('user_str').where('store_id', '=', storeId).execute()
    expect(tuples.map(r => r.user_str)).toEqual(['user:b'])
    const changes = await getDb().selectFrom('tuple_change').selectAll().where('store_id', '=', storeId).execute()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.user_str).toBe('user:b')
  })

  describe('evaluator helpers', () => {
    it('listUsersForRelation returns user_strs for (object, relation)', async () => {
      const storeId = await makeStore()
      await writeTuples(storeId, [
        { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
        { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
        { user: 'user:carol', relation: 'editor', object: 'doc:1' },
      ])
      const users = await listUsersForRelation(storeId, 'doc', '1', 'viewer')
      expect(users.sort()).toEqual(['user:alice', 'user:bob'])
    })

    it('listObjectIdsForUser returns DISTINCT object_ids', async () => {
      const storeId = await makeStore()
      await writeTuples(storeId, [
        { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
        { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
        { user: 'user:bob', relation: 'viewer', object: 'doc:3' },
      ])
      const ids = await listObjectIdsForUser(storeId, 'doc', 'viewer', 'user:alice')
      expect(ids.sort()).toEqual(['1', '2'])
    })

    it('listAllForRelation returns (object_id, user_str) pairs', async () => {
      const storeId = await makeStore()
      await writeTuples(storeId, [
        { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
        { user: 'user:bob', relation: 'viewer', object: 'doc:2' },
      ])
      const pairs = await listAllForRelation(storeId, 'doc', 'viewer')
      expect(pairs.map(p => `${p.object_id}/${p.user_str}`).sort())
        .toEqual(['1/user:alice', '2/user:bob'])
    })
  })

  it('readTuplesPage cursor-walks ASC to terminal page', async () => {
    const storeId = await makeStore()
    const tuples = Array.from({ length: 5 }, (_, i) => ({
      user: `user:u${i}`, relation: 'viewer', object: `doc:${i}`,
    }))
    for (const t of tuples) {
      await writeTuples(storeId, [t])
    }
    const seen: string[] = []
    let cursor: Awaited<ReturnType<typeof readTuplesPage>>['nextCursor'] = null
    let safety = 50
    while (safety-- > 0) {
      const page = await readTuplesPage(storeId, { pageSize: 2 }, cursor)
      seen.push(...page.rows.map(r => `${r.object_type}:${r.object_id}#${r.user_str}`))
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(safety).toBeGreaterThan(0)
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('listChangesPage emits seq as a string and walks the cursor in insertion order', async () => {
    const storeId = await makeStore()
    await applyTupleMutations(storeId, {
      writes: [
        { user: 'user:a', relation: 'viewer', object: 'doc:1' },
        { user: 'user:b', relation: 'viewer', object: 'doc:2' },
        { user: 'user:c', relation: 'viewer', object: 'doc:3' },
      ],
      deletes: [], onDuplicate: 'ignore', onMissing: 'ignore',
    })
    const seen: string[] = []
    const seqs: string[] = []
    let cursor: { inserted_at: string, seq: string } | null = null
    let safety = 20
    while (safety-- > 0) {
      const page = await listChangesPage(storeId, 1, cursor)
      for (const r of page.rows) {
        seen.push(`${r.object_id}:${r.user_str}`)
        expect(typeof r.seq).toBe('string')
        seqs.push(r.seq)
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(safety).toBeGreaterThan(0)
    expect(seen).toEqual(['1:user:a', '2:user:b', '3:user:c'])
    expect(new Set(seqs).size).toBe(3)
  })
})

describe('idempotency (Kysely port)', () => {
  const KEY = 'idem-key-1'
  const FP = 'fingerprint-A'
  const TTL = 60_000

  it('claimKey returns claimed for a fresh key', async () => {
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'claimed' })
  })

  it('claimKey returns in_flight when an earlier claim is still in flight', async () => {
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'claimed' })
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'in_flight' })
  })

  it('claimKey returns mismatch when the same key is reclaimed with a different fingerprint', async () => {
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'claimed' })
    expect(await claimKey(KEY, 'different-fp', TTL)).toEqual({ kind: 'mismatch' })
  })

  it('claimKey returns replay after completeKey', async () => {
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'claimed' })
    await completeKey(KEY, 200, { ok: true })
    const result = await claimKey(KEY, FP, TTL)
    expect(result.kind).toBe('replay')
    if (result.kind === 'replay') {
      expect(result.status).toBe(200)
      expect(result.body).toEqual({ ok: true })
    }
  })

  it('releaseKey removes an in-flight slot so a retry can claim again', async () => {
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'claimed' })
    await releaseKey(KEY)
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'claimed' })
  })

  it('TTL cutoff is computed in SQL — expired rows are deleted before claim', async () => {
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'claimed' })
    await completeKey(KEY, 200, { ok: true })
    await sql`update openfga_idempotency_keys set created_at = '2000-01-01T00:00:00.000Z' where key = ${KEY}`.execute(getDb())
    expect(await claimKey(KEY, 'different-fp', TTL)).toEqual({ kind: 'claimed' })
  })

  it('completeKey serializes JSON response bodies for read-back via replay', async () => {
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'claimed' })
    const body = { stores: [{ id: 's1', name: 'first' }], next: 'cursor-abc' }
    await completeKey(KEY, 201, body)
    const result = await claimKey(KEY, FP, TTL)
    expect(result.kind).toBe('replay')
    if (result.kind === 'replay') {
      expect(result.body).toEqual(body)
    }
  })
})
