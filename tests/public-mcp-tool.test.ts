/**
 * Public MCP Tool Behavior — acceptance tests for ask_candidate
 *
 * Covers AC-9 through AC-18 from docs/plans/public-mcp-query-only.md.
 * Integration style: hits a live dev server, calls the LLM, verifies
 * Supabase observed_queries rows, and inspects the agent card.
 *
 * Requirements:
 *   PUBLIC_MCP_URL  (defaults to http://localhost:${PORT ?? 3000}/public-mcp)
 *   QUERY_URL       (defaults to http://localhost:${PORT ?? 3000}/query)
 *   AGENT_CARD_URL  (defaults to http://localhost:${PORT ?? 3000}/.well-known/agent-card.json)
 *   SUPA_PROJECT_URL, SUPA_SERVICE_ROLE  (for verifying logged rows + cleanup)
 *
 * Run (requires local server + seeded profile):
 *   npm run test:public-mcp
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'
import {
  publicMcpPost,
  publicMcpToolsList,
  parseMcpBody,
  parseAllMcpEvents,
  waitForLoggedCall,
  cleanupTestRows,
  isQueryResponseShape,
  getSupabase,
  TEST_QUESTION,
  TEST_QUESTION_MARKER,
  QUERY_URL,
  AGENT_CARD_URL,
  type QueryResponseShape,
} from './helpers/public-mcp.js'

config({ path: '.env.local' })

if (!process.env.SUPA_PROJECT_URL || !process.env.SUPA_SERVICE_ROLE) {
  throw new Error('SUPA_PROJECT_URL and SUPA_SERVICE_ROLE must be set in .env.local')
}

// ── Cleanup ──────────────────────────────────────────────

after(async () => {
  const deleted = await cleanupTestRows(TEST_QUESTION_MARKER)
  console.log(`Cleaned up ${deleted} test row(s) from observed_queries`)
})

// ── Internal helper: one call to ask_candidate, parsed three ways ──

interface AskCandidateResult {
  rawResponse: Response
  rawText: string
  allEvents: unknown[]
  toolResultText: string | null
  parsedJson: unknown
}

async function callAskCandidate(args: {
  question: string
  context?: string
  stream?: boolean
}): Promise<AskCandidateResult> {
  const rawResponse = await publicMcpPost(args)
  const rawText = await rawResponse.text()
  const allEvents = parseAllMcpEvents(rawText)

  // Find the last event with a tool result (final response, not progress notifications)
  const lastResult = [...allEvents].reverse().find(
    (e): e is { result?: { content?: { type: string; text: string }[] } } =>
      typeof e === 'object' &&
      e !== null &&
      'result' in e &&
      typeof (e as { result?: unknown }).result === 'object',
  )
  const toolResultText = lastResult?.result?.content?.[0]?.text ?? null

  let parsedJson: unknown = null
  if (toolResultText) {
    try { parsedJson = JSON.parse(toolResultText) } catch { /* not JSON */ }
  }

  return { rawResponse, rawText, allEvents, toolResultText, parsedJson }
}

// ── AC-9: tools/list returns exactly one tool named ask_candidate ──

describe('AC-9: tools/list returns exactly one tool', () => {
  it('single tool named ask_candidate', async () => {
    const res = await publicMcpToolsList()
    assert.ok(res.ok, `tools/list must succeed, got ${res.status}`)
    const body = parseMcpBody(await res.text()) as {
      result?: { tools?: { name: string }[] }
    }
    const tools = body?.result?.tools ?? []
    assert.equal(tools.length, 1, `Expected exactly 1 tool, got ${tools.length}`)
    assert.equal(
      tools[0].name,
      'ask_candidate',
      `Expected tool name 'ask_candidate', got '${tools[0].name}'`,
    )
  })
})

// ── AC-10: ask_candidate returns grounded response ──

