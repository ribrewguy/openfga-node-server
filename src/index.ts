/**
 * Entry point for the OpenFGA-Node-Server.
 *
 * Reads `OPENFGA_DB_URL` (Postgres DSN, must point at the openfga
 * schema from migrations/) and starts a server on `PORT` (default
 * 8080).
 *
 * Set `OPENFGA_TLS_CERT_FILE` + `OPENFGA_TLS_KEY_FILE` to serve over
 * HTTPS (typically backed by mkcert for local dev — see
 * `pnpm cert:create`). Both must be set together; otherwise the
 * server runs on plain HTTP.
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
import { buildApp } from './routes/index'
import { logger } from './logger'

const port = Number(process.env['PORT'] ?? 8080)

if (!process.env['OPENFGA_DB_URL']) {
  logger.fatal({ env: 'OPENFGA_DB_URL' }, 'required env var not set; refusing to start')
  process.exit(1)
}

const certFile = process.env['OPENFGA_TLS_CERT_FILE']
const keyFile = process.env['OPENFGA_TLS_KEY_FILE']

if (Boolean(certFile) !== Boolean(keyFile)) {
  logger.fatal('OPENFGA_TLS_CERT_FILE and OPENFGA_TLS_KEY_FILE must both be set together (or both unset for HTTP)')
  process.exit(1)
}

const app = buildApp()

if (certFile && keyFile) {
  serve({
    fetch: app.fetch,
    port,
    createServer: createHttpsServer,
    serverOptions: {
      key: readFileSync(keyFile),
      cert: readFileSync(certFile),
    },
  }, (info) => {
    logger.info({ protocol: 'https', port: info.port }, 'server_listening')
  })
}
else {
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ protocol: 'http', port: info.port }, 'server_listening')
  })
}
