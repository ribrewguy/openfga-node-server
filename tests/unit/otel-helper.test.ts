/**
 * Runtime behavior of src/observability/otel.ts.
 *
 * Focused on the cheap-when-disabled contract: when config.otel
 * is disabled OR the boundary category is off, `traced()` must be a
 * pass-through with no SDK imports triggered and no span allocation.
 *
 * The SDK init path itself (initOtelSdk) is exercised by the
 * integration test against a real configured collector — covering
 * it here would require process-wide tracer-provider state that
 * doesn't reset cleanly between cases. Helper-level assertions
 * (spansEnabled, traced pass-through, exception propagation) live
 * here.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { reloadConfigForTests } from '../../src/config.js'
import { spansEnabled, traced } from '../../src/observability/otel.js'

const ENV_KEYS = [
  'OPENFGA_OTEL_ENABLED',
  'OPENFGA_OTEL_SPANS_HTTP',
  'OPENFGA_OTEL_SPANS_EVALUATOR',
  'OPENFGA_OTEL_SPANS_STORAGE',
  'OPENFGA_OTEL_SPANS_AUTH',
  'OPENFGA_OTEL_SPANS_IDEMPOTENCY',
] as const
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  await reloadConfigForTests()
})

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  await reloadConfigForTests()
})

describe('spansEnabled', () => {
  it('returns false when otel.enabled is false (default)', () => {
    expect(spansEnabled('http')).toBe(false)
    expect(spansEnabled('evaluator')).toBe(false)
    expect(spansEnabled('storage')).toBe(false)
    expect(spansEnabled('auth')).toBe(false)
    expect(spansEnabled('idempotency')).toBe(false)
  })

  it('returns the per-category value when otel.enabled is true', async () => {
    process.env['OPENFGA_OTEL_ENABLED'] = 'true'
    process.env['OPENFGA_OTEL_SPANS_EVALUATOR'] = 'false'
    await reloadConfigForTests()
    expect(spansEnabled('http')).toBe(true)
    expect(spansEnabled('evaluator')).toBe(false)
    expect(spansEnabled('storage')).toBe(true)
  })
})

describe('traced — disabled path', () => {
  it('is a pass-through when otel is disabled (returns the wrapped value)', async () => {
    const result = await traced('evaluator', 'never.emitted', { a: 1 }, () => 42)
    expect(result).toBe(42)
  })

  it('does not invoke the attribute builder when emission is off', async () => {
    let called = false
    const builder = (): Record<string, never> => {
      called = true
      return {}
    }
    await traced('storage', 'never.emitted', builder, () => 'x')
    expect(called).toBe(false)
  })

  it('propagates exceptions unchanged through the disabled path', async () => {
    const err = new Error('boom')
    await expect(
      traced('auth', 'never.emitted', {}, () => { throw err }),
    ).rejects.toBe(err)
  })

  it('is a pass-through for a category that is off while otel is enabled', async () => {
    process.env['OPENFGA_OTEL_ENABLED'] = 'true'
    process.env['OPENFGA_OTEL_SPANS_STORAGE'] = 'false'
    await reloadConfigForTests()
    let builderCalls = 0
    const result = await traced(
      'storage',
      'never.emitted',
      () => {
        builderCalls += 1
        return {}
      },
      () => 'done',
    )
    expect(result).toBe('done')
    expect(builderCalls).toBe(0)
  })
})