describe('AC-10: ask_candidate returns grounded response', () => {
  it('non-empty answer, valid confidence, at least one source', async () => {
    const { parsedJson, rawResponse } = await callAskCandidate({ question: TEST_QUESTION })
    assert.ok(rawResponse.ok, `Expected 2xx, got ${rawResponse.status}`)
    assert.ok(parsedJson, 'Tool response must contain parseable JSON text')
    assert.ok(
      isQueryResponseShape(parsedJson),
      'Response must match QueryResponse shape',
    )
    const r = parsedJson as QueryResponseShape
    assert.ok(r.answer.length > 0, 'answer must be non-empty')
    assert.ok(
      ['high', 'medium', 'low'].includes(r.confidence),
      `confidence must be high/medium/low, got ${r.confidence}`,
    )
    assert.ok(r.sources.length > 0, 'at least one source required')
  })
})

// ── AC-11: MCP tool response JSON matches /query HTTP response shape ──

describe('AC-11: ask_candidate and HTTP /query shape parity', () => {
  it('both return responses with identical top-level keys', async () => {
    const mcpResult = await callAskCandidate({ question: TEST_QUESTION })
    assert.ok(mcpResult.parsedJson, 'MCP tool response must be parseable JSON')
    assert.ok(
      isQueryResponseShape(mcpResult.parsedJson),
      'MCP response must match QueryResponse shape',
    )

    const httpRes = await fetch(QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: TEST_QUESTION }),
    })
    assert.ok(httpRes.ok, `HTTP /query must succeed, got ${httpRes.status}`)
    const httpBody = await httpRes.json()
    assert.ok(
      isQueryResponseShape(httpBody),
      'HTTP /query response must match QueryResponse shape',
    )

    const mcpKeys = Object.keys(mcpResult.parsedJson).sort()
    const httpKeys = Object.keys(httpBody).sort()
    assert.deepEqual(
      mcpKeys,
      httpKeys,
      `Key parity required. MCP=[${mcpKeys.join(',')}] HTTP=[${httpKeys.join(',')}]`,
    )
  })
})

// ── AC-12: context parameter propagates (smoke-only) ──

describe('AC-12: context parameter propagates', () => {
  // SMOKE-ONLY: tone changes are subjective and non-deterministic in LLM
  // output. This test verifies both context values succeed and return valid
  // responses. A stricter tone comparison would require LLM-as-judge evaluation.
  it('both ATS and recruiter contexts return valid responses', async () => {
    const ats = await callAskCandidate({ question: TEST_QUESTION, context: 'ATS' })
    const rec = await callAskCandidate({ question: TEST_QUESTION, context: 'recruiter' })
    assert.ok(isQueryResponseShape(ats.parsedJson), 'ATS response must be valid')
    assert.ok(isQueryResponseShape(rec.parsedJson), 'recruiter response must be valid')
  })
})

// ── AC-13: response includes contact info ──

describe('AC-13: response includes contact info when profile has it', () => {
  it('contact block contains email and/or calendly', async () => {
    const { parsedJson } = await callAskCandidate({ question: TEST_QUESTION })
    assert.ok(isQueryResponseShape(parsedJson), 'Must be valid response shape')
    const r = parsedJson as QueryResponseShape
    assert.ok(r.contact, 'contact block must be present')
    const hasEmail = typeof r.contact.email === 'string' && r.contact.email.length > 0
    const hasCalendly = typeof r.contact.calendly === 'string' && r.contact.calendly.length > 0
    assert.ok(
      hasEmail || hasCalendly,
      'at least one of contact.email or contact.calendly must be present (depends on seeded profile)',
    )
  })
})

// ── AC-14: stream=true emits progress notifications ──

describe('AC-14: ask_candidate with stream=true emits progress', () => {
  it('streaming response contains ≥1 notifications/progress event before final', async () => {
    const { rawText, allEvents } = await callAskCandidate({
      question: TEST_QUESTION,
      stream: true,
    })
    assert.ok(
      rawText.includes('data:'),
      'Streaming response must be SSE-formatted (expected `data:` prefix)',
    )
    assert.ok(
      allEvents.length >= 2,
      `Streaming must emit ≥2 events (≥1 progress + 1 final), got ${allEvents.length}`,
    )
    const hasProgress = allEvents.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        'method' in e &&
        (e as { method?: string }).method === 'notifications/progress',
    )
    assert.ok(hasProgress, 'At least one event must be a notifications/progress message')
  })
})

