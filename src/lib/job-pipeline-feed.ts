import { z } from 'zod'

const SequenceSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).max(19)
  .refine(value => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 19 && BigInt(value) <= 9223372036854775807n)
export const JobFeedCursorSchema = z.object({ generation: z.string().uuid(), sequence: SequenceSchema }).strict()
export const JobFeedInputSchema = z.object({
  cursor: JobFeedCursorSchema.optional(),
  timezone: z.string().min(1).max(100).default('UTC'),
}).strict()
const StageSchema = z.enum(['applied', 'phone_screen', 'technical', 'final', 'offer', 'rejected', 'withdrawn'])
const ApplicationSchema = z.object({
  application_id: z.string().uuid(), company: z.string(), role: z.string(), stage: StageSchema,
  applied_at: z.string().datetime({ offset: true }),
  follow_up_date: z.string().date().nullable(),
}).strict()
export const JobFeedEnvelopeSchema = z.object({
  version: z.literal(1), source: z.literal('resume-agent.job_applications'),
  as_of: z.string().datetime({ offset: true }), timezone: z.string(), baseline: z.boolean(),
  history_available_since: z.string().datetime({ offset: true }), next_cursor: JobFeedCursorSchema,
  summary: z.object({
    recorded_applications: z.number().int().nonnegative().safe(),
    by_stage: z.record(StageSchema, z.number().int().nonnegative().safe()),
  }).strict(),
  changes: z.array(z.object({
    sequence: SequenceSchema, application_id: z.string().uuid(),
    operation: z.enum(['INSERT', 'UPDATE', 'DELETE']),
    observed_at: z.string().datetime({ offset: true }), application: ApplicationSchema,
  }).strict()).max(1000),
  due_work: z.array(ApplicationSchema).max(1000),
}).strict()
export type JobFeedEnvelope = z.infer<typeof JobFeedEnvelopeSchema>
export type JobFeedRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{
  data: unknown; error: { code?: string } | null
}>

export async function readJobPipelineFeed(input: unknown, rpc: JobFeedRpc) {
  const parsed = JobFeedInputSchema.safeParse(input)
  if (!parsed.success) return { status: 'refused' as const, code: 'invalid_input' }
  try {
    const { data: payload, error } = await rpc('get_job_pipeline_feed', {
      p_generation: parsed.data.cursor?.generation ?? null,
      p_after_sequence: parsed.data.cursor?.sequence ?? null,
      p_timezone: parsed.data.timezone,
    })
    if (error) return {
      status: 'refused' as const,
      code: error.code === '22023' ? 'invalid_cursor_or_timezone'
        : error.code === '54000' ? 'feed_overflow' : 'source_unavailable',
    }
    const envelope = JobFeedEnvelopeSchema.safeParse(payload)
    if (!envelope.success) return { status: 'refused' as const, code: 'invalid_source_payload' }
    return { status: 'ok' as const, feed: envelope.data }
  } catch {
    return { status: 'refused' as const, code: 'source_unavailable' }
  }
}
