import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { MAX_ARTIFACT_BYTES, readBoundedSha256Artifact } from './application-resume-artifact.js'

const OpaqueRecoverySourceRefSchema = z.string()
  .regex(/^job-hunt-agent:output:[A-Za-z0-9._-]{1,200}$/)
const MAX_RESUME_CONTENT_BYTES = 1024 * 1024

const RecoveryRpcResultSchema = z.object({
  recovery_id: z.string().uuid(),
  application_id: z.string().uuid(),
  resume_id: z.string().uuid(),
  recorded_at: z.string().datetime({ offset: true }),
  idempotent: z.boolean(),
}).strict()

export const RecoverApplicationEvidenceInputSchema = z.object({
  recovery_id: z.string().uuid(),
  application_id: z.string().uuid(),
  expected_company: z.string().min(1).max(500),
  expected_role: z.string().min(1).max(500),
  resume_id: z.string().uuid(),
  resume_content: z.record(z.unknown()).refine(value => Object.keys(value).length > 0),
  source_ref: OpaqueRecoverySourceRefSchema,
  docx_bytes: z.instanceof(Uint8Array).optional(),
  pdf_bytes: z.instanceof(Uint8Array).optional(),
}).strict().superRefine((input, context) => {
  if (!input.docx_bytes && !input.pdf_bytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one recovered artifact is required' })
  }
  for (const [format, bytes] of [['docx', input.docx_bytes], ['pdf', input.pdf_bytes]] as const) {
    if (bytes && (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [`${format}_bytes`], message: 'Artifact size is invalid' })
    }
  }
  if (Buffer.byteLength(JSON.stringify(input.resume_content), 'utf8') > MAX_RESUME_CONTENT_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resume_content'], message: 'Resume content is too large' })
  }
})

type RecoveryApplicationRow = { id: string; company: string; role: string; stage: string }
type RecoveryReadbackRow = {
  recovery_id: string
  application_id: string
  resume_id: string
  source_ref: string
  recorded_at: string
  original_generated_at: string | null
  resume_content: unknown
  docx_url: string | null
  docx_hash: string | null
  pdf_url: string | null
  pdf_hash: string | null
  is_submitted: boolean
}

