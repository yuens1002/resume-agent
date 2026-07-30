/**
 * One-off backfill: mark historic machine-written thoughts `private: true`.
 *
 * Two classes of row reached the public `/observations` surface because nothing
 * ever stamped them private — and `isPublicThought` treats a missing `private`
 * flag as public-eligible, so "nobody marked it" means "anyone can read it":
 *
 *   1. `resume-failure` / `rubric` — rubric-failure telemetry from POST /resume,
 *      each row embedding the first 200 characters of a submitted job
 *      description. Publicly readable at `?topic=rubric`.
 *   2. `job-application` — application logs written by the job-hunt-agent
 *      pipeline, each naming an employer applied to plus a per-role fit score
 *      and gap assessment. Publicly readable at `?topic=job-application`.
 *
 * The forward fix for (1) is `RUBRIC_FAILURE_METADATA` in src/routes/resume.ts.
 * (2)'s producer lives in the job-hunt-agent repo and needs the same treatment
 * there; this script only repairs the rows already written.
 *
 * Marking private removes them from every public surface (`/observations`,
 * `/query` grounding via `match_thoughts_public`) while leaving them fully
 * readable to the owner through the private MCP — the data isn't deleted, just
 * un-published.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-private-telemetry.ts          # dry run
 *   npx tsx --env-file=.env.local scripts/backfill-private-telemetry.ts --apply  # write
 *
 * Dry run is the default on purpose: it prints exactly which rows would change
 * and lets you eyeball the selection before anything is mutated. Idempotent —
 * rows already carrying `private: true` are skipped, so a re-run is a no-op.
 */

import { supabase } from '../src/lib/supabase.js'

interface Row {
  id: string
  content: string
  metadata: Record<string, unknown> | null
  created_at: string
}

/** A class of machine-written rows to un-publish, selected by OB1 topic tag. */
export interface Target {
  label: string
  topic: string
  why: string
}

/**
 * Exported so a test can assert the selector actually matches what the producer
 * writes, rather than both sides pinning the same string literal independently.
 * `RUBRIC_FAILURE_METADATA.topics` in src/routes/resume.ts is the other half of
 * that pair: rename the topic there and this script silently stops matching,
 * which no literal-pinning test would catch.
 */
export const TARGETS: readonly Target[] = [
  {
    label: 'rubric telemetry',
    topic: 'resume-failure',
    why: 'embeds the first 200 chars of a submitted job description',
  },
  {
    label: 'job-application logs',
    topic: 'job-application',
    why: 'names the employer applied to plus a per-role fit score and gap assessment',
  },
  {
    label: 'employment delta proposals',
    topic: 'review_needed',
    why: 'LLM-proposed résumé bullets awaiting owner approval, including rejected ones',
  },
]

const APPLY = process.argv.includes('--apply')

/** Rows carrying `topic`, regardless of current privacy — the report distinguishes them. */
async function fetchByTopic(topic: string): Promise<Row[]> {
  const { data, error } = await supabase
    .from('thoughts')
    .select('id, content, metadata, created_at')
    .contains('metadata', { topics: [topic] })
    .order('created_at', { ascending: false })
  if (error) throw new Error(`fetch failed for topic "${topic}": ${error.message}`)
  return (data ?? []) as Row[]
}

const isPrivate = (r: Row): boolean => r.metadata?.private === true

const oneLine = (s: string, n = 90): string => s.replace(/\s+/g, ' ').slice(0, n)

async function main(): Promise<void> {
  console.log(APPLY ? '── APPLY — rows will be updated ──\n' : '── DRY RUN — no writes (pass --apply to execute) ──\n')

  let totalToUpdate = 0
  const plan: Array<{ target: Target; rows: Row[] }> = []

  for (const target of TARGETS) {
    const rows = await fetchByTopic(target.topic)
    const pending = rows.filter((r) => !isPrivate(r))
    plan.push({ target, rows: pending })
    totalToUpdate += pending.length

    console.log(`${target.label}  (topic: ${target.topic})`)
    console.log(`  ${target.why}`)
    console.log(`  ${rows.length} total, ${rows.length - pending.length} already private, ${pending.length} to update`)
    if (pending.length) {
      const dates = pending.map((r) => r.created_at.slice(0, 10)).sort()
      console.log(`  date range: ${dates[0]} → ${dates[dates.length - 1]}`)
      for (const r of pending.slice(0, 3)) {
        console.log(`    · ${r.created_at.slice(0, 10)}  ${oneLine(r.content)}…`)
      }
      if (pending.length > 3) console.log(`    · … and ${pending.length - 3} more`)
    }
    console.log()
  }

  if (!totalToUpdate) {
    console.log('Nothing to do — every targeted row is already private.')
    return
  }

  if (!APPLY) {
    console.log(`Would mark ${totalToUpdate} rows private. Re-run with --apply to execute.`)
    return
  }

  let updated = 0
  let failed = 0
  for (const { target, rows } of plan) {
    for (const row of rows) {
      // Read-modify-write rather than a jsonb merge: supabase-js has no `||`
      // operator, and every other metadata key must survive untouched.
      const next = { ...(row.metadata ?? {}), private: true }
      const { error } = await supabase.from('thoughts').update({ metadata: next }).eq('id', row.id)
      if (error) {
        failed += 1
        console.error(`  ✗ ${target.label} ${row.id}: ${error.message}`)
      } else {
        updated += 1
      }
    }
  }

  console.log(`\nUpdated ${updated} rows${failed ? `, ${failed} failed` : ''}.`)

  // Verify against the same selection rather than trusting the update count —
  // this is the check that the rows actually left the public surface.
  let stillPublic = 0
  for (const target of TARGETS) {
    const rows = await fetchByTopic(target.topic)
    const leaked = rows.filter((r) => !isPrivate(r)).length
    stillPublic += leaked
    console.log(`  ${target.label}: ${rows.length} rows, ${leaked} still public`)
  }
  if (stillPublic) {
    console.error(`\n${stillPublic} rows are still public — re-run or investigate.`)
    process.exitCode = 1
  } else {
    console.log('\nVerified: no targeted row remains publicly readable.')
  }
}

// Only run when invoked directly. Importing this module (the coupling test in
// tests/telemetry-privacy.test.ts reads TARGETS from it) must not execute a
// backfill as a side effect. Same guard shape as scripts/verify-oep-domain.ts.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))

if (isMain) {
  main().catch((err) => {
    console.error('[backfill] failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
