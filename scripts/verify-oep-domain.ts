import { resolveTxt } from 'node:dns/promises'
import { decodePublicKey, fingerprint, parseTxtRecord } from '../src/lib/oep-key.js'

interface VerifyResult {
  ok: boolean
  reason: string
  domain: string
  agentHost?: string
  fingerprints?: { dns: string; endpoint: string; computed: string }
}

export async function verifyOepDomain(domain: string, opts: {
  fetchImpl?: typeof fetch
  resolveTxtImpl?: (host: string) => Promise<string[][]>
} = {}): Promise<VerifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const resolveTxtImpl = opts.resolveTxtImpl ?? resolveTxt
  const cleanDomain = domain
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .trim()
  if (!cleanDomain) {
    return { ok: false, reason: 'empty domain', domain }
  }

  // (1) DNS TXT lookup
  let dnsFingerprint: string
  try {
    const records = await resolveTxtImpl(`_oep.${cleanDomain}`)
    const candidates = records
      .map((parts) => parseTxtRecord(parts.join('')))
      .filter((p): p is { version: string; alg: string; fp: string } => p !== null && p.version === 'oep1')
    const parsed = candidates[0]
    if (!parsed) {
      return { ok: false, reason: `no _oep.${cleanDomain} TXT record with v=oep1`, domain: cleanDomain }
    }
    if (parsed.alg !== 'ed25519') {
      return { ok: false, reason: `unsupported alg in TXT: ${parsed.alg}`, domain: cleanDomain }
    }
    dnsFingerprint = parsed.fp
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed: ${(err as Error).message}`, domain: cleanDomain }
  }

  // (2) discover agent host (agent card url || agent.<domain>)
  let agentHost = `agent.${cleanDomain}`
  try {
    const card = await fetchImpl(`https://${cleanDomain}/.well-known/agent-card.json`)
    if (card.ok) {
      const data = (await card.json()) as { url?: string }
      if (typeof data.url === 'string' && data.url) {
        agentHost = new URL(data.url).host
      }
    }
  } catch {
    // ignore — fall back to agent.<domain>
  }

  // (3) fetch the public-key envelope
  let envelope: { alg?: string; key?: string; fingerprint?: string } | null = null
  try {
    const res = await fetchImpl(`https://${agentHost}/.well-known/oep-public-key.json`)
    if (!res.ok) {
      return { ok: false, reason: `well-known fetch failed: HTTP ${res.status}`, domain: cleanDomain, agentHost }
    }
    envelope = await res.json() as typeof envelope
  } catch (err) {
    return { ok: false, reason: `well-known fetch failed: ${(err as Error).message}`, domain: cleanDomain, agentHost }
  }
  if (!envelope || envelope.alg !== 'ed25519' || typeof envelope.key !== 'string' || typeof envelope.fingerprint !== 'string') {
    return { ok: false, reason: 'malformed well-known JSON', domain: cleanDomain, agentHost }
  }

  // (4) recompute fingerprint from raw key bytes
  let computed: string
  try {
    computed = fingerprint(decodePublicKey(envelope.key))
  } catch (err) {
    return { ok: false, reason: `key decode failed: ${(err as Error).message}`, domain: cleanDomain, agentHost }
  }

  // (5) three-way match
  if (dnsFingerprint !== envelope.fingerprint || envelope.fingerprint !== computed) {
    return {
      ok: false,
      reason: 'fingerprint mismatch',
      domain: cleanDomain,
      agentHost,
      fingerprints: { dns: dnsFingerprint, endpoint: envelope.fingerprint, computed },
    }
  }

  return {
    ok: true,
    reason: 'dns, endpoint, and recomputed fingerprints all match',
    domain: cleanDomain,
    agentHost,
    fingerprints: { dns: dnsFingerprint, endpoint: envelope.fingerprint, computed },
  }
}

async function main(): Promise<void> {
  const domain = process.argv[2]
  if (!domain) {
    process.stderr.write('usage: tsx scripts/verify-oep-domain.ts <domain>\n')
    process.exit(2)
  }
  const result = await verifyOepDomain(domain)
  const status = result.ok ? 'PASS' : 'FAIL'
  process.stdout.write(`OEP verification: ${status} — ${result.reason}\n`)
  if (result.fingerprints) {
    process.stdout.write(`  dns:      ${result.fingerprints.dns}\n`)
    process.stdout.write(`  endpoint: ${result.fingerprints.endpoint}\n`)
    process.stdout.write(`  computed: ${result.fingerprints.computed}\n`)
  }
  process.exit(result.ok ? 0 : 1)
}

const isMain = import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isMain) {
  void main()
}
