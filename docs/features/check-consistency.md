# Check Consistency Parameter

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md`, §"Why this project exists" (L1-13), §"Design principles" #1 — "Wire-compatible byte-for-byte" (L26-28), §"Migration path TO upstream OpenFGA" (L201-230). Wire-level parity with upstream OpenFGA is the foundational constraint.
- External protocol: OpenFGA `consistency` parameter on `CheckRequest`. The `ConsistencyPreference` enum was added upstream in v1.5.7 (2024-07-30).
- Pinned SDK: `node_modules/@openfga/sdk/dist/apiModel.d.ts` exports `ConsistencyPreference` with values `UNSPECIFIED`, `MINIMIZE_LATENCY`, `HIGHER_CONSISTENCY`.
- Upstream documentation: `openfga.dev/docs/interacting/consistency` and `openfga.dev/blog/query-consistency-options-announcement`.

## Business Intent

The server's foundational design principle is byte-for-byte wire compatibility with upstream OpenFGA so `@openfga/sdk` clients work unchanged and the documented `pg_dump → upstream` migration path remains valid (PRD §"Design principles" #1, §"Migration path TO upstream OpenFGA").

Upstream added a `consistency` field to `CheckRequest` in v1.5.7. This server currently accepts the field on the wire — `CheckBody` in `src/routes/schemas.ts:136-145` uses Zod `.passthrough()` — but does not validate the enum, does not thread the value into the evaluator, and does not document any contract for how it is interpreted. Today's runtime behavior happens to be one of the legal upstream interpretations (always strong consistency, by virtue of this server having no cache), but that is **accidental** compatibility: the server cannot distinguish `MINIMIZE_LATENCY` from `HIGHER_CONSISTENCY` and could regress this accidental conformance on any future change.

This feature makes upstream parity intentional: validate the enum at the wire boundary, thread the value through the evaluator and storage layers via an additive read-context surface, and document the behavior contract for each storage adapter.

## Goals

- Accept the upstream `consistency` field on `POST /stores/:storeId/check` with the same wire shape as upstream.
- Validate the enum strictly. Only `UNSPECIFIED`, `MINIMIZE_LATENCY`, and `HIGHER_CONSISTENCY` are accepted. Unknown values return `400` per upstream's `enum.defined_only` contract.
- Default to `MINIMIZE_LATENCY` semantics when the field is omitted (matches upstream behavior for the protobuf zero value).
- Thread the resolved `ConsistencyPreference` from the route through the evaluator to the storage layer via a per-request read-context surface that is additive to existing `TupleStore` reads.
- Document the behavior contract for each storage adapter. With no cache layer in this server, the parameter is observationally a no-op for both values (which matches upstream's own "cache disabled by default" baseline).
- Preserve the documented `pg_dump → upstream` migration recipe with no schema changes.

## Non-Goals

- Do not introduce a check subproblem cache or iterator cache in this feature. Caching is a separate concern, and the `consistency` parameter is meaningful regardless of whether a cache exists.
- Do not introduce a Zanzibar zookie or consistency-token mechanism. Upstream itself defers that to a future release; staying consistent with upstream is the constraint.
- Do not extend `consistency` to `Read`, `Expand`, `ListObjects`, `ListUsers`, or `BatchCheck` in this feature. Upstream applies the same parameter to all six. A single-endpoint scope (`Check`) is sufficient as an initial parity step; the others should follow as separate beads.
- Do not change request, response, or error envelopes for clients that omit the field. Existing client behavior remains identical.
- Do not break `pg_dump --schema=openfga` parity. The feature is wire-only; no schema changes.

## Wire-Level Contract

The `consistency` field is a per-request enum on every read-shaped endpoint upstream, defined once and reused across `Check`, `BatchCheck`, `Read`, `Expand`, `ListObjects`, and `ListUsers`. From the upstream API proto:

```protobuf
ConsistencyPreference consistency = 7 [(validate.rules).enum.defined_only = true];
```

JSON wire shape on `Check` (snake_case, what `@openfga/sdk` sends):

```jsonc
POST /stores/{store_id}/check
{
  "tuple_key":              { "user": "...", "relation": "...", "object": "..." },
  "authorization_model_id": "01G...",
  "contextual_tuples":      { "tuple_keys": [...] },
  "context":                { /* google.protobuf.Struct */ },
  "consistency":            "MINIMIZE_LATENCY"
}
```

The proto carries `validate.rules.enum.defined_only = true`. Upstream rejects unknown enum *numbers* at the gRPC boundary; via JSON, an unknown *string* is rejected by the same validator.

## Enum Values

From `node_modules/@openfga/sdk/dist/apiModel.d.ts`:

```ts
export declare enum ConsistencyPreference {
  Unspecified       = "UNSPECIFIED",
  MinimizeLatency   = "MINIMIZE_LATENCY",
  HigherConsistency = "HIGHER_CONSISTENCY"
}
```

| Value | Wire string | Protobuf number | Semantic (upstream) |
|---|---|---|---|
| `Unspecified` | `UNSPECIFIED` | 0 | Protobuf zero value. Upstream treats as `MINIMIZE_LATENCY`. |
| `MinimizeLatency` | `MINIMIZE_LATENCY` | 1 | "OpenFGA will try to minimize latency (e.g. by making use of the cache)." May serve cached results bounded by cache TTL. |
| `HigherConsistency` | `HIGHER_CONSISTENCY` | 2 | "OpenFGA will try to optimize for stronger consistency (e.g. by bypassing cache)." Reads go directly to the datastore regardless of cache enablement. |

The current upstream parameter is a **cache-bypass switch**, not a consistency token. It does not reference a snapshot timestamp and offers no guarantee that two consecutive `MINIMIZE_LATENCY` checks observe the same snapshot. The upstream announcement explicitly notes that zookie-style consistency tokens are a future-release consideration.

Read-your-writes caveat (quoted from upstream `/docs/interacting/consistency`):

> "If you write a tuple and you immediately make a Check on a relation affected by that tuple using `MINIMIZE_LATENCY`, the tuple change might not be taken in consideration if OpenFGA serves the result from the cache."

## Default and Omitted-Field Behavior

| Wire condition | Upstream behavior | This feature |
|---|---|---|
| Field omitted | Parsed as `UNSPECIFIED` (proto zero) → treated as `MINIMIZE_LATENCY` | Same. |
| `null` literal | Treated as omitted. SDK never emits null. | Same. |
| Empty string | Rejected by `enum.defined_only` (HTTP 400) | Same. |
| Unknown enum value | Rejected by `enum.defined_only` (HTTP 400) | Same. |
| Older client → this server | Field omitted; defaults to `MINIMIZE_LATENCY` | Same. |
| Newer client → this server | Field accepted, validated, threaded | Replaces today's silent-discard behavior. |

The current `CheckBody` in `src/routes/schemas.ts:136-145` uses `.passthrough()`, so the field is accepted without validation and then discarded by the route handler. Combined with this server having no cache, the behavior is observationally equivalent to "always strong consistency" — which is *one* of the legal upstream interpretations, but not the documented default. This feature makes the wire-level acceptance intentional and validated.

## Cache Interaction

Upstream cache controls (v1.5.7+):

| Env var | Default | Controls |
|---|---|---|
| `OPENFGA_CHECK_QUERY_CACHE_ENABLED` | `false` | Master switch for the Check subproblem cache. |
| `OPENFGA_CHECK_QUERY_CACHE_LIMIT` | (per upstream `--help`) | Total cache entries allowed. |
| `OPENFGA_CHECK_QUERY_CACHE_TTL` | (per upstream `--help`) | TTL after which entries are evicted. |
| `OPENFGA_CHECK_ITERATOR_TTL` | (per upstream `--help`) | TTL for cached datastore iterators. |
| `OPENFGA_CHECK_CACHE_LIMIT` | (per upstream `--help`) | Combined queries-and-iterators size cap. |

Upstream documents that with the cache disabled (the upstream default), all queries have strong consistency regardless of the consistency mode specified. Eviction is TTL-based; on tuple write, upstream does not push-invalidate — entries simply age out within the TTL window.

This server does not implement any of these caches. The `consistency` field is therefore observationally a no-op today: both values produce datastore-direct reads. This matches upstream behavior in the upstream-default configuration. A future caching feature would change this; that feature is out of scope here.

The exact upstream numeric defaults for the cache TTL and limit settings are not surfaced in the public OpenFGA documentation. They are not required for this feature, but they will be required input for any future caching-feature spec. Capture from `openfga run --help` against a pinned upstream version when caching is taken on as its own bead.

## Gaps vs Current Implementation

### Wire surface

| Aspect | Upstream | This server today |
|---|---|---|
| Field accepted on wire | `consistency: ConsistencyPreference` | Accepted via `.passthrough()` but not validated. |
| Enum validation | `enum.defined_only` rejects bad values | None. Garbage values pass through silently. |
| Default | `UNSPECIFIED` → `MINIMIZE_LATENCY` semantic | Field is discarded after parsing. |

### Evaluator surface

`src/evaluator/check.ts` signature:

```ts
export async function check(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  relation: string,
  object: string,
): Promise<boolean>
```

| Concern | Upstream | This server today |
|---|---|---|
| `consistency` parameter on entry point | Threaded from request to evaluator to datastore reader | Absent. |
| Subproblem cache | Optional, per upstream config | Absent. |
| Iterator cache | Optional, per upstream config | Absent. |
| Datastore read mode | Configurable based on `consistency` | Always direct. Every `evaluateRelation` calls `store.listUsersForRelation`, which reads the datastore. |
| Effective consistency | Configurable | Always strong (datastore-direct). |

### Storage adapter surface

The `TupleStore` interface (referenced from `src/storage/engine-context.ts` and `src/evaluator/tuple-store.ts`) has no read-mode parameter and no per-request read-context surface. Adding `consistency` plumbing requires either an additive optional argument on each method or an additive per-request wrapper. This feature chooses the wrapper pattern; see "Threading the Value" below.

## Validation Strategy

- Replace the `.passthrough()` for the `consistency` field on `CheckBody` with a strict enum schema. Unknown values produce a `400` with the standard error envelope.
- Treat absent and `UNSPECIFIED` as equivalent. The route handler resolves both to the canonical `MINIMIZE_LATENCY` value before threading.

## Threading the Value

- Introduce a small per-request read-context type carrying the resolved `ConsistencyPreference`. Attach it via a wrapper similar in spirit to `withContextualTuples` (`src/routes/index.ts:221`). The wrapper pattern is already established in this codebase for per-request, per-evaluation context.
- The evaluator (`src/evaluator/check.ts`) accepts the read context but does not interpret it — it forwards it to `TupleStore` reads. The evaluator is intentionally consistency-agnostic; only adapters interpret the value.
- Adapters that do not implement consistency-aware reads MAY ignore the context and continue to serve datastore-direct reads. This is upstream-compatible behavior in the absence of a cache.

## Storage Adapter Contract

- **Postgres adapter**: Both values produce datastore-direct reads in this feature. No change to query shape. A future bead may introduce snapshot reads (e.g. `SET TRANSACTION SNAPSHOT`) for `MINIMIZE_LATENCY` once a cache strategy is decided. That is out of scope here.
- **SQLite adapter**: Both values produce datastore-direct reads. No future divergence is planned for this adapter.
- **Future adapters**: MAY honor `MINIMIZE_LATENCY` to relax read freshness within their own constraints. MUST honor `HIGHER_CONSISTENCY` as a strong-consistency read against the authoritative store.

## Endpoint Scope

- This feature: `POST /stores/:storeId/check` only.
- Out of scope (file follow-up beads when work begins): `Read`, `Expand`, `ListObjects`, `ListUsers`, `BatchCheck`. Each should adopt the same enum shape and the same threading approach when addressed.

## Acceptance Criteria

- `POST /stores/:storeId/check` accepts a `consistency` field with `UNSPECIFIED`, `MINIMIZE_LATENCY`, or `HIGHER_CONSISTENCY`.
- A request with an unknown enum value returns `400` with the standard error envelope.
- A request with the field omitted returns the same response body as a request with `MINIMIZE_LATENCY` or `UNSPECIFIED` — no semantic difference visible to clients.
- A request with `HIGHER_CONSISTENCY` returns the same response body as today (Postgres and SQLite adapters serve datastore-direct reads).
- A request with `MINIMIZE_LATENCY` returns the same response body as today (no cache layer; documented as observationally equivalent to `HIGHER_CONSISTENCY` while no cache is implemented).
- Tests cover the four cases above plus a passthrough test asserting that `@openfga/sdk` `CheckRequest` constructions for each `ConsistencyPreference` value succeed against this server.
- Documentation in this file describes the enum semantics, default behavior, the `MAY` / `MUST` adapter contract, and the explicit "no cache today" caveat.
- The `pg_dump --schema=openfga` migration recipe in `docs/PRD.md` §"Migration path TO upstream OpenFGA" remains valid with no changes.

## Open Questions

- Should the per-request read-context object be threaded as an additive optional argument on each `TupleStore` method, or attached via a `TupleStore` wrapper analogous to `withContextualTuples`? Both are viable; the wrapper pattern matches existing precedent.
- Should the response include a header indicating which consistency mode was used? Upstream does not. Default: do not add one.
- The exact upstream numeric defaults for cache TTL and limit env vars (`OPENFGA_CHECK_QUERY_CACHE_LIMIT`, `_TTL`, `OPENFGA_CHECK_ITERATOR_TTL`, `OPENFGA_CHECK_CACHE_LIMIT`) are not in the public docs page. They are not required for this feature but will be required for a future caching feature; capture from `openfga run --help` against a pinned upstream version at that time.
