import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * log_application (src/routes/mcp.ts) — submitted-only unit tests.
 *
 * This tool now records a submitted application only: it refuses
 * `is_submitted: false` (no drafts) and refuses `resume_content`,
 * `docx_base64`, or `pdf_base64` when present, before any database write or
 * scoring call. These tests exercise the real registered tool handler
 * in-process through the Hono route (no live server), the same way
 * tests/job-pipeline-feed-auth.test.ts does.
 *
 * No network: synthetic credentials only (this suite does not call
 * database/model services), and `globalThis.fetch` is replaced per-test so
 * the shared Supabase client (which resolves `fetch` at call time — see
 * src/lib/bounded-fetch.ts) never reaches a real host. The happy-path test
 * omits `job_description` on purpose, so the (unrelated, pre-existing)
 * fit-scoring call into the model provider is never triggered either.
 *
 * Run: npm run test:unit
 */

process.env.OPEN_BRAIN_KEY = 'synthetic-test-brain-key'
process.env.OPENROUTER_API_KEY = 'synthetic-model-key'
process.env.SUPA_PROJECT_URL = 'https://synthetic.invalid'
process.env.SUPA_SERVICE_ROLE = 'synthetic-service-role'
const { default: privateRoute } = await import('../src/routes/mcp.js')

const FAKE_APPLICATION_ID = '11111111-1111-1111-1111-111111111111'

type FetchCall = { url: string; method: string; body?: unknown }

/** Records every call; fails loudly (not silently) if one is ever made. */
function noCallsExpectedFetch(calls: FetchCall[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    calls.push({ url, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify({ message: 'no Supabase call should have been made' }), { status: 500 })
  }
}

/** Fakes exactly the two REST calls a successful submitted log should make. */
function submittedOnlyFetch(calls: FetchCall[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = init?.method ?? 'GET'
    const rawBody = init?.body
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined
    calls.push({ url, method, body })
    if (url.includes('/rest/v1/job_applications') && method === 'POST') {
      return new Response(JSON.stringify({ id: FAKE_APPLICATION_ID }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/rest/v1/application_stages') && method === 'POST') {
      return new Response('', { status: 201 })
    }
    throw new Error(`Unexpected fetch call in test: ${method} ${url}`)
  }
}

async function callLogApplication(args: Record<string, unknown>) {
  const res = await privateRoute.request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-brain-key': process.env.OPEN_BRAIN_KEY!,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_application', arguments: args } }),
  })
  const text = await res.text()
  const json = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data:'))!.slice(5))
    : JSON.parse(text)
  assert.equal(json.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(json.error)}`)
  const result = json.result as { isError?: boolean; content: { type: string; text: string }[] }
  return { isError: Boolean(result.isError), text: result.content.map(c => c.text).join('\n') }
}

describe('log_application — submitted-only refusals', () => {
  it('refuses is_submitted: false with "draft" in the refusal text and makes no Supabase call', async () => {
    const calls: FetchCall[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = noCallsExpectedFetch(calls)
    try {
      const { isError, text } = await callLogApplication({
        company: 'Acme', role: 'Engineer', is_submitted: false, job_description: 'Synthetic JD text for testing.',
      })
      assert.equal(isError, true)
      assert.match(text, /draft/i)
      assert.equal(calls.length, 0, `expected zero Supabase calls, got: ${JSON.stringify(calls)}`)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  for (const field of ['resume_content', 'docx_base64', 'pdf_base64'] as const) {
    it(`refuses ${field} with "resume" in the refusal text and makes no Supabase call`, async () => {
      const calls: FetchCall[] = []
      const previousFetch = globalThis.fetch
      globalThis.fetch = noCallsExpectedFetch(calls)
      try {
        const value = field === 'resume_content' ? { summary: 'tailored' } : 'ZmFrZSBieXRlcw=='
        const { isError, text } = await callLogApplication({
          company: 'Acme', role: 'Engineer', job_description: 'Synthetic JD text for testing.', [field]: value,
        })
        assert.equal(isError, true)
        assert.match(text, /resume/i)
        assert.match(text, new RegExp(field))
        assert.equal(calls.length, 0, `expected zero Supabase calls, got: ${JSON.stringify(calls)}`)
      } finally {
        globalThis.fetch = previousFetch
      }
    })
  }

  it('an empty resume_content object is not refused (present-but-empty is treated as omitted)', async () => {
    const calls: FetchCall[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = submittedOnlyFetch(calls)
    try {
      const { isError, text } = await callLogApplication({
        company: 'Acme', role: 'Engineer', resume_content: {},
      })
      assert.equal(isError, false, text)
      assert.doesNotMatch(text, /refused/i)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('a plain submitted call still inserts the application (stage applied) and the stage row, with no resume evidence write', async () => {
    const calls: FetchCall[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = submittedOnlyFetch(calls)
    try {
      const { isError, text } = await callLogApplication({
        company: 'Acme', role: 'Engineer', url: 'https://example.invalid/job/1', applied_at: '2026-01-01',
      })
      assert.equal(isError, false, text)
      assert.match(text, /Application logged/)
      assert.match(text, /Stage: applied/)
      assert.match(text, new RegExp(FAKE_APPLICATION_ID))

      const tables = calls.map(c => c.url)
      assert.ok(tables.some(url => url.includes('/rest/v1/job_applications')), 'expected a job_applications insert')
      assert.ok(tables.some(url => url.includes('/rest/v1/application_stages')), 'expected an application_stages insert')
      assert.ok(!tables.some(url => url.includes('/rest/v1/application_resumes')), 'must not insert into application_resumes')
      assert.ok(!tables.some(url => url.includes('/storage/v1/object')), 'must not upload to storage')

      const jobApplicationsCall = calls.find(c => c.url.includes('/rest/v1/job_applications'))
      const applicationStagesCall = calls.find(c => c.url.includes('/rest/v1/application_stages'))
      assert.equal((jobApplicationsCall?.body as { stage?: string } | undefined)?.stage, 'applied', 'job_applications insert must carry stage applied')
      assert.equal((applicationStagesCall?.body as { stage?: string } | undefined)?.stage, 'applied', 'application_stages insert must carry stage applied')
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
