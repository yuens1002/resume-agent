/**
 * Unit tests — OEP Phase 1 domain verification.
 *
 * Covers AC-1..AC-10 from docs/plans/oep-phase-1-domain-verification.md.
 *
 * Run: npm run test:unit
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import {
  buildEnvelope,
  buildTxtRecord,
  decodePublicKey,
  fingerprint,
  loadPublicKeyFromEnv,
  parseTxtRecord,
} from '../src/lib/oep-key.js'
import oepRoute from '../src/routes/oep.js'
import { verifyOepDomain } from '../scripts/verify-oep-domain.js'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const rawPrivate = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  return {
    encodedPublic: base64url(Buffer.from(rawPublic)),
    encodedPrivate: base64url(Buffer.from(rawPrivate)),
    rawPublic: new Uint8Array(rawPublic),
  }
}

describe('fingerprint()', () => {
  it('AC-5: deterministic — same input produces identical output', () => {
    const { rawPublic } = makeKeypair()
    assert.equal(fingerprint(rawPublic), fingerprint(rawPublic))
  })

  it('AC-2: matches base64url(sha256(raw key))', () => {
    const { encodedPublic, rawPublic } = makeKeypair()
    const decoded = decodePublicKey(encodedPublic)
    assert.equal(fingerprint(decoded), fingerprint(rawPublic))
  })

  it('rejects keys that are not 32 bytes', () => {
    assert.throws(() => decodePublicKey(base64url(Buffer.from('too-short'))))
  })
})

describe('parseTxtRecord() / buildTxtRecord()', () => {
  it('round-trips a fingerprint through the TXT format', () => {
    const fp = 'abc123def456'
    const txt = buildTxtRecord(fp)
    const parsed = parseTxtRecord(txt)
    assert.deepEqual(parsed, { version: 'oep1', alg: 'ed25519', fp })
  })

  it('returns null on malformed input', () => {
    assert.equal(parseTxtRecord('not-a-record'), null)
    assert.equal(parseTxtRecord('v=oep1; alg=ed25519'), null) // missing fp
  })
})

describe('loadPublicKeyFromEnv()', () => {
  it('returns null when OEP_PUBLIC_KEY is unset', () => {
    assert.equal(loadPublicKeyFromEnv({}), null)
  })

  it('returns a loaded key when env is populated', () => {
    const { encodedPublic } = makeKeypair()
    const loaded = loadPublicKeyFromEnv({ OEP_PUBLIC_KEY: encodedPublic, OEP_KEY_ISSUED_AT: '2026-05-11T00:00:00Z' })
    assert.ok(loaded)
    assert.equal(loaded.encodedKey, encodedPublic)
    assert.equal(loaded.issuedAt, '2026-05-11T00:00:00Z')
    assert.ok(loaded.fingerprint.length > 0)
  })
})

describe('GET /.well-known/oep-public-key.json (endpoint contract)', () => {
  const { encodedPublic } = makeKeypair()
  let baseUrl: string
  let server: ReturnType<typeof serve>
  const originalEnv = process.env.OEP_PUBLIC_KEY
  const originalIssued = process.env.OEP_KEY_ISSUED_AT

  before(async () => {
    process.env.OEP_PUBLIC_KEY = encodedPublic
    process.env.OEP_KEY_ISSUED_AT = '2026-05-11T00:00:00Z'
    const app = new Hono()
    app.route('/.well-known/oep-public-key.json', oepRoute)
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://localhost:${info.port}`
        resolve()
      })
    })
  })

  after(async () => {
    if (originalEnv === undefined) delete process.env.OEP_PUBLIC_KEY
    else process.env.OEP_PUBLIC_KEY = originalEnv
    if (originalIssued === undefined) delete process.env.OEP_KEY_ISSUED_AT
    else process.env.OEP_KEY_ISSUED_AT = originalIssued
    server.close()
  })

  it('AC-1: returns 200 + documented JSON shape', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oep-public-key.json`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    const body = await res.json() as Record<string, unknown>
    assert.equal(body.alg, 'ed25519')
    assert.equal(body.key, encodedPublic)
    assert.equal(typeof body.fingerprint, 'string')
    assert.equal(body.issued_at, '2026-05-11T00:00:00Z')
    assert.equal(body.version, 'oep1')
  })

  it('AC-2: fingerprint field equals base64url(sha256(raw key))', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oep-public-key.json`)
    const body = await res.json() as { fingerprint: string; key: string }
    const computed = fingerprint(decodePublicKey(body.key))
    assert.equal(body.fingerprint, computed)
  })

  it('AC-3: response carries Cache-Control: public, max-age=300', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oep-public-key.json`)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300')
  })
})

describe('GET /.well-known/oep-public-key.json (missing env)', () => {
  let baseUrl: string
  let server: ReturnType<typeof serve>
  const originalEnv = process.env.OEP_PUBLIC_KEY

  before(async () => {
    delete process.env.OEP_PUBLIC_KEY
    const app = new Hono()
    app.route('/.well-known/oep-public-key.json', oepRoute)
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://localhost:${info.port}`
        resolve()
      })
    })
  })

  after(async () => {
    if (originalEnv !== undefined) process.env.OEP_PUBLIC_KEY = originalEnv
    server.close()
  })

  it('AC-4: returns 503 with a JSON error when key is unset', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oep-public-key.json`)
    assert.equal(res.status, 503)
    const body = await res.json() as { error: string }
    assert.match(body.error, /not configured/i)
  })
})

describe('verifyOepDomain()', () => {
  const { encodedPublic, rawPublic } = makeKeypair()
  const fp = fingerprint(rawPublic)
  let baseUrl: string
  let server: ReturnType<typeof serve>
  const originalEnv = process.env.OEP_PUBLIC_KEY
  const originalIssued = process.env.OEP_KEY_ISSUED_AT

  before(async () => {
    process.env.OEP_PUBLIC_KEY = encodedPublic
    process.env.OEP_KEY_ISSUED_AT = '2026-05-11T00:00:00Z'
    const app = new Hono()
    app.route('/.well-known/oep-public-key.json', oepRoute)
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://localhost:${info.port}`
        resolve()
      })
    })
  })

  after(async () => {
    if (originalEnv === undefined) delete process.env.OEP_PUBLIC_KEY
    else process.env.OEP_PUBLIC_KEY = originalEnv
    if (originalIssued === undefined) delete process.env.OEP_KEY_ISSUED_AT
    else process.env.OEP_KEY_ISSUED_AT = originalIssued
    server.close()
  })

  // Stubs that rewrite the well-known fetch to point at our local server
  // and supply a synthetic DNS response.
  function makeStubs(dnsValue: string | null) {
    const stubFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/.well-known/oep-public-key.json')) {
        return fetch(`${baseUrl}/.well-known/oep-public-key.json`, init)
      }
      // The verifier may also probe the agent card; respond 404 so it falls through
      // to the `agent.<domain>` default — which we ignore by mapping the well-known
      // fetch above unconditionally.
      return new Response('not found', { status: 404 })
    }
    const stubResolveTxt = async (_host: string): Promise<string[][]> => {
      if (dnsValue === null) {
        const err = new Error('ENOTFOUND') as Error & { code?: string }
        err.code = 'ENOTFOUND'
        throw err
      }
      return [[dnsValue]]
    }
    return { stubFetch, stubResolveTxt }
  }

  it('AC-6: PASS when all three fingerprints agree', async () => {
    const { stubFetch, stubResolveTxt } = makeStubs(buildTxtRecord(fp))
    const result = await verifyOepDomain('example.com', { fetchImpl: stubFetch, resolveTxtImpl: stubResolveTxt })
    assert.equal(result.ok, true)
    assert.equal(result.fingerprints?.dns, fp)
    assert.equal(result.fingerprints?.endpoint, fp)
    assert.equal(result.fingerprints?.computed, fp)
  })

  it('AC-7a: FAIL on missing TXT', async () => {
    const { stubFetch, stubResolveTxt } = makeStubs(null)
    const result = await verifyOepDomain('example.com', { fetchImpl: stubFetch, resolveTxtImpl: stubResolveTxt })
    assert.equal(result.ok, false)
    assert.match(result.reason, /DNS lookup failed/i)
  })

  it('AC-7b: FAIL on malformed TXT value', async () => {
    const { stubFetch, stubResolveTxt } = makeStubs('v=oep1; alg=ed25519')
    const result = await verifyOepDomain('example.com', { fetchImpl: stubFetch, resolveTxtImpl: stubResolveTxt })
    assert.equal(result.ok, false)
    assert.match(result.reason, /no _oep.*TXT|malformed/i)
  })

  it('AC-7c: FAIL on fingerprint mismatch', async () => {
    const { stubFetch, stubResolveTxt } = makeStubs(buildTxtRecord('definitely-not-the-right-fingerprint'))
    const result = await verifyOepDomain('example.com', { fetchImpl: stubFetch, resolveTxtImpl: stubResolveTxt })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'fingerprint mismatch')
  })

  it('AC-7d: FAIL on well-known 404', async () => {
    const { stubResolveTxt } = makeStubs(buildTxtRecord(fp))
    const stubFetch: typeof fetch = async () => new Response('', { status: 404 })
    const result = await verifyOepDomain('example.com', { fetchImpl: stubFetch, resolveTxtImpl: stubResolveTxt })
    assert.equal(result.ok, false)
    assert.match(result.reason, /well-known fetch failed/i)
  })
})

describe('buildEnvelope()', () => {
  it('produces the documented JSON shape', () => {
    const { encodedPublic, rawPublic } = makeKeypair()
    const loaded = {
      rawKey: rawPublic,
      encodedKey: encodedPublic,
      fingerprint: fingerprint(rawPublic),
      issuedAt: '2026-05-11T00:00:00Z',
    }
    const env = buildEnvelope(loaded)
    assert.deepEqual(Object.keys(env).sort(), ['alg', 'fingerprint', 'issued_at', 'key', 'version'])
    assert.equal(env.alg, 'ed25519')
    assert.equal(env.version, 'oep1')
  })
})
