-- OpenFGA-Node-Server: storage schema.
--
-- Mirrors the OpenFGA reference server's Postgres schema for the
-- subset this project implements (stores, authorization models, tuples).
-- A future migration to the upstream OpenFGA Go server is mechanical:
-- `pg_dump --schema=openfga` and point the new server's --datastore-uri
-- at the dump.
--
-- The schema is named `openfga` so it can coexist alongside an
-- application's own schema in the same Postgres instance without
-- collision. RLS is enabled with no policies so that any direct
-- non-service-role query is denied by default.

CREATE SCHEMA IF NOT EXISTS openfga;
COMMENT ON SCHEMA openfga IS
  'OpenFGA-Node-Server state. Stores, authorization models, and relationship tuples.';

-- ─── Stores ────────────────────────────────────────────────
-- A store is a namespace for tuples and model versions. Each
-- environment (dev/uat/prod) typically uses its own store.

CREATE TABLE openfga.store (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- ─── Authorization models ──────────────────────────────────
-- Models are immutable once written — matches OpenFGA semantics.
-- A new model version is created on each `load-model` invocation.

CREATE TABLE openfga.authorization_model (
  id              text PRIMARY KEY,
  store_id        text NOT NULL REFERENCES openfga.store(id) ON DELETE CASCADE,
  schema_version  text NOT NULL,
  model           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX authorization_model_store_idx
  ON openfga.authorization_model (store_id, created_at DESC);

-- ─── Tuples ────────────────────────────────────────────────
-- The mutable relationship state. Composite primary key doubles as
-- natural deduplication.
--
-- `user_str` holds the OpenFGA user reference verbatim — direct user
-- ("user:<id>"), userset reference ("<type>:<id>#<relation>"), or
-- typed wildcard ("user:*").

CREATE TABLE openfga.tuple (
  store_id     text NOT NULL REFERENCES openfga.store(id) ON DELETE CASCADE,
  object_type  text NOT NULL,
  object_id    text NOT NULL,
  relation     text NOT NULL,
  user_str     text NOT NULL,
  inserted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, object_type, object_id, relation, user_str)
);

-- For check evaluation: "what objects does this user have this relation on?"
CREATE INDEX tuple_user_lookup_idx
  ON openfga.tuple (store_id, user_str, relation);

-- For listObjects evaluation: "who has this relation on this object type?"
CREATE INDEX tuple_object_lookup_idx
  ON openfga.tuple (store_id, object_type, relation, user_str);

-- ─── Row-level security ────────────────────────────────────
-- Enable RLS with no policies → denies everything by default.
-- The server connects as a service-role / superuser and bypasses RLS;
-- any other connection (e.g. an application reading the same Postgres
-- with a different role) cannot accidentally read or mutate authz state.

ALTER TABLE openfga.store ENABLE ROW LEVEL SECURITY;
ALTER TABLE openfga.authorization_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE openfga.tuple ENABLE ROW LEVEL SECURITY;
