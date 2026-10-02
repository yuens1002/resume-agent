import { createHash } from 'node:crypto'

// get_application_resume_artifact (the MCP tool that read these bytes back
// out) was retired once the resume-evidence purge removed everything it
// could have read (#308 follow-up). readBoundedSha256Artifact and
// MAX_ARTIFACT_BYTES stay — application-evidence-recovery.ts still verifies
// a freshly uploaded recovery artifact's bytes against its attested hash the
// same bounded way.
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

type ArtifactRefusalCode =
  | 'artifact_too_large'
  | 'artifact_unavailable'
  | 'artifact_hash_mismatch'

function refusal(code: ArtifactRefusalCode) {
  return { status: 'refused' as const, code }
}

export async function readBoundedSha256Artifact(
  stream: ReadableStream<Uint8Array>,
  expectedHash: string,
) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let sizeBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sizeBytes += value.byteLength
      if (sizeBytes > MAX_ARTIFACT_BYTES) {
        await reader.cancel('artifact size cap exceeded')
        return refusal('artifact_too_large')
      }
      chunks.push(value)
    }
  } catch {
    try { await reader.cancel('artifact stream failed') } catch { /* best-effort */ }
    return refusal('artifact_unavailable')
  } finally {
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== expectedHash) return refusal('artifact_hash_mismatch')
  return { status: 'ok' as const, bytes, size_bytes: sizeBytes, sha256 }
}

export { MAX_ARTIFACT_BYTES }
