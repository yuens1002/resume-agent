/**
 * OEP Phase 3 CLI verifier — signed git evidence.
 *
 * Usage: npx tsx scripts/verify-git-evidence.ts <domain> <slug>
 * Example: npx tsx scripts/verify-git-evidence.ts yuens.me resume-agent
 *
 * Exit 0 on PASS, exit 1 on FAIL.
 *
 * What it verifies:
 * 1. Fetches the project's git_evidence from the live agent endpoint
 * 2. Fetches the OEP public key from /.well-known/oep-public-key.json
 * 3. Confirms the key fingerprint matches the _oep.<domain> DNS TXT record (Phase 1 chain)
 * 4. Verifies the Ed25519 signature over the canonical JSON of the evidence
 *
 * A PASS means: whoever controls <domain> signed this evidence, and it hasn't been tampered with.
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
    signature_valid: boolean
  }
}

async function verifyGitEvidence(domain: string, slug: string): Promise<VerifyEvidenceResult> {
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').trim()
  if (!cleanDomain) return { ok: false, reason: 'empty domain', domain, slug }

  const agentHost = `agent.${cleanDomain}`
  const baseUrl = `https://${agentHost}`

  // (1) Fetch project git_evidence
  let evidence: GitEvidence
  let signature: EvidenceSignature
  try {
    const res = await fetch(`${baseUrl}/projects/${slug}`)
    if (!res.ok) return { ok: false, reason: `project fetch failed: ${res.status}`, domain, slug, agentHost }
    const project = await res.json() as Record<string, unknown>
    const ev = project.git_evidence as GitEvidence | undefined
    if (!ev) return { ok: false, reason: 'no git_evidence on project — run sync first', domain, slug, agentHost }
    if (!ev.signature) return { ok: false, reason: 'git_evidence present but unsigned — configure OEP_PRIVATE_KEY and re-run sync', domain, slug, agentHost }
    evidence = ev
    signature = ev.signature
  } catch (e) {
    return { ok: false, reason: `project fetch error: ${(e as Error).message}`, domain, slug, agentHost }
  }

  // (2) Fetch OEP public key
  let rawKey: Uint8Array
  let keyFingerprint: string
  try {
    const res = await fetch(`${baseUrl}/.well-known/oep-public-key.json`)
    if (!res.ok) return { ok: false, reason: `OEP key fetch failed: ${res.status}`, domain, slug, agentHost }
    const envelope = await res.json() as { key?: string; fingerprint?: string }
    if (!envelope.key) return { ok: false, reason: 'OEP key envelope missing key field', domain, slug, agentHost }
    rawKey = decodePublicKey(envelope.key)
    keyFingerprint = computeFingerprint(rawKey)
  } catch (e) {
    return { ok: false, reason: `OEP key fetch error: ${(e as Error).message}`, domain, slug, agentHost }
  }

  // (3) DNS TXT fingerprint check (Phase 1 chain)
  let dnsFingerprint: string
  try {
    const records = await resolveTxt(`_oep.${cleanDomain}`)
    const flat = records.flat().join('')
    const parsed = parseTxtRecord(flat)
    if (!parsed) return { ok: false, reason: `_oep.${cleanDomain} TXT record missing or malformed`, domain, slug, agentHost }
    dnsFingerprint = parsed.fp
  } catch {
    return { ok: false, reason: `DNS lookup failed for _oep.${cleanDomain}`, domain, slug, agentHost }
  }

  if (dnsFingerprint !== keyFingerprint) {
    return {
      ok: false,
      reason: `DNS fingerprint (${dnsFingerprint.slice(0, 12)}…) does not match key fingerprint (${keyFingerprint.slice(0, 12)}…)`,
      domain, slug, agentHost,
      details: { dns_fingerprint: dnsFingerprint, key_fingerprint: keyFingerprint, signature_valid: false },
    }
  }

  // (4) Verify signature
  const { signature: _sig, ...payload } = evidence
  const valid = verifyEvidenceSignature(payload, signature.value, rawKey)

  if (!valid) {
    return {
      ok: false,
      reason: 'Ed25519 signature verification failed — evidence may have been tampered with',
      domain, slug, agentHost,
      details: { dns_fingerprint: dnsFingerprint, key_fingerprint: keyFingerprint, signature_valid: false },
    }
  }

  return {
    ok: true,
    reason: `git evidence for '${slug}' is signed by the OEP key for ${cleanDomain} and has not been tampered with`,
    domain, slug, agentHost,
    details: { dns_fingerprint: dnsFingerprint, key_fingerprint: keyFingerprint, signature_valid: true },
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
  console.log(`  DNS fingerprint:  ${result.details.dns_fingerprint}`)
  console.log(`  Key fingerprint:  ${result.details.key_fingerprint}`)
  console.log(`  Signature valid:  ${result.details.signature_valid}`)
}
process.exit(result.ok ? 0 : 1)
