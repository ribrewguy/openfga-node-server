-- OpenFGA-Node-Server: idempotency-key storage.
--
-- Stores Idempotency-Key state for mutating endpoints so retries after
-- timeouts, network failures, or ambiguous responses replay the
-- original response instead of duplicating side effects.
--
-- This table lives in the openfga schema for operational simplicity
-- (single database, single migration system, single connection pool).
-- It is NOT part of the OpenFGA-compatible state contract and must be
-- excluded from schema dumps that target upstream OpenFGA migration:
--
--   pg_dump --schema=openfga \
--           --exclude-table='openfga.idempotency_keys'
--
-- See docs/PRD.md §"Idempotency keys" and
-- docs/features/idemnpotency-keys.md for the full design.

CREATE TABLE openfga.idempotency_keys (
  -- Client-supplied Idempotency-Key header value.
  key             text PRIMARY KEY,

  -- Hex-encoded SHA-256 of the canonical request fingerprint
  -- (method + path + raw body bytes). Same key with a different
  -- fingerprint is a client error, not a replay.
  request_hash    text NOT NULL,

  -- Lifecycle status. 'in_flight' means a handler claimed this key
  -- and has not yet recorded a response. 'completed' means the handler
  -- finished and the response is cached for replay.
  status          text NOT NULL CHECK (status IN ('in_flight', 'completed')),

  -- HTTP status code of the cached response. NULL while in_flight.
  response_status integer,

  -- JSON response body of the cached response. NULL while in_flight.
  response_body   jsonb,

  -- Used for TTL. Lookups filter by created_at >= now() - ttl, and
  -- expired rows are deleted on the next claim attempt for the same
  -- key, so no scheduled cleanup is required.
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Set when status transitions to 'completed'. Useful for
  -- observability; not required for the replay protocol itself.
  completed_at    timestamptz
);

-- Supports the TTL-aware cleanup query that removes expired rows
-- before a fresh claim. Without this index, cleanup would scan the
-- whole table on every contended claim.
CREATE INDEX idempotency_keys_created_at_idx
  ON openfga.idempotency_keys (created_at);

-- Match the schema-wide RLS posture: deny by default, server bypasses
-- as service-role.
ALTER TABLE openfga.idempotency_keys ENABLE ROW LEVEL SECURITY;
