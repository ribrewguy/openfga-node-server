/**
 * Integration test for the OIDC auth mode wired through the full
 * buildApp() route stack.
 *
 * Spins up an in-process Hono server publishing a fixture JWKS and a
 * minimal OIDC discovery document, sets OPENFGA_AUTH_* env vars to
 * point at the fixture, reloads config, and exercises a real
 * `/stores/*` request path through every middleware layer.
 *
 * The unit suite (tests/unit/oidc.test.ts) covers the full validation
 * matrix; this test exists to prove the wiring (auth dispatcher →
 * oidcMiddleware → route handlers) is intact end-to-end and that
 * `/health` remains auth-exempt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'
import { buildApp } from '../../src/routes/index'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'
import { reloadConfigForTests } from '../../src/config'
import type { Hono as HonoApp } from 'hono'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

interface IssuerFixture {
  issuer: string
  jwksUri: string
  audience: string
  privateKey: CryptoKey
  publicJwk: JWK
  kid: string
  shutdown(): Promise<void>
}

async function bootIssuer(): Promise<IssuerFixture> {
  const kp = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(kp.publicKey)
  const kid = `int-${Math.random().toString(36).slice(2, 8)}`
  jwk.kid = kid
  jwk.alg = 'RS256'
  jwk.use = 'sig'

  const app = new Hono()
  app.get('/.well-known/jwks.json', (c) => c.json({ keys: [jwk] }))
  app.get('/.well-known/openid-configuration', (c) =>
    c.json({ jwks_uri: `${fixture.issuer.replace(/\/$/, '')}/.well-known/jwks.json` }),
  )

  const fixture: IssuerFixture = {
    issuer: '',
    jwksUri: '',
    audience: 'openfga-integration',
    privateKey: kp.privateKey,
    publicJwk: jwk,
    kid,
    shutdown: async () => {},
  }

  return await new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      fixture.issuer = `http://127.0.0.1:${info.port}/`
      fixture.jwksUri = `http://127.0.0.1:${info.port}/.well-known/jwks.json`
      fixture.shutdown = () => new Promise<void>((res, rej) => {
        server.close((err) => err ? rej(err) : res())
      })
      resolve(fixture)
    })
  })
}

async function makeJwt(fixture: IssuerFixture, opts: { expiresInSec?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + (opts.expiresInSec ?? 600)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: fixture.kid })
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(exp)
    .setIssuer(fixture.issuer)
    .setAudience(fixture.audience)
    .setSubject('user:alice')
    .sign(fixture.privateKey)
}

describeIfDb('OIDC auth — buildApp() integration', () => {
  let issuer: IssuerFixture
  let app: HonoApp
  const previousAuthMode = process.env['OPENFGA_AUTH_MODE']
  const previousIssuer = process.env['OPENFGA_AUTH_OIDC_ISSUER']
  const previousAudience = process.env['OPENFGA_AUTH_OIDC_AUDIENCE']
  const previousJwksUri = process.env['OPENFGA_AUTH_OIDC_JWKS_URI']

  beforeAll(async () => {
    issuer = await bootIssuer()
    process.env['OPENFGA_AUTH_MODE'] = 'oidc'
    process.env['OPENFGA_AUTH_OIDC_ISSUER'] = issuer.issuer
    process.env['OPENFGA_AUTH_OIDC_AUDIENCE'] = issuer.audience
    process.env['OPENFGA_AUTH_OIDC_JWKS_URI'] = issuer.jwksUri
    await reloadConfigForTests()
    app = buildApp()
  })

  afterAll(async () => {
    const restore = (key: string, prev: string | undefined): void => {
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    }
    restore('OPENFGA_AUTH_MODE', previousAuthMode)
    restore('OPENFGA_AUTH_OIDC_ISSUER', previousIssuer)
    restore('OPENFGA_AUTH_OIDC_AUDIENCE', previousAudience)
    restore('OPENFGA_AUTH_OIDC_JWKS_URI', previousJwksUri)
    await reloadConfigForTests()
    await issuer.shutdown()
  })

  it('rejects /stores/* with no Authorization header', async () => {
    const res = await app.fetch(
      new Request('http://localhost/stores', { method: 'GET' }),
    )
    expect(res.status).toBe(401)
  })

  it('rejects /stores/* with an expired token', async () => {
    const token = await makeJwt(issuer, { expiresInSec: -3600 })
    const res = await app.fetch(
      new Request('http://localhost/stores', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  it('accepts /stores/* with a valid Bearer token', async () => {
    const token = await makeJwt(issuer)
    const res = await app.fetch(
      new Request('http://localhost/stores', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }),
    )
    // 200 with cursor-paginated body. We don't care about contents,
    // just that the OIDC layer passed the request through to the
    // route handler.
    expect(res.status).toBe(200)
  })

  it('leaves /health auth-exempt', async () => {
    const res = await app.fetch(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
  })

  it('leaves /ready auth-exempt', async () => {
    const res = await app.fetch(new Request('http://localhost/ready'))
    // 200 (DB migrated) or 503 (DB unmigrated) — both prove the auth
    // layer let the request through.
    expect([200, 503]).toContain(res.status)
  })
})
