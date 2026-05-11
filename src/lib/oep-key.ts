import { createHash } from 'node:crypto'

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
