import { Hono } from 'hono'
import { fetchProfile, PROFILE_ERROR_HTTP } from '../lib/profile-cache.js'
import { loadPublicKeyFromEnv } from '../lib/oep-key.js'
import type { VerificationStatus } from '../types.js'

const app = new Hono()

function computeVerificationStatus(profile: Record<string, unknown>): VerificationStatus {
  const projects = (profile.projects as Array<Record<string, unknown>>) ?? []
  const employment = (profile.employment as Array<Record<string, unknown>>) ?? []

  const projectsWithEvidence = projects.filter(p => p.git_evidence).length
  const gitStatus: VerificationStatus['git_evidence'] =
    projectsWithEvidence === 0 ? 'none' : 'partial'

  const hasAttestations = employment.some(
    e => Array.isArray(e.attestations) && (e.attestations as unknown[]).length > 0,
  )
  const attestationStatus: VerificationStatus['peer_attestations'] =
    hasAttestations ? 'attested' : 'pending'

  let oepVerified = false
  try { oepVerified = !!loadPublicKeyFromEnv() } catch { /* malformed env */ }

  return {
    domain: oepVerified ? 'verified' : 'unverified' as VerificationStatus['domain'],
    git_evidence: gitStatus,
    peer_attestations: attestationStatus,
    employer_cosignature: 'pending_ecosystem',
    note: [
      oepVerified
        ? 'Domain ownership verified via OEP Phase 1 (Ed25519 + DNS TXT fingerprint).'
        : 'Domain verification not configured.',
      projectsWithEvidence > 0
        ? `Git evidence available for ${projectsWithEvidence} of ${projects.length} project(s).`
        : 'Git evidence not yet available — runs on next nightly sync.',
      hasAttestations
        ? 'Peer attestations present on employment entries.'
        : 'Employment verification via employer co-signature is pending ecosystem adoption. Peer attestations via public LinkedIn posts are the current best available signal — the candidate welcomes LinkedIn recommendations from former colleagues.',
    ].join(' '),
  }
}

app.get('/', async (c) => {
  const result = await fetchProfile()

  if (result.kind !== 'ok') {
    const { status, body } = PROFILE_ERROR_HTTP[result.kind]
    return c.json(body, status)
  }

  return c.json({
    ...result.profile,
    verification_status: computeVerificationStatus(result.profile as Record<string, unknown>),
  })
})

export default app
