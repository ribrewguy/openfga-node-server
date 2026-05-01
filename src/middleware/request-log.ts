/**
 * Request-logging middleware.
 *
 * Logs `request_start` BEFORE the handler runs and `request_complete`
 * AFTER (in `finally`, so hangs and exceptions are still captured).
 * Logging on entry is what makes this useful for diagnosing hangs —
 * a completion-only log gives you nothing if the handler never
 * returns.
 */
import type { MiddlewareHandler } from 'hono'
import { logger } from '../logger.js'

export const requestLog: MiddlewareHandler = async (c, next) => {
  const start = performance.now()
  const { method } = c.req
  const path = c.req.path

  logger.info({ method, path }, 'request_start')

  try {
    await next()
  }
  finally {
    const duration_ms = Math.round((performance.now() - start) * 100) / 100
    const status = c.res.status
    logger.info({ method, path, status, duration_ms }, 'request_complete')
  }
}
