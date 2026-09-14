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
  download: (path: string) => PromiseLike<{ data: Blob | null; error: unknown | null }>
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

  let blob: Blob | null
  try {
    const result = await source.download(path)
    if (result.error) return refusal('artifact_unavailable')
    blob = result.data
  } catch {
    return refusal('artifact_unavailable')
  }
  if (!blob) return refusal('artifact_unavailable')
  if (blob.size > MAX_ARTIFACT_BYTES) return refusal('artifact_too_large')

  const bytes = Buffer.from(await blob.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== expectedHash) return refusal('artifact_hash_mismatch')

  return {
    status: 'ok' as const,
    artifact: {
      application_id,
      resume_id,
      format,
      mime_type,
      size_bytes: bytes.byteLength,
      sha256,
      bytes_base64: bytes.toString('base64'),
    },
  }
}

export { MAX_ARTIFACT_BYTES }
