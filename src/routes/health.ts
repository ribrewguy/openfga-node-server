/**
 * Liveness and readiness probes. Both are mounted outside the
 * `/stores/*` auth scope in buildApp() so they answer without
 * credentials — Kubernetes-style probes can hit them directly.
 *
 *   GET /health  liveness — always 200 when the process is up
 *   GET /ready   readiness — 200 only when the database is reachable
 *                AND the configured namespace has the core tables
 *                provisioned. 503 otherwise with a generic reason
 *                that never leaks DSN / schema / driver-error detail.
 */
import { Hono } from 'hono'
import { checkReadiness } from '../storage/readiness'

export const healthRoutes = new Hono()

healthRoutes.get('/health', (c) => c.json({ status: 'ok' }))

healthRoutes.get('/ready', async (c) => {
  const status = await checkReadiness()
  if (status.ok) return c.json({ status: 'ok' })
  return c.json({ status: 'unhealthy', reason: status.reason }, 503)
})
