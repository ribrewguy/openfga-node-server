/**
 * Entry point for the OpenFGA-Node-Server.
 *
 * Reads `OPENFGA_DB_URL` (Postgres DSN, must point at the openfga
 * schema from migrations/001) and starts an HTTP server on `PORT`
 * (default 8080).
 */
import { serve } from '@hono/node-server'
import { buildApp } from './routes/index.js'

const port = Number(process.env['PORT'] ?? 8080)

if (!process.env['OPENFGA_DB_URL']) {
  console.error('[openfga] OPENFGA_DB_URL is not set. Refusing to start.')
  process.exit(1)
}

const app = buildApp()
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[openfga] listening on http://0.0.0.0:${info.port}`)
})