// ── AC-15: MCP call logged to observed_queries with source='mcp' ──

describe('AC-15: ask_candidate call logged to observed_queries with full payload', () => {
  it('row has source=mcp and all payload-derived fields populated', async () => {
    const uniqueQuestion = `${TEST_QUESTION_MARKER} AC-15 mcp log verification`
    const { rawResponse } = await callAskCandidate({
      question: uniqueQuestion,
      context: 'recruiter',
    })
    assert.ok(rawResponse.ok, `ask_candidate must succeed, got ${rawResponse.status}`)
    const row = await waitForLoggedCall(uniqueQuestion, 'mcp')
    assert.ok(row, `Expected observed_queries row for question="${uniqueQuestion}" with source=mcp`)
    assert.equal(row!.source, 'mcp')
    assert.equal(row!.question, uniqueQuestion)
    assert.equal(row!.caller_hint, 'recruiter', 'caller_hint must match the context arg')
    assert.ok(row!.answer && row!.answer.length > 0, 'answer must be populated')
    assert.ok(
      ['high', 'medium', 'low'].includes(row!.confidence ?? ''),
      `confidence must be populated with a valid enum value, got ${row!.confidence}`,
    )
    assert.ok(Array.isArray(row!.sources), 'sources must be populated as a jsonb array')
    assert.ok(row!.model && row!.model.length > 0, 'model must be populated')
    assert.ok(
      typeof row!.latency_ms === 'number' && row!.latency_ms > 0,
      `latency_ms must be a positive number, got ${row!.latency_ms}`,
    )
  })
})

// ── AC-16: HTTP /query also logs to observed_queries ──

describe('AC-16: HTTP /query call logged to observed_queries (field parity)', () => {
  it('row has source=http and all payload-derived fields populated', async () => {
    const uniqueQuestion = `${TEST_QUESTION_MARKER} AC-16 http log verification`
    const res = await fetch(QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: uniqueQuestion, context: 'ATS' }),
    })
    assert.ok(res.ok, `HTTP /query must succeed, got ${res.status}`)
    const row = await waitForLoggedCall(uniqueQuestion, 'http')
    assert.ok(row, `Expected observed_queries row for question="${uniqueQuestion}" with source=http`)
    assert.equal(row!.source, 'http')
    assert.equal(row!.question, uniqueQuestion)
    assert.equal(row!.caller_hint, 'ATS')
    assert.ok(row!.answer && row!.answer.length > 0, 'answer must be populated')
    assert.ok(
      ['high', 'medium', 'low'].includes(row!.confidence ?? ''),
      `confidence must be valid, got ${row!.confidence}`,
    )
    assert.ok(Array.isArray(row!.sources), 'sources must be populated')
    assert.ok(row!.model && row!.model.length > 0, 'model must be populated')
    assert.ok(
      typeof row!.latency_ms === 'number' && row!.latency_ms > 0,
      `latency_ms must be positive, got ${row!.latency_ms}`,
    )
  })
})

// ── AC-17: agent card advertises MCP interface ──

describe('AC-17: agent card advertises MCP interface', () => {
  it('supportedInterfaces contains an MCP entry with correct URL + version', async () => {
    const res = await fetch(AGENT_CARD_URL)
    assert.ok(res.ok, `Agent card must be reachable, got ${res.status}`)
    const card = (await res.json()) as {
      supportedInterfaces?: { url: string; protocolBinding: string; protocolVersion?: string }[]
    }
    const interfaces = card.supportedInterfaces ?? []
    const mcp = interfaces.find((i) => i.protocolBinding === 'MCP')
    assert.ok(mcp, 'MCP interface must be present in supportedInterfaces')
    assert.ok(
      mcp!.url.endsWith('/public-mcp'),
      `MCP URL should end with /public-mcp, got ${mcp!.url}`,
    )
    assert.equal(
      mcp!.protocolVersion,
      '2025-03-26',
      `Expected protocolVersion 2025-03-26, got ${mcp!.protocolVersion}`,
    )
  })
})

