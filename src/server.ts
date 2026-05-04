/**
 * Self-hosted bootstrap for the OpenFGA-Node-Server.
 *
 * This file is the entrypoint for `pnpm dev` / `pnpm start` and any
 * bare-metal, container, or VM deployment. It binds TCP sockets via
 * `@hono/node-server`'s `serve()`, so it must NOT be imported by any
 * runtime that supplies its own request transport (e.g. Vercel
 * Functions). The Hono app itself lives in `./index.ts`, which is what
 * such platforms import.
 *
 * Reads `OPENFGA_DB_URL` (Postgres DSN, must point at the openfga
 * schema from migrations/) and starts up to two listeners:
 *
 *   - HTTP on `OPENFGA_HTTP_PORT` (default 8080), unless
 *     `OPENFGA_HTTP_ENABLED=false` disables it.
 *   - HTTPS on `OPENFGA_HTTPS_PORT` (default 8443), only when
 *     `OPENFGA_TLS_CERT_FILE` and `OPENFGA_TLS_KEY_FILE` are both
 *     set. Use mkcert via `pnpm cert:create` for local dev.
 *
 * Both listeners may run simultaneously. At least one listener must
 * be active — disabling HTTP without TLS certs is a fatal misconfig.
 *
 * When `OPENFGA_MIGRATE_ON_START=true`, the bootstrap awaits
 * `migrator.migrateToLatest()` against `OPENFGA_DB_URL` before any
 * `serve()` call. Default is `false`. The flag lives only in this
 * self-host path; serverless / multi-instance deployments should
 * leave it off and continue running `pnpm migrate` as a deploy step.
 *
 * `dotenv/config` is imported first so a local `.env` file is loaded
 * before any other module reads `process.env`. In production the file
 * is typically absent and platform-injected env vars take over — the
 * import is a silent no-op when `.env` doesn't exist.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { serve } from '@hono/node-server'
import app from './index'
import { logger } from './logger'
import { applyMigrationsOnStartIfEnabled, parseMigrateOnStart } from './storage/migrate-on-start'

if (!process.env['OPENFGA_DB_URL']) {
  logger.fatal({ env: 'OPENFGA_DB_URL' }, 'required env var not set; refusing to start')
  process.exit(1)
}

const rawHttpEnabled = (process.env['OPENFGA_HTTP_ENABLED'] ?? 'true').trim().toLowerCase()
if (rawHttpEnabled !== 'true' && rawHttpEnabled !== 'false') {
  logger.fatal(
    { raw: process.env['OPENFGA_HTTP_ENABLED'] },
    'OPENFGA_HTTP_ENABLED must be "true" or "false"',
  )
  process.exit(1)
}
const httpEnabled = rawHttpEnabled === 'true'

const httpPort = Number(process.env['OPENFGA_HTTP_PORT'] ?? 8080)
const httpsPort = Number(process.env['OPENFGA_HTTPS_PORT'] ?? 8443)

const certFile = process.env['OPENFGA_TLS_CERT_FILE']
const keyFile = process.env['OPENFGA_TLS_KEY_FILE']

if (Boolean(certFile) !== Boolean(keyFile)) {
  logger.fatal(
    'OPENFGA_TLS_CERT_FILE and OPENFGA_TLS_KEY_FILE must both be set together (or both unset for HTTP-only)',
  )
  process.exit(1)
}

const tlsEnabled = Boolean(certFile && keyFile)

if (!httpEnabled && !tlsEnabled) {
  logger.fatal(
    'OPENFGA_HTTP_ENABLED=false requires OPENFGA_TLS_CERT_FILE and OPENFGA_TLS_KEY_FILE to be set; otherwise the server has no listener',
  )
  process.exit(1)
}

if (httpEnabled && tlsEnabled && httpPort === httpsPort) {
  logger.fatal(
    { httpPort, httpsPort },
    'OPENFGA_HTTP_PORT and OPENFGA_HTTPS_PORT cannot be equal when both listeners are active',
  )
  process.exit(1)
}

// Validate OPENFGA_MIGRATE_ON_START up front so a malformed value is
// fatal at boot rather than at the moment migrations would run. The
// actual migrator invocation happens below, before any `serve()` call.
try {
  parseMigrateOnStart(process.env['OPENFGA_MIGRATE_ON_START'])
}
catch (err) {
  logger.fatal({ err }, 'invalid OPENFGA_MIGRATE_ON_START')
  process.exit(1)
}

// Run migrations against OPENFGA_DB_URL before binding sockets when
// the operator has explicitly opted in. Failure here is fatal — the
// server must not accept traffic against a half-migrated database.
// See src/storage/migrate-on-start.ts for why this lives in
// server.ts (NOT index.ts).
try {
  await applyMigrationsOnStartIfEnabled()
}
catch (err) {
  logger.fatal({ err }, 'migrate_on_start_failed; refusing to start')
  process.exit(1)
}

if (httpEnabled) {
  serve({ fetch: app.fetch, port: httpPort }, (info) => {
    logger.info({ protocol: 'http', port: info.port }, 'server_listening')
  })
}

if (certFile && keyFile) {
  serve(
    {
      fetch: app.fetch,
      port: httpsPort,
      createServer: createHttpsServer,
      serverOptions: {
        key: readFileSync(keyFile),
        cert: readFileSync(certFile),
      },
    },
    (info) => {
      logger.info({ protocol: 'https', port: info.port }, 'server_listening')
    },
  )
}
