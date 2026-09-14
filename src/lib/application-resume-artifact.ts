import { createHash } from 'node:crypto'
import { z } from 'zod'

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

export const GetApplicationResumeArtifactInputSchema = z.object({
  application_id: z.string().uuid(),
  resume_id: z.string().uuid(),
  format: z.enum(['docx', 'pdf']),
}).strict()

type ResumeArtifactRow = {
  docx_url: string | null
  docx_hash: string | null
  pdf_url: string | null
  pdf_hash: string | null
}

export type ApplicationResumeArtifactSource = {
  readResume: (applicationId: string, resumeId: string) => PromiseLike<{
    data: ResumeArtifactRow | null
    error: unknown | null
  }>
  download: (path: string) => PromiseLike<{ data: ReadableStream<Uint8Array> | null; error: unknown | null }>
}

type ArtifactRefusalCode =
  | 'invalid_input'
  | 'artifact_not_found'
  | 'artifact_too_large'
  | 'artifact_unavailable'
  | 'artifact_hash_mismatch'

function refusal(code: ArtifactRefusalCode) {
  return { status: 'refused' as const, code }
}

export async function getApplicationResumeArtifact(input: unknown, source: ApplicationResumeArtifactSource) {
  const parsed = GetApplicationResumeArtifactInputSchema.safeParse(input)
  if (!parsed.success) return refusal('invalid_input')

  const { application_id, resume_id, format } = parsed.data
  let row: ResumeArtifactRow | null
  try {
    const result = await source.readResume(application_id, resume_id)
    if (result.error) return refusal('artifact_unavailable')
    row = result.data
  } catch {
    return refusal('artifact_unavailable')
  }
  if (!row) return refusal('artifact_not_found')

  const [path, expectedHash, mime_type] = format === 'docx'
    ? [row.docx_url, row.docx_hash, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const
    : [row.pdf_url, row.pdf_hash, 'application/pdf'] as const
  if (!path || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return refusal('artifact_not_found')

  let stream: ReadableStream<Uint8Array> | null
  try {
    const result = await source.download(path)
    if (result.error) return refusal('artifact_unavailable')
    stream = result.data
  } catch {
    return refusal('artifact_unavailable')
  }
  if (!stream) return refusal('artifact_unavailable')
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

  return {
    status: 'ok' as const,
    artifact: {
      application_id,
      resume_id,
      format,
      mime_type,
      size_bytes: sizeBytes,
      sha256,
      bytes_base64: bytes.toString('base64'),
    },
  }
}

export { MAX_ARTIFACT_BYTES }