// ── AC-18: MCP interface appears first in supportedInterfaces ──

describe('AC-18: MCP interface listed first in agent card', () => {
  it('supportedInterfaces[0] has protocolBinding MCP', async () => {
    const res = await fetch(AGENT_CARD_URL)
    const card = (await res.json()) as {
      supportedInterfaces?: { protocolBinding: string }[]
    }
    const interfaces = card.supportedInterfaces ?? []
    assert.ok(interfaces.length > 0, 'supportedInterfaces must be non-empty')
    assert.equal(
      interfaces[0].protocolBinding,
      'MCP',
      `First interface should be MCP, got '${interfaces[0].protocolBinding}'`,
    )
  })
})

// ── AC-20: migration applied cleanly (implicit — table is reachable) ──

describe('AC-20: observed_queries migration applied cleanly', () => {
  it('table is reachable and accepts a valid row via insert+delete round-trip', async () => {
    const supabase = getSupabase()
    const probeQuestion = `${TEST_QUESTION_MARKER} AC-20 probe`
    const { data, error } = await supabase
      .from('observed_queries')
      .insert({
        source: 'http',
        question: probeQuestion,
        caller_hint: 'test',
        answer: 'probe',
        confidence: 'high',
        sources: ['probe.source'],
        model: 'probe-model',
        latency_ms: 1,
        ip_hash: 'probe-hash',
        user_agent: 'probe-ua',
      })
      .select('id')
      .single()
    assert.ok(!error, `Insert must succeed, got error: ${error?.message}`)
    assert.ok(data?.id, 'Row must return an id')

    // Clean up the probe immediately (cleanupTestRows also runs in after() as backup)
    await supabase.from('observed_queries').delete().eq('id', data.id)
  })
})

// ── AC-21: schema constraints match the plan ──

describe('AC-21: observed_queries schema matches plan', () => {
  it('check constraint on source rejects invalid values', async () => {
    const supabase = getSupabase()
    const { error } = await supabase
      .from('observed_queries')
      .insert({
        source: 'invalid-source-xyz',
        question: `${TEST_QUESTION_MARKER} AC-21 constraint probe`,
      })
      .select('id')
      .single()
    assert.ok(
      error,
      'Insert with source=invalid-source-xyz must fail due to CHECK constraint',
    )
    // Postgres check constraint violation — error message typically mentions "check"
    assert.match(
      error!.message.toLowerCase(),
      /check|constraint|violates/,
      `Error should indicate a constraint violation, got: ${error!.message}`,
    )
  })

  it('question column is required (NOT NULL)', async () => {
    const supabase = getSupabase()
    // Cast to bypass loose Supabase client typing — we intentionally omit the
    // required 'question' field to verify the DB-level NOT NULL constraint.
    const payload = { source: 'mcp' } as unknown as { source: string; question: string }
    const { error } = await supabase
      .from('observed_queries')
      .insert(payload)
      .select('id')
      .single()
    assert.ok(error, 'Insert without question must fail due to NOT NULL on question')
  })
})

// ── AC-26: README documents connector-add path ──

describe('AC-26: README "Add as a custom connector" section', () => {
  it('README.md contains connector-add section with public-mcp URL reference', async () => {
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const path = resolve(process.cwd(), 'README.md')
    const content = await readFile(path, 'utf8')
    assert.match(
      content,
      /add as a custom connector/i,
      'README must contain a section titled "Add as a custom connector"',
    )
    assert.match(
      content,
      /\/public-mcp/,
      'README must reference the /public-mcp URL in the connector section',
    )
  })
})

// ── AC-27: mcp-architecture.md documents /public-mcp ──

describe('AC-27: docs/mcp-architecture.md mentions /public-mcp', () => {
  it('mcp-architecture.md references the public MCP route', async () => {
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const path = resolve(process.cwd(), 'docs', 'mcp-architecture.md')
    const content = await readFile(path, 'utf8')
    assert.match(
      content,
      /\/public-mcp/,
      'docs/mcp-architecture.md must reference the /public-mcp route',
    )
  })
})
