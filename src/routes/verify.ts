import { Hono } from 'hono'
import { fetchProfile, PROFILE_ERROR_HTTP } from '../lib/profile-cache.js'
import { loadPublicKeyFromEnv, verifyEvidenceSignature, fingerprint as computeFingerprint } from '../lib/oep-key.js'
import type { GitEvidence } from '../types.js'

const app = new Hono()

/**
 * GET /verify/git-evidence?slug=<slug>
 *
 * Public endpoint — verify the OEP Phase 3 signature on a project's git evidence.
 * Returns a structured result any AI or verifier can act on.
 */
app.get('/git-evidence', async (c) => {
  const slug = c.req.query('slug')
  if (!slug) return c.json({ error: 'Missing required query param: slug' }, 400)

  const result = await fetchProfile()

  if (result.kind !== 'ok') {
    const { status, body } = PROFILE_ERROR_HTTP[result.kind]
    return c.json(body, status)
  }

  const projects = (result.profile.projects ?? []) as Array<Record<string, unknown>>
  const project = projects.find(p => p.slug === slug)
  if (!project) return c.json({ error: `Project '${slug}' not found` }, 404)

  const evidence = project.git_evidence as GitEvidence | undefined
  if (!evidence) {
    return c.json({
      slug,
      evidence_signature: 'not_present',
      summary: `No git evidence on record for '${slug}' — runs on next nightly sync.`,
    })
  }

  const { signature, ...payload } = evidence
  if (!signature) {
    return c.json({
      slug,
      evidence_signature: 'unsigned',
      summary: `Git evidence present but not yet signed — configure OEP_PRIVATE_KEY and re-run sync.`,
    })
  }

  let loaded: ReturnType<typeof loadPublicKeyFromEnv>
  try {
    loaded = loadPublicKeyFromEnv()
  } catch {
    return c.json({ slug, evidence_signature: 'key_not_configured', summary: 'OEP public key misconfigured on this instance.' }, 503)
  }
  if (!loaded) {
    return c.json({ slug, evidence_signature: 'key_not_configured', summary: 'OEP public key not configured on this instance.' }, 503)
  }

  // Compute fingerprint from the actual key in use — never trust attacker-controlled metadata
  const actualFingerprint = computeFingerprint(loaded.rawKey)
  if (signature.fingerprint !== actualFingerprint) {
    return c.json({
      slug,
      evidence_signature: 'fail',
      signed_at: signature.signed_at,
      verified_at: new Date().toISOString(),
      summary: `FAIL — evidence fingerprint does not match this instance's OEP key. Evidence may have been signed by a different key.`,
    })
  }

  const valid = verifyEvidenceSignature(payload, signature.value, loaded.rawKey)
  const baseUrl = (process.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, '')

  return c.json({
    slug,
    domain: baseUrl.replace(/^https?:\/\/agent\./, '').replace(/^https?:\/\//, ''),
    oep_phase1: 'see /.well-known/oep-public-key.json',
    evidence_signature: valid ? 'pass' : 'fail',
    key_fingerprint: actualFingerprint,
    signed_at: signature.signed_at,
    verified_at: new Date().toISOString(),
    summary: valid
      ? `VERIFIED — git evidence for '${slug}' is signed by the OEP key at ${signature.key_url} and has not been tampered with.`
      : `FAIL — signature verification failed. The evidence may have been tampered with.`,
  })
})

export default app
