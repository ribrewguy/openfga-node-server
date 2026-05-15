/**
 * Configuration schema for openfga-node-server.
 *
 * This module is pure: it declares the Zod schema, derives the
 * `Config` TypeScript type via `z.infer`, and exports a few small
 * primitives the env-overlay layer reuses. It performs no I/O, no
 * env reads, and no side effects at module evaluation time. Importing
 * it from any test or runtime context is safe.
 *
 * Side-effectful loading lives in `src/config.ts`. The env-var
 * translation (flat OPENFGA_* names to nested config paths) lives in
 * `src/config-env-overrides.ts`. Both modules import this one for
 * types and defaults; this module imports neither.
 */
import { z } from 'zod'

/**
 * Strict boolean parser used by configuration consumers that accept
 * `'true'` or `'false'` (case- and whitespace-tolerant) and reject
 * anything else. Mirrors the behavior of `parseMigrateOnStart` from
 * the pre-c12 era so deployments don't see a semantic shift.
 */
function strictBool(fieldName: string) {
  return z
    .union([z.boolean(), z.string()])
    .transform((v, ctx) => {
      if (typeof v === 'boolean') return v
      const t = v.trim().toLowerCase()
      if (t === 'true') return true
      if (t === 'false') return false
      ctx.addIssue({
        code: 'custom',
        message: `${fieldName} must be 'true' or 'false'; got "${v}"`,
      })
      return z.NEVER
    })
}

/**
 * Non-negative integer parser used by every pool/timeout field that
 * went through `intFromEnv` in the pre-c12 era. Accepts a number or
 * a numeric string; coerces via `Number`; rejects non-integers and
 * negatives with the same `must be a non-negative integer; got "X"`
 * message the previous helper threw.
 */
function nonNegativeInt(fieldName: string, defaultValue: number) {
  return z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      if (typeof v === 'number') {
        if (!Number.isInteger(v) || v < 0) {
          ctx.addIssue({
            code: 'custom',
            message: `${fieldName} must be a non-negative integer; got "${v}"`,
          })
          return z.NEVER
        }
        return v
      }
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${fieldName} must be a non-negative integer; got "${v}"`,
        })
        return z.NEVER
      }
      return n
    })
}

/**
 * Positive integer parser used by `idempotency.ttlMs`. Mirrors the
 * existing `readTtlFromEnv` behavior at `src/middleware/idempotency.ts`
 * which rejects 0 and negatives with `must be a positive integer`.
 */
function positiveInt(fieldName: string, defaultValue: number) {
  return z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isInteger(n) || n <= 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${fieldName} must be a positive integer; got "${v}"`,
        })
        return z.NEVER
      }
      return n
    })
}

export const LogLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const
export type LogLevel = (typeof LogLevels)[number]

export const AuthModes = ['none', 'preshared'] as const
export type AuthMode = (typeof AuthModes)[number]

export const IdempotencyModes = ['off', 'optional', 'required'] as const
export type IdempotencyMode = (typeof IdempotencyModes)[number]

const PoolSchema = z
  .object({
    max: nonNegativeInt('db.pool.max', 10),
    min: nonNegativeInt('db.pool.min', 0),
    idleTimeoutMs: nonNegativeInt('db.pool.idleTimeoutMs', 30_000),
    connectionTimeoutMs: nonNegativeInt('db.pool.connectionTimeoutMs', 0),
    statementTimeoutMs: nonNegativeInt('db.pool.statementTimeoutMs', 0),
    queryTimeoutMs: nonNegativeInt('db.pool.queryTimeoutMs', 0),
  })
  .prefault({} as never)

const DbSchema = z
  .object({
    // Optional at the schema level so CLI entry points that don't need
    // a database (load-model CLI) can load the typed `config` without
    // setting OPENFGA_DB_URL. Storage modules call `requireDbUrl()` at
    // pool-open time to preserve the original fail-fast at server boot.
    url: z.string().min(1).optional(),
    namespace: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/, {
        message: 'db.namespace must match /^[a-z][a-z0-9_]{0,62}$/',
      })
      .default('openfga'),
    applicationName: z.string().default('openfga-node-server'),
    pool: PoolSchema,
  })
  .prefault({} as never)

const ListenersSchema = z
  .object({
    http: z
      .object({
        enabled: strictBool('listeners.http.enabled').default(true),
        port: nonNegativeInt('listeners.http.port', 8080),
      })
      .prefault({} as never),
    https: z
      .object({
        port: nonNegativeInt('listeners.https.port', 8443),
      })
      .prefault({} as never),
  })
  .prefault({} as never)

const TlsSchema = z
  .object({
    certFile: z.string().min(1).optional(),
    keyFile: z.string().min(1).optional(),
  })
  .prefault({} as never)

const LogSchema = z
  .object({
    level: z.enum(LogLevels).default('info'),
  })
  .prefault({} as never)

const AuthSchema = z
  .object({
    mode: z.enum(AuthModes).default('none'),
    presharedKeys: z.array(z.string().min(1)).default([]),
  })
  .prefault({} as never)

const IdempotencySchema = z
  .object({
    mode: z.enum(IdempotencyModes).default('off'),
    ttlMs: positiveInt('idempotency.ttlMs', 86_400_000),
  })
  .prefault({} as never)

const LoadModelSchema = z
  .object({
    apiUrl: z.string().min(1).default('http://localhost:8080'),
    storeName: z.string().min(1).default('default'),
    storeId: z.string().min(1).optional(),
  })
  .prefault({} as never)

export const ConfigSchema = z
  .object({
    db: DbSchema,
    listeners: ListenersSchema,
    tls: TlsSchema,
    log: LogSchema,
    auth: AuthSchema,
    idempotency: IdempotencySchema,
    loadModel: LoadModelSchema,
    migrateOnStart: strictBool('migrateOnStart').default(false),
  })
  .superRefine((cfg, ctx) => {
    const httpEnabled = cfg.listeners.http.enabled
    const httpPort = cfg.listeners.http.port
    const httpsPort = cfg.listeners.https.port
    const certFile = cfg.tls.certFile
    const keyFile = cfg.tls.keyFile

    if ((certFile && !keyFile) || (!certFile && keyFile)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tls'],
        message:
          'tls.certFile and tls.keyFile must both be set together (or both unset for HTTP-only)',
      })
    }

    const httpsEnabled = Boolean(certFile && keyFile)

    if (!httpEnabled && !httpsEnabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['listeners'],
        message:
          'listeners.http.enabled=false requires tls.certFile and tls.keyFile to be set; otherwise the server has no listener',
      })
    }

    if (httpEnabled && httpsEnabled && httpPort === httpsPort) {
      ctx.addIssue({
        code: 'custom',
        path: ['listeners'],
        message:
          'listeners.http.port and listeners.https.port cannot be equal when both listeners are active',
      })
    }

    if (cfg.auth.mode === 'preshared' && cfg.auth.presharedKeys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'presharedKeys'],
        message:
          'auth.mode=preshared requires auth.presharedKeys to be set with at least one non-empty key',
      })
    }
  })

export type Config = z.infer<typeof ConfigSchema>