export type ApplicationEvidenceRecoverySource = {
  readApplication: (applicationId: string) => PromiseLike<{ data: RecoveryApplicationRow | null; error: unknown | null }>
  upload: (path: string, bytes: Uint8Array, contentType: string) => PromiseLike<{ error: unknown | null }>
  download: (path: string) => PromiseLike<{ data: ReadableStream<Uint8Array> | null; error: unknown | null }>
  recover: (args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
  readback: (recoveryId: string) => PromiseLike<{ data: RecoveryReadbackRow | null; error: unknown | null }>
}

type RecoveryRefusalCode =
  | 'invalid_input'
  | 'application_not_found'
  | 'application_identity_mismatch'
  | 'artifact_unavailable'
  | 'artifact_hash_mismatch'
  | 'recovery_conflict'
  | 'recovery_unavailable'
  | 'invalid_source_payload'

function recoveryRefusal(code: RecoveryRefusalCode) {
  return { status: 'refused' as const, code }
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function artifactPath(applicationId: string, resumeId: string, format: 'docx' | 'pdf') {
  return `${applicationId}/${resumeId}/resume.${format}`
}

async function persistVerifiedArtifact(
  source: ApplicationEvidenceRecoverySource,
  path: string,
  bytes: Uint8Array,
  contentType: string,
  expectedHash: string,
) {
  // A duplicate-path upload is the normal crash/retry case. Whether upload
  // succeeds or refuses, only a bounded download of the exact deterministic
  // path with the expected hash permits the database write.
  try { await source.upload(path, bytes, contentType) } catch { /* verify below */ }
  let stream: ReadableStream<Uint8Array> | null
  try {
    const downloaded = await source.download(path)
    if (downloaded.error) return recoveryRefusal('artifact_unavailable')
    stream = downloaded.data
  } catch {
    return recoveryRefusal('artifact_unavailable')
  }
  if (!stream) return recoveryRefusal('artifact_unavailable')
  const verified = await readBoundedSha256Artifact(stream, expectedHash)
  if (verified.status === 'refused') {
    return recoveryRefusal(verified.code === 'artifact_hash_mismatch' ? 'artifact_hash_mismatch' : 'artifact_unavailable')
  }
  return { status: 'ok' as const }
}

export async function recoverApplicationEvidence(
  input: unknown,
  source: ApplicationEvidenceRecoverySource,
) {
  const parsed = RecoverApplicationEvidenceInputSchema.safeParse(input)
  if (!parsed.success) return recoveryRefusal('invalid_input')
  const request = parsed.data

  let application: RecoveryApplicationRow | null
  try {
    const result = await source.readApplication(request.application_id)
    if (result.error) return recoveryRefusal('recovery_unavailable')
    application = result.data
  } catch {
    return recoveryRefusal('recovery_unavailable')
  }
  if (!application) return recoveryRefusal('application_not_found')
  if (application.id !== request.application_id
    || application.company !== request.expected_company
    || application.role !== request.expected_role) {
    return recoveryRefusal('application_identity_mismatch')
  }

  const docxHash = request.docx_bytes ? sha256(request.docx_bytes) : null
  const pdfHash = request.pdf_bytes ? sha256(request.pdf_bytes) : null
  const docxPath = request.docx_bytes ? artifactPath(request.application_id, request.resume_id, 'docx') : null
  const pdfPath = request.pdf_bytes ? artifactPath(request.application_id, request.resume_id, 'pdf') : null
  const artifacts: Array<{ path: string; bytes: Uint8Array; contentType: string; hash: string }> = []
  if (request.docx_bytes) artifacts.push({
    path: docxPath!, bytes: request.docx_bytes,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', hash: docxHash!,
  })
  if (request.pdf_bytes) artifacts.push({
    path: pdfPath!, bytes: request.pdf_bytes, contentType: 'application/pdf', hash: pdfHash!,
  })
  for (const artifact of artifacts) {
    const stored = await persistVerifiedArtifact(source, artifact.path, artifact.bytes, artifact.contentType, artifact.hash)
    if (stored.status === 'refused') return stored
  }

  const rpcArgs = {
    p_recovery_id: request.recovery_id,
    p_application_id: request.application_id,
    p_expected_company: request.expected_company,
    p_expected_role: request.expected_role,
    p_resume_id: request.resume_id,
    p_resume_content: request.resume_content,
    p_docx_url: docxPath,
    p_docx_hash: docxHash,
    p_pdf_url: pdfPath,
    p_pdf_hash: pdfHash,
    p_source_ref: request.source_ref,
  }
  let rpcResult: unknown
  try {
    const result = await source.recover(rpcArgs)
    if (result.error?.code === '22023') return recoveryRefusal('recovery_conflict')
    if (result.error?.code === 'P0001') return recoveryRefusal('application_not_found')
    if (result.error) return recoveryRefusal('recovery_unavailable')
    rpcResult = result.data
  } catch {
    return recoveryRefusal('recovery_unavailable')
  }
  const rpc = RecoveryRpcResultSchema.safeParse(rpcResult)
  if (!rpc.success) return recoveryRefusal('invalid_source_payload')

  let readback: RecoveryReadbackRow | null
  try {
    const result = await source.readback(request.recovery_id)
    if (result.error) return recoveryRefusal('recovery_unavailable')
    readback = result.data
  } catch {
    return recoveryRefusal('recovery_unavailable')
  }
  if (!readback
    || readback.recovery_id !== request.recovery_id
    || readback.application_id !== request.application_id
    || readback.resume_id !== request.resume_id
    || readback.source_ref !== request.source_ref
    || readback.original_generated_at !== null
    || readback.is_submitted
    || readback.docx_url !== docxPath
    || readback.docx_hash !== docxHash
    || readback.pdf_url !== pdfPath
    || readback.pdf_hash !== pdfHash
    || !isDeepStrictEqual(readback.resume_content, request.resume_content)) {
    return recoveryRefusal('invalid_source_payload')
  }

  return {
    status: 'ok' as const,
    recovery: {
      recovery_id: rpc.data.recovery_id,
      application_id: rpc.data.application_id,
      resume_id: rpc.data.resume_id,
      recorded_at: rpc.data.recorded_at,
      original_generation_time_status: 'unknown' as const,
      source_ref: request.source_ref,
      docx_hash: docxHash,
      pdf_hash: pdfHash,
      is_submitted: false as const,
      idempotent: rpc.data.idempotent,
    },
  }
}

export { MAX_RESUME_CONTENT_BYTES, OpaqueRecoverySourceRefSchema, artifactPath }
