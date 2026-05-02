/**
 * Zod schemas for the OpenFGA HTTP surface implemented by this server.
 *
 * The schemas define the wire contract for request bodies, route
 * parameters, and query parameters. They:
 *
 *   - use snake_case to match the OpenFGA wire format,
 *   - allow unknown fields via `.passthrough()` so OpenFGA SDK clients
 *     can send forward-compatible fields like `consistency`, `context`,
 *     `trace`, etc., that this server does not yet read,
 *   - validate enough shape to keep malformed input out of the storage
 *     and evaluator layers, but stop short of model-aware validation
 *     (that belongs to the write/check evaluator behavior).
 *
 * See docs/features/request-validation.md for the source-of-truth
 * scope and the rationale for each carve-out.
 */
import { z } from 'zod'

// ─── Shared primitives ────────────────────────────────────────────

/**
 * Object reference matching one of the OpenFGA wire forms:
 *   - `<type>:<id>` — full reference
 *   - `<type>:` — type-only filter (read endpoint)
 *   - `<type>:<id>#<relation>` — userset
 *   - `<type>:*` — typed wildcard
 *
 * The character class on the right of the colon is intentionally
 * permissive; storage and evaluator layers enforce stricter semantics.
 */
const OBJECT_REF = z.string().regex(/^[A-Za-z0-9_]+:[A-Za-z0-9_:#*-]*$/)

const TUPLE_KEY = z.object({
  user: z.string().min(1),
  relation: z.string().min(1),
  object: OBJECT_REF,
}).passthrough()

const TUPLE_KEY_FILTER = z.object({
  user: z.string().optional(),
  relation: z.string().optional(),
  object: OBJECT_REF.optional(),
}).passthrough()

const TUPLE_KEY_NO_CONDITION = z.object({
  user: z.string().min(1),
  relation: z.string().min(1),
  object: OBJECT_REF,
}).passthrough()

// ─── Query params ─────────────────────────────────────────────────

export const PageSizeQuery = z.object({
  page_size: z
    .string()
    .optional()
    .refine((v) => v === undefined || /^\d+$/.test(v), {
      message: 'page_size must be a non-negative integer',
    })
    .transform((v) => (v === undefined ? undefined : Number(v))),
}).passthrough()

export const ChangesQuery = z.object({
  type: z.string().min(1).optional(),
  page_size: z
    .string()
    .optional()
    .refine((v) => v === undefined || /^\d+$/.test(v), {
      message: 'page_size must be a non-negative integer',
    })
    .transform((v) => (v === undefined ? undefined : Number(v))),
  continuation_token: z.string().optional(),
  start_time: z
    .string()
    .optional()
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
      message: 'start_time must be an RFC 3339 / ISO 8601 timestamp',
    }),
}).passthrough()

export const ListStoresQuery = z.object({
  page_size: z
    .string()
    .optional()
    .refine((v) => v === undefined || /^\d+$/.test(v), {
      message: 'page_size must be a non-negative integer',
    })
    .transform((v) => (v === undefined ? undefined : Number(v))),
  continuation_token: z.string().optional(),
}).passthrough()

// ─── POST /stores ─────────────────────────────────────────────────

export const CreateStoreBody = z.object({
  name: z.string().trim().min(1),
}).passthrough()

// ─── POST /stores/:storeId/authorization-models ───────────────────

export const WriteAuthorizationModelBody = z.object({
  schema_version: z.string().optional(),
  type_definitions: z.array(z.unknown()),
  conditions: z.unknown().optional(),
}).passthrough()

// ─── POST /stores/:storeId/check ──────────────────────────────────

export const CheckBody = z.object({
  tuple_key: TUPLE_KEY,
  authorization_model_id: z.string().optional(),
  contextual_tuples: z
    .object({
      tuple_keys: z.array(TUPLE_KEY).optional(),
    })
    .passthrough()
    .optional(),
}).passthrough()

// ─── POST /stores/:storeId/write ──────────────────────────────────

