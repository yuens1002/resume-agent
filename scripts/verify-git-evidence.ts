/**
 * OEP Phase 3 CLI verifier — signed git evidence.
 *
 * Usage: npx tsx scripts/verify-git-evidence.ts <domain> <slug>
 * Example: npx tsx scripts/verify-git-evidence.ts yuens.me resume-agent
 *
 * Exit 0 on PASS, exit 1 on FAIL.
 *
 * Walks the full chain:
 * 1. DNS TXT record at _oep.<domain> — Phase 1 fingerprint
 * 2. Agent host discovery via agent card (mirrors verify-oep-domain.ts pattern)
 * 3. OEP public key envelope from /.well-known/oep-public-key.json
 * 4. Three-way fingerprint match: DNS == envelope == recomputed (Phase 1 chain)
 * 5. Signature fingerprint in evidence matches the verified key
 * 6. Ed25519 signature over canonical JSON of git_evidence (Phase 3)
 */

import { resolveTxt } from 'node:dns/promises'
import {
  decodePublicKey,
  fingerprint as computeFingerprint,
  parseTxtRecord,
  verifyEvidenceSignature,
} from '../src/lib/oep-key.js'
import type { GitEvidence, EvidenceSignature } from '../src/types.js'

interface VerifyEvidenceResult {
  ok: boolean
  reason: string
  domain: string
  slug: string
  agentHost?: string
  details?: {
    dns_fingerprint: string
    key_fingerprint: string
    signature_fingerprint: string
    signature_valid: boolean
  }
}

async function verifyGitEvidence(domain: string, slug: string): Promise<VerifyEvidenceResult> {
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').trim()
  if (!cleanDomain) return { ok: false, reason: 'empty domain', domain, slug }

  // (1) DNS TXT lookup — candidate-selection, same pattern as verify-oep-domain.ts
  let dnsFingerprint: string
  try {
    const records = await resolveTxt(`_oep.${cleanDomain}`)
    const candidates = records
      .map(parts => parseTxtRecord(parts.join('')))
      .filter((p): p is { version: string; alg: string; fp: string } => p !== null && p.version === 'oep1')
    const parsed = candidates[0]
    if (!parsed) return { ok: false, reason: `no _oep.${cleanDomain} TXT record with v=oep1`, domain: cleanDomain, slug }
    if (parsed.alg !== 'ed25519') return { ok: false, reason: `unsupported alg in TXT: ${parsed.alg}`, domain: cleanDomain, slug }
    dnsFingerprint = parsed.fp
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed: ${(err as Error).message}`, domain: cleanDomain, slug }
  }

  // (2) Agent host discovery via agent card (falls back to agent.<domain>)
  let agentHost = `agent.${cleanDomain}`
  try {
    const card = await fetch(`https://${cleanDomain}/.well-known/agent-card.json`)
    if (card.ok) {
      const data = await card.json() as { url?: string }
      if (typeof data.url === 'string' && data.url) {
        agentHost = new URL(data.url).host
      }
    }
  } catch { /* ignore — fall back to agent.<domain> */ }

  const baseUrl = `https://${agentHost}`

  // (3) Fetch OEP public key envelope
  let rawKey: Uint8Array
  let keyFingerprint: string
  try {
    const res = await fetch(`${baseUrl}/.well-known/oep-public-key.json`)
    if (!res.ok) return { ok: false, reason: `OEP key fetch failed: HTTP ${res.status}`, domain: cleanDomain, slug, agentHost }
    const envelope = await res.json() as { alg?: string; key?: string; fingerprint?: string }
    if (!envelope || envelope.alg !== 'ed25519' || typeof envelope.key !== 'string' || typeof envelope.fingerprint !== 'string') {
      return { ok: false, reason: 'malformed OEP key envelope', domain: cleanDomain, slug, agentHost }
    }
    rawKey = decodePublicKey(envelope.key)

    // (4) Three-way fingerprint match: DNS == envelope == recomputed
    const recomputed = computeFingerprint(rawKey)
    if (envelope.fingerprint !== recomputed || dnsFingerprint !== recomputed) {
      return {
        ok: false,
        reason: `fingerprint mismatch — DNS: ${dnsFingerprint.slice(0, 12)}…, envelope: ${envelope.fingerprint.slice(0, 12)}…, computed: ${recomputed.slice(0, 12)}…`,
        domain: cleanDomain, slug, agentHost,
      }
    }
    keyFingerprint = recomputed
  } catch (e) {
    return { ok: false, reason: `OEP key error: ${(e as Error).message}`, domain: cleanDomain, slug, agentHost }
  }

  // (5) Fetch project git_evidence
  let evidence: GitEvidence
  let signature: EvidenceSignature
  try {
    const res = await fetch(`${baseUrl}/projects/${slug}`)
    if (!res.ok) return { ok: false, reason: `project fetch failed: ${res.status}`, domain: cleanDomain, slug, agentHost }
    const project = await res.json() as Record<string, unknown>
    const ev = project.git_evidence as GitEvidence | undefined
    if (!ev) return { ok: false, reason: 'no git_evidence on project — run sync first', domain: cleanDomain, slug, agentHost }
    if (!ev.signature) return { ok: false, reason: 'git_evidence present but unsigned — configure OEP_PRIVATE_KEY and re-run sync', domain: cleanDomain, slug, agentHost }
    evidence = ev
    signature = ev.signature
  } catch (e) {
    return { ok: false, reason: `project fetch error: ${(e as Error).message}`, domain: cleanDomain, slug, agentHost }
  }

  // (6) Validate evidence signature fingerprint matches the verified key
  if (signature.fingerprint !== keyFingerprint) {
    return {
      ok: false,
      reason: `evidence signature fingerprint (${signature.fingerprint.slice(0, 12)}…) does not match OEP key (${keyFingerprint.slice(0, 12)}…) — evidence may have been signed by a different key`,
      domain: cleanDomain, slug, agentHost,
      details: { dns_fingerprint: dnsFingerprint, key_fingerprint: keyFingerprint, signature_fingerprint: signature.fingerprint, signature_valid: false },
    }
  }

  // (7) Verify Ed25519 signature over canonical JSON
  const { signature: _sig, ...payload } = evidence
  const valid = verifyEvidenceSignature(payload, signature.value, rawKey)

  return {
    ok: valid,
    reason: valid
      ? `git evidence for '${slug}' is signed by the OEP key for ${cleanDomain} and has not been tampered with`
      : 'Ed25519 signature verification failed — evidence may have been tampered with',
    domain: cleanDomain, slug, agentHost,
    details: { dns_fingerprint: dnsFingerprint, key_fingerprint: keyFingerprint, signature_fingerprint: signature.fingerprint, signature_valid: valid },
  }
}

// ── CLI entry point ───────────────────────────────────────

const [,, domain, slug] = process.argv
if (!domain || !slug) {
  console.error('Usage: npx tsx scripts/verify-git-evidence.ts <domain> <slug>')
  console.error('Example: npx tsx scripts/verify-git-evidence.ts yuens.me resume-agent')
  process.exit(1)
}

const result = await verifyGitEvidence(domain, slug)
const status = result.ok ? 'PASS' : 'FAIL'
console.log(`OEP git evidence: ${status} — ${result.reason}`)
if (result.details) {
  console.log(`  DNS fingerprint:       ${result.details.dns_fingerprint}`)
  console.log(`  Key fingerprint:       ${result.details.key_fingerprint}`)
  console.log(`  Signature fingerprint: ${result.details.signature_fingerprint}`)
  console.log(`  Signature valid:       ${result.details.signature_valid}`)
}
process.exit(result.ok ? 0 : 1)
