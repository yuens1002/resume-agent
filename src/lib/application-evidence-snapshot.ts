import { z } from 'zod'

export const APPLICATION_STAGES = [
  'draft', 'applied', 'phone_screen', 'technical', 'final', 'offer', 'rejected', 'withdrawn',
] as const
export const ApplicationStageSchema = z.enum(APPLICATION_STAGES)

const TimestampSchema = z.string().datetime({ offset: true })
const JsonValueSchema = z.unknown()

const SnapshotMetadataSchema = z.object({
  snapshot_id: z.string().uuid(),
  as_of: TimestampSchema,
  total_applications: z.number().int().nonnegative(),
  snapshot_materialized: z.literal(true),
}).strict()

const SnapshotCursorSchema = z.object({ ordinal: z.number().int().positive() }).strict()

const JobDescriptionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('versioned'),
    versions: z.array(z.object({
      job_description_version_id: z.string().uuid(),
      content: z.string(),
      content_hash: z.string().regex(/^[a-f0-9]{64}$/),
      source_url: z.string().nullable(),
      captured_at: TimestampSchema,
    }).strict()).min(1),
  }).strict(),
  z.object({
    status: z.literal('legacy_unversioned'),
    versions: z.array(z.never()).max(0),
    unversioned_content: z.string(),
    source_url: z.string().nullable(),
  }).strict(),
  z.object({ status: z.literal('absent'), versions: z.array(z.never()).max(0) }).strict(),
])

const ApplicationEvidenceSchema = z.object({
  application: z.object({
    application_id: z.string().uuid(),
    company: z.string(),
    role: z.string(),
    stage: ApplicationStageSchema,
    applied_at: TimestampSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    source: z.string().nullable(),
    url: z.string().nullable(),
    follow_up_date: z.string().date().nullable(),
  }).strict(),
  job_description: JobDescriptionSchema,
  resume_versions: z.array(z.object({
    resume_id: z.string().uuid(),
    resume_content: JsonValueSchema,
    docx_url: z.string().nullable(),
    docx_hash: z.string().nullable(),
    pdf_url: z.string().nullable(),
    pdf_hash: z.string().nullable(),
    is_submitted: z.boolean(),
    generated_at: TimestampSchema,
  }).strict()),
  score_versions: z.array(z.object({
    score_id: z.string().uuid(),
    resume_id: z.string().uuid().nullable(),
    job_description_version_id: z.string().uuid().nullable(),
    score_type: z.enum(['jd_fit', 'resume_quality']),
    score: z.number().nullable(),
    rationale: z.string().nullable(),
    requirement_evidence: JsonValueSchema.nullable(),
    model: z.string().nullable(),
    rubric_version: z.string().nullable(),
    rubric_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    profile_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    scored_at: TimestampSchema,
  }).strict()),
  // A recorded confirmation is an internal attestation event. It never
  // represents an inferred send time or proof of external-ATS acceptance.
  submission_confirmation: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('recorded'),
      confirmations: z.array(z.object({
        submission_confirmation_id: z.string().uuid(),
        resume_id: z.string().uuid(),
        submitted_job_description_version_id: z.string().uuid().nullable(),
        submitted_artifact_format: z.enum(['docx', 'pdf']).nullable(),
        submitted_artifact_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
        actual_submission_occurred_at: TimestampSchema.nullable(),
        confirmation_recorded_at: TimestampSchema,
        confirmation_source: z.enum(['client_attested', 'unknown']),
        source_ref: z.string().nullable(),
      }).strict()).min(1),
    }).strict(),
    z.object({ status: z.literal('unverified'), confirmations: z.array(z.never()).max(0) }).strict(),
  ]),
  observed_outcomes: z.array(z.object({
    event_id: z.string().uuid(), source_identity: z.literal('granted_inbox'), source_event_id: z.string(),
    revision: z.number().int().positive(),
    event_type: z.enum(['recruiter_contact', 'screen_scheduled', 'screen_held', 'interview_scheduled', 'interview_held', 'cancellation', 'rejection', 'withdrawal', 'offer', 'offer_accepted', 'job_started', 'other_response']),
    occurred_at: TimestampSchema.nullable(), recorded_at: TimestampSchema, source_ref: z.string().nullable(),
    evidence_hash: z.string().regex(/^[a-f0-9]{64}$/), classification_note: z.string().nullable(),
    action_required: z.boolean().nullable(), supersedes_event_id: z.string().uuid().nullable(),
  }).strict()),
  outcome_checks: z.array(z.object({
    check_id: z.string().uuid(), reader_channel: z.literal('imap_inbox'), client_check_identity: z.string(),
    period_start: TimestampSchema, period_end: TimestampSchema, query_scope: z.string(),
    application_time_start: TimestampSchema.nullable(), complete: z.boolean(),
    status: z.enum(['observed', 'no_response', 'unknown']), source_ref: z.string().nullable(), recorded_at: TimestampSchema,
  }).strict()),
  stage_history: z.array(z.object({
    stage_history_id: z.string().uuid(),
    stage: ApplicationStageSchema,
    occurred_at: TimestampSchema,
  }).strict()),
}).strict()