export const WriteBody = z
  .object({
    authorization_model_id: z.string().optional(),
    writes: z
      .object({
        tuple_keys: z.array(TUPLE_KEY).min(1),
        on_duplicate: z.enum(['error', 'ignore']).optional(),
      })
      .passthrough()
      .optional(),
    deletes: z
      .object({
        tuple_keys: z.array(TUPLE_KEY_NO_CONDITION).min(1),
        on_missing: z.enum(['error', 'ignore']).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine((b) => b.writes !== undefined || b.deletes !== undefined, {
    message: 'writes or deletes is required',
  })

// ─── POST /stores/:storeId/read ───────────────────────────────────

export const ReadBody = z.object({
  tuple_key: TUPLE_KEY_FILTER.optional(),
  page_size: z.number().int().nonnegative().optional(),
  continuation_token: z.string().optional(),
}).passthrough()

// ─── PUT /stores/:storeId/assertions/:authorizationModelId ────────

const ASSERTION_TUPLE_KEY = z.object({
  user: z.string().min(1),
  relation: z.string().min(1),
  object: OBJECT_REF,
}).passthrough()

const ASSERTION = z.object({
  tuple_key: ASSERTION_TUPLE_KEY,
  expectation: z.boolean(),
  contextual_tuples: z.array(TUPLE_KEY).optional(),
  // OpenFGA's Assertion.context is typed as `object` (JSON-shaped
  // data for ABAC condition evaluation). Zod's `record(string, unknown)`
  // narrows to `Record<string, unknown>` which is assignable to that
  // type without losing wire-compat passthrough.
  context: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export const WriteAssertionsBody = z.object({
  assertions: z.array(ASSERTION),
}).passthrough()

// ─── POST /stores/:storeId/list-users ─────────────────────────────

const USER_TYPE_FILTER = z.object({
  type: z.string().min(1),
  relation: z.string().optional(),
}).passthrough()

export const ListUsersBody = z.object({
  authorization_model_id: z.string().optional(),
  object: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
  }).passthrough(),
  relation: z.string().min(1),
  // OpenFGA accepts exactly one user_filter — enforce that here so
  // the evaluator never sees an ambiguous request.
  user_filters: z.array(USER_TYPE_FILTER).length(1),
  // Note: ListUsersRequest's contextual_tuples is a flat TupleKey[]
  // (not wrapped in {tuple_keys: [...]}) — different from CheckRequest
  // and ListObjectsRequest. Mirror the wire shape exactly.
  contextual_tuples: z.array(TUPLE_KEY).optional(),
}).passthrough()

// ─── POST /stores/:storeId/expand ─────────────────────────────────

export const ExpandBody = z.object({
  tuple_key: z.object({
    relation: z.string().min(1),
    object: OBJECT_REF,
  }).passthrough(),
  authorization_model_id: z.string().optional(),
  contextual_tuples: z
    .object({
      tuple_keys: z.array(TUPLE_KEY).optional(),
    })
    .passthrough()
    .optional(),
}).passthrough()

// ─── POST /stores/:storeId/batch-check ────────────────────────────

const CORRELATION_ID = z.string().regex(/^[A-Za-z0-9-]{1,36}$/, {
  message: 'correlation_id must contain only letters, numbers, or hyphens and be ≤ 36 characters',
})

const BatchCheckItem = z.object({
  tuple_key: TUPLE_KEY,
  contextual_tuples: z
    .object({
      tuple_keys: z.array(TUPLE_KEY).optional(),
    })
    .passthrough()
    .optional(),
  context: z.unknown().optional(),
  correlation_id: CORRELATION_ID,
}).passthrough()

export const BATCH_CHECK_MAX_ITEMS = 50

export const BatchCheckBody = z
  .object({
    checks: z.array(BatchCheckItem).min(1).max(BATCH_CHECK_MAX_ITEMS),
    authorization_model_id: z.string().optional(),
  })
  .passthrough()
  .refine(
    (b) => {
      const seen = new Set<string>()
      for (const c of b.checks) {
        if (seen.has(c.correlation_id)) return false
        seen.add(c.correlation_id)
      }
      return true
    },
    { message: 'correlation_id values must be unique within a batch' },
  )

// ─── POST /stores/:storeId/list-objects ───────────────────────────

export const ListObjectsBody = z.object({
  type: z.string().min(1),
  relation: z.string().min(1),
  user: z.string().min(1),
  authorization_model_id: z.string().optional(),
  contextual_tuples: z
    .object({
      tuple_keys: z.array(TUPLE_KEY).optional(),
    })
    .passthrough()
    .optional(),
}).passthrough()
