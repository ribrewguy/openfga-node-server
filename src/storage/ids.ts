/**
 * Opaque ID generation for stores and authorization models.
 *
 * OpenFGA's reference server uses ULIDs (26-char Crockford base32,
 * monotonic with time). The SDK treats these as opaque strings, so any
 * unique URL-safe identifier works. We use ULIDs for visual parity with
 * the reference server — easier debugging when comparing payloads.
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

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN)
  let str = ''
  for (let i = 0; i < RANDOM_LEN; i++) {
    str += ENCODING[bytes[i]! % ENCODING_LEN]
  }
  return str
}

export function generateId(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}