const SnapshotPageSchema = z.object({
  snapshot: SnapshotMetadataSchema,
  applications: z.array(ApplicationEvidenceSchema),
  next_cursor: SnapshotCursorSchema.nullable(),
  is_final_page: z.boolean(),
}).strict().superRefine((page, context) => {
  if (page.is_final_page !== (page.next_cursor === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Final-page marker and next cursor disagree' })
  }
})

export const CreateApplicationEvidenceSnapshotInputSchema = z.object({}).strict()
export const GetApplicationEvidenceSnapshotPageInputSchema = z.object({
  snapshot_id: z.string().uuid(),
  after: SnapshotCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict()

export type ApplicationEvidenceSnapshotRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{
  data: unknown
  error: { code?: string } | null
}>

type SnapshotRefusalCode = 'invalid_input' | 'snapshot_not_found' | 'invalid_cursor_or_limit' | 'source_unavailable' | 'invalid_source_payload'
function snapshotRefusal(code: SnapshotRefusalCode) {
  return { status: 'refused' as const, code }
}

export async function createApplicationEvidenceSnapshot(input: unknown, rpc: ApplicationEvidenceSnapshotRpc) {
  if (!CreateApplicationEvidenceSnapshotInputSchema.safeParse(input).success) return snapshotRefusal('invalid_input')
  try {
    const { data, error } = await rpc('create_application_evidence_snapshot', {})
    if (error) return snapshotRefusal('source_unavailable')
    const snapshot = SnapshotMetadataSchema.safeParse(data)
    return snapshot.success ? { status: 'ok' as const, snapshot: snapshot.data } : snapshotRefusal('invalid_source_payload')
  } catch {
    return snapshotRefusal('source_unavailable')
  }
}

export async function getApplicationEvidenceSnapshotPage(input: unknown, rpc: ApplicationEvidenceSnapshotRpc) {
  const parsed = GetApplicationEvidenceSnapshotPageInputSchema.safeParse(input)
  if (!parsed.success) return snapshotRefusal('invalid_input')
  try {
    const { data, error } = await rpc('get_application_evidence_snapshot_page', {
      p_snapshot_id: parsed.data.snapshot_id,
      p_after_ordinal: parsed.data.after?.ordinal ?? null,
      p_limit: parsed.data.limit,
    })
    if (error) {
      if (error.code === 'P0001') return snapshotRefusal('snapshot_not_found')
      if (error.code === '22023') return snapshotRefusal('invalid_cursor_or_limit')
      return snapshotRefusal('source_unavailable')
    }
    const page = SnapshotPageSchema.safeParse(data)
    return page.success ? { status: 'ok' as const, page: page.data } : snapshotRefusal('invalid_source_payload')
  } catch {
    return snapshotRefusal('source_unavailable')
  }
}

export { ApplicationEvidenceSchema, SnapshotMetadataSchema, SnapshotPageSchema }
