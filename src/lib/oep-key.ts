import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

const VERSION = 'oep1'
const ALG = 'ed25519'

export interface OepPublicKeyEnvelope {
  alg: typeof ALG
  key: string
  fingerprint: string
  issued_at: string | null
  version: typeof VERSION
}

export function fingerprint(rawKey: Uint8Array): string {
  return base64url(createHash('sha256').update(rawKey).digest())
}

export function decodePublicKey(base64urlKey: string): Uint8Array {
  const padded = base64urlKey.replace(/-/g, '+').replace(/_/g, '/')
  const buf = Buffer.from(padded, 'base64')
  if (buf.length !== 32) {
    throw new Error(`OEP public key must be 32 bytes, got ${buf.length}`)
  }
  return new Uint8Array(buf)
}

export interface LoadedKey {
  rawKey: Uint8Array
  encodedKey: string
  fingerprint: string
  issuedAt: string | null
}

export function loadPublicKeyFromEnv(env: NodeJS.ProcessEnv = process.env): LoadedKey | null {
  const encodedKey = env.OEP_PUBLIC_KEY
  if (!encodedKey) return null
  const rawKey = decodePublicKey(encodedKey)
  return {
    rawKey,
    encodedKey,
    fingerprint: fingerprint(rawKey),
    issuedAt: env.OEP_KEY_ISSUED_AT ?? null,
  }
}

export function buildEnvelope(loaded: LoadedKey): OepPublicKeyEnvelope {
  return {
    alg: ALG,
    key: loaded.encodedKey,
    fingerprint: loaded.fingerprint,
    issued_at: loaded.issuedAt,
    version: VERSION,
  }
}

export function buildTxtRecord(fp: string): string {
  return `v=${VERSION}; alg=${ALG}; fp=${fp}`
}

export function parseTxtRecord(value: string): { version: string; alg: string; fp: string } | null {
  const pairs = value.split(';').map((p) => p.trim()).filter(Boolean)
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    if (idx === -1) return null
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  if (!out.v || !out.alg || !out.fp) return null
  return { version: out.v, alg: out.alg, fp: out.fp }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Signing ───────────────────────────────────────────────

/**
 * Produce deterministic canonical JSON: sorted keys, no whitespace, recursive.
 * Both signer and verifier must use this to produce identical byte strings.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj)
  }
  const keys = Object.keys(obj as object).sort()
  const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`)
  return `{${parts.join(',')}}`
}

// PKCS8 DER header for Ed25519 private key (seed): RFC 5958
const ED25519_PRIVATE_DER_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex')
// SPKI DER header for Ed25519 public key: RFC 5480
const ED25519_PUBLIC_DER_HEADER = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Load the OEP private key from `OEP_PRIVATE_KEY` env var.
 * Returns raw 32-byte seed, or null if not configured.
 * Call only from sync/CLI scripts — never on the public HTTP surface.
 */
export function loadPrivateKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Uint8Array | null {
  const encoded = env.OEP_PRIVATE_KEY
  if (!encoded) return null
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const buf = Buffer.from(padded, 'base64')
  if (buf.length !== 32) throw new Error(`OEP private key must be 32 bytes, got ${buf.length}`)
  return new Uint8Array(buf)
}

/**
 * Sign `data` (as canonical JSON) with the Ed25519 private key seed.
 * Returns base64url-encoded signature.
 */
export function signEvidence(data: object, privateKeyRaw: Uint8Array): string {
  const der = Buffer.concat([ED25519_PRIVATE_DER_HEADER, Buffer.from(privateKeyRaw)])
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  const payload = Buffer.from(canonicalJson(data), 'utf8')
  return base64url(sign(null, payload, key))
}

/**
 * Verify a signature produced by `signEvidence`.
 * Returns true if the signature is valid, false otherwise.
 */
export function verifyEvidenceSignature(data: object, sigBase64url: string, publicKeyRaw: Uint8Array): boolean {
  try {
    const der = Buffer.concat([ED25519_PUBLIC_DER_HEADER, Buffer.from(publicKeyRaw)])
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    const payload = Buffer.from(canonicalJson(data), 'utf8')
    const sig = Buffer.from(sigBase64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    return verify(null, payload, key, sig)
  } catch {
    return false
  }
}
