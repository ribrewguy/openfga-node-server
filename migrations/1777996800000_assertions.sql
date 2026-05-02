-- OpenFGA-Node-Server: model assertion storage.
--
-- Stores OpenFGA assertion sets — the "did this tuple_key resolve to
-- the expected boolean?" tests that an authorization model author
-- pins to a specific model version. Assertions are upserted in full
-- per (store, model) — the PUT API overwrites the whole array.
--
-- The table sits alongside idempotency_keys and tuple_change as a
-- non-OpenFGA-compatible operational helper. Operators migrating to
-- upstream OpenFGA exclude this table from pg_dump:
--
--   pg_dump --schema=openfga \
--           --exclude-table='openfga.idempotency_keys' \
--           --exclude-table='openfga.tuple_change' \
--           --exclude-table='openfga.assertions'
--
-- See docs/PRD.md and openfga-hqr for the full design.

CREATE TABLE openfga.assertions (
  store_id                 text NOT NULL REFERENCES openfga.store(id),
  -- The model id is a soft reference. Models are immutable, so
  -- there's no delete cascade to track. A row with a stale model id
  -- is harmless — operators see it, the assertions are wire-readable,
  -- and the PUT path overwrites cleanly.
  authorization_model_id   text NOT NULL,
  -- The full assertions array stored as a single JSONB document.
  -- The PUT API replaces the whole array, so no per-row indexing is
  -- needed; reads return the document verbatim.
  assertions               jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, authorization_model_id)
);

ALTER TABLE openfga.assertions ENABLE ROW LEVEL SECURITY;
