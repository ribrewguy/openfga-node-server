/**
 * Opaque ID generation for stores and authorization models.
 *
 * OpenFGA's reference server uses ULIDs (26-char Crockford base32,
 * monotonic with time). The SDK treats these as opaque strings, so any
 * unique URL-safe identifier works. We use ULIDs for visual parity with
 * the reference server — easier debugging when comparing payloads.
 *
 * Monotonic-within-millisecond: when called more than once in the same
 * millisecond (or with a `now` argument that hasn't advanced), the
 * random suffix is incremented from the previous call rather than
 * regenerated fresh. This guarantees `generateId()` returns strictly
 * lexicographically increasing strings within a process, so queries
 * that sort by `id ASC/DESC` as a same-millisecond tiebreaker (e.g.
 * `listStoresPage`'s `ORDER BY created_at DESC, id DESC`) produce
 * insertion-order results on dialects whose `now()` is millisecond-
 * resolution like SQLite (openfga-sp5). Postgres microsecond `now()`
 * effectively never collides at the resolution floor in practice, so
 * the monotonic increment is a no-op there but harmless.
 */
import { randomBytes } from 'node:crypto'

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32 (no I/L/O/U)
const ENCODING_LEN = ENCODING.length
const TIME_LEN = 10
const RANDOM_LEN = 16

function encodeTime(now: number): string {
  let mod: number
  let str = ''
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    mod = now % ENCODING_LEN
    str = ENCODING[mod] + str
    now = (now - mod) / ENCODING_LEN
  }
  return str
}

let lastTime = 0
const lastRandom = new Uint8Array(RANDOM_LEN)
let initialized = false

function fillRandom(): void {
  const bytes = randomBytes(RANDOM_LEN)
  for (let i = 0; i < RANDOM_LEN; i++) {
    lastRandom[i] = bytes[i]! % ENCODING_LEN
  }
}

export function generateId(now: number = Date.now()): string {
  if (!initialized || now > lastTime) {
    lastTime = now
    fillRandom()
    initialized = true
  }
  else {
    // Same or earlier ms (incl. clock skew backward): increment the
    // suffix from least-significant index with carry. If the increment
    // overflows all 16 positions (astronomically unlikely — 32^16 ≈
    // 1.2 × 10^24 ids in one ms), advance lastTime by 1 and refresh.
    let carry = true
    for (let i = RANDOM_LEN - 1; i >= 0 && carry; i--) {
      if (lastRandom[i]! < ENCODING_LEN - 1) {
        lastRandom[i] = lastRandom[i]! + 1
        carry = false
      }
      else {
        lastRandom[i] = 0
      }
    }
    if (carry) {
      lastTime += 1
      fillRandom()
    }
  }

  let randomStr = ''
  for (let i = 0; i < RANDOM_LEN; i++) {
    randomStr += ENCODING[lastRandom[i]!]
  }
  return encodeTime(lastTime) + randomStr
}
