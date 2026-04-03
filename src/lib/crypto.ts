import crypto from 'crypto'

/**
 * Constant-time string comparison using SHA-256 digests.
 * Prevents timing attacks on secret comparisons (API keys, tokens).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aDigest = crypto.createHash('sha256').update(a).digest()
  const bDigest = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(aDigest, bDigest)
}
