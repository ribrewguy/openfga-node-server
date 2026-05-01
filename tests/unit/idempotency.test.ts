/**
 * Unit tests for the Idempotency-Key middleware.
 *
 * The storage layer (`src/storage/idempotency.ts`) is mocked so these
 * tests run without a database. Persistence and SQL semantics are
 * exercised by the integration test in
 * tests/integration/idempotency.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const claimKey = vi.fn()
const completeKey = vi.fn()
const releaseKey = vi.fn()

vi.mock('../../src/storage/idempotency.js', () => ({
  claimKey: (...args: unknown[]) => claimKey(...args),
  completeKey: (...args: unknown[]) => completeKey(...args),
  releaseKey: (...args: unknown[]) => releaseKey(...args),
}))

const { idempotencyMiddleware } = await import('../../src/middleware/idempotency.js')

interface AppOptions {
  mode: 'off' | 'optional' | 'required'
  ttlMs?: number
  handler?: (() => unknown) | (() => Promise<unknown>)
  status?: number
}

function buildApp({ mode, ttlMs = 60_000, handler, status = 200 }: AppOptions): Hono {
  const app = new Hono()
  app.use(
    '*',
    idempotencyMiddleware({
      mode,
      ttlMs,
      scopes: [
        { method: 'POST', path: '/stores' },
        { method: 'POST', path: '/stores/:storeId/write' },
      ],
    }),
  )
  app.post('/stores', async (c) => {
    const body = handler ? await handler() : { id: 'new-store', echoed: await c.req.json().catch(() => null) }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  app.post('/stores/:storeId/write', async (c) => {
    if (handler) await handler()
    return c.json({})
  })
  app.post('/stores/:storeId/check', async (c) => c.json({ allowed: true }))
  return app
}

function reqJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  claimKey.mockReset()
  completeKey.mockReset()
  releaseKey.mockReset()
})

describe('idempotency middleware — mode=off', () => {
  it('does not consult the store even when an Idempotency-Key is present', async () => {
    const app = buildApp({ mode: 'off' })
    const res = await app.fetch(reqJson('/stores', { name: 'test' }, { 'Idempotency-Key': 'k1' }))
    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
    expect(completeKey).not.toHaveBeenCalled()
  })
})

describe('idempotency middleware — mode=optional', () => {
  it('passes through when no Idempotency-Key is provided', async () => {
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', { name: 'test' }))
    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('does not apply to non-scoped routes even when an Idempotency-Key is provided', async () => {
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores/abc/check', {}, { 'Idempotency-Key': 'k1' }))
    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('claims, runs the handler, and persists the response on first request', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'claimed' })
    completeKey.mockResolvedValueOnce(undefined)

    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(200)
    expect(claimKey).toHaveBeenCalledTimes(1)
    expect(completeKey).toHaveBeenCalledTimes(1)
    const [key, status, body] = completeKey.mock.calls[0]!
    expect(key).toBe('abc')
    expect(status).toBe(200)
    expect(body).toEqual({ id: 'new-store', echoed: { name: 'first' } })
    expect(releaseKey).not.toHaveBeenCalled()
  })

  it('replays the cached response on a matching retry without invoking the handler', async () => {
    const handler = vi.fn().mockResolvedValue({ should: 'not-run' })
    claimKey.mockResolvedValueOnce({ kind: 'replay', status: 200, body: { id: 'cached', echoed: { name: 'first' } } })

    const app = buildApp({ mode: 'optional', handler })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'cached', echoed: { name: 'first' } })
    expect(handler).not.toHaveBeenCalled()
    expect(completeKey).not.toHaveBeenCalled()
  })

  it('returns 409 when the store reports an in-flight request with the same key', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'in_flight' })
    const handler = vi.fn()

    const app = buildApp({ mode: 'optional', handler })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'idempotency_in_flight' })
    expect(handler).not.toHaveBeenCalled()
    expect(completeKey).not.toHaveBeenCalled()
  })

  it('returns 422 when the same key is reused with a different fingerprint', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'mismatch' })
    const handler = vi.fn()

    const app = buildApp({ mode: 'optional', handler })
    const res = await app.fetch(reqJson('/stores', { name: 'different' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'idempotency_fingerprint_mismatch' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 503 when the idempotency store fails on claim', async () => {
    claimKey.mockRejectedValueOnce(new Error('connection refused'))
    const handler = vi.fn()

    const app = buildApp({ mode: 'optional', handler })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'idempotency_store_unavailable' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('releases the slot when the handler returns 5xx so retries can succeed', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'claimed' })
    releaseKey.mockResolvedValueOnce(undefined)

    const app = buildApp({ mode: 'optional', status: 500, handler: () => ({ code: 'internal' }) })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(500)
    expect(releaseKey).toHaveBeenCalledWith('abc')
    expect(completeKey).not.toHaveBeenCalled()
  })

  it('releases the slot and propagates when the handler throws', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'claimed' })
    releaseKey.mockResolvedValueOnce(undefined)

    const app = new Hono()
    app.use('*', idempotencyMiddleware({
      mode: 'optional',
      ttlMs: 60_000,
      scopes: [{ method: 'POST', path: '/stores' }],
    }))
    app.post('/stores', () => {
      throw new Error('boom')
    })
    app.onError((_err, c) => c.json({ code: 'internal_error' }, 500))

    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))
    expect(res.status).toBe(500)
    expect(releaseKey).toHaveBeenCalledWith('abc')
  })

  it('treats whitespace-only Idempotency-Key as missing and passes through', async () => {
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': '   ' }))
    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
  })
})

describe('idempotency middleware — mode=required', () => {
  it('returns 400 when Idempotency-Key is missing on a scoped endpoint', async () => {
    const app = buildApp({ mode: 'required' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_argument' })
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('returns 400 when Idempotency-Key is empty on a scoped endpoint', async () => {
    const app = buildApp({ mode: 'required' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': '' }))

    expect(res.status).toBe(400)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('does not require Idempotency-Key on non-scoped endpoints', async () => {
    const app = buildApp({ mode: 'required' })
    const res = await app.fetch(reqJson('/stores/abc/check', {}))

    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('processes the request when Idempotency-Key is present', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'claimed' })
    completeKey.mockResolvedValueOnce(undefined)

    const app = buildApp({ mode: 'required' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(200)
    expect(claimKey).toHaveBeenCalledTimes(1)
    expect(completeKey).toHaveBeenCalledTimes(1)
  })
})

describe('idempotency middleware — fingerprint stability', () => {
  it('different bodies on the same route produce different fingerprints', async () => {
    claimKey.mockResolvedValue({ kind: 'claimed' })
    completeKey.mockResolvedValue(undefined)

    const app = buildApp({ mode: 'optional' })
    await app.fetch(reqJson('/stores', { name: 'a' }, { 'Idempotency-Key': 'k1' }))
    await app.fetch(reqJson('/stores', { name: 'b' }, { 'Idempotency-Key': 'k2' }))

    const fpA = claimKey.mock.calls[0]![1]
    const fpB = claimKey.mock.calls[1]![1]
    expect(fpA).not.toBe(fpB)
  })

  it('same body on different routes produces different fingerprints', async () => {
    claimKey.mockResolvedValue({ kind: 'claimed' })
    completeKey.mockResolvedValue(undefined)

    const app = buildApp({ mode: 'optional' })
    await app.fetch(reqJson('/stores', { name: 'a' }, { 'Idempotency-Key': 'k1' }))
    await app.fetch(reqJson('/stores/abc/write', { name: 'a' }, { 'Idempotency-Key': 'k2' }))

    const fpA = claimKey.mock.calls[0]![1]
    const fpB = claimKey.mock.calls[1]![1]
    expect(fpA).not.toBe(fpB)
  })

  it('identical body and route produce identical fingerprints', async () => {
    claimKey.mockResolvedValue({ kind: 'claimed' })
    completeKey.mockResolvedValue(undefined)

    const app = buildApp({ mode: 'optional' })
    await app.fetch(reqJson('/stores', { name: 'same' }, { 'Idempotency-Key': 'k1' }))
    await app.fetch(reqJson('/stores', { name: 'same' }, { 'Idempotency-Key': 'k2' }))

    const fpA = claimKey.mock.calls[0]![1]
    const fpB = claimKey.mock.calls[1]![1]
    expect(fpA).toBe(fpB)
  })

  it('two different store ids on the same route share the same matched-path component', async () => {
    claimKey.mockResolvedValue({ kind: 'claimed' })
    completeKey.mockResolvedValue(undefined)

    const app = buildApp({ mode: 'optional' })
    await app.fetch(reqJson('/stores/a/write', { writes: [] }, { 'Idempotency-Key': 'k1' }))
    await app.fetch(reqJson('/stores/b/write', { writes: [] }, { 'Idempotency-Key': 'k2' }))

    // Same scope, same body → same fingerprint, even though storeId differs.
    const fpA = claimKey.mock.calls[0]![1]
    const fpB = claimKey.mock.calls[1]![1]
    expect(fpA).toBe(fpB)
  })
})
