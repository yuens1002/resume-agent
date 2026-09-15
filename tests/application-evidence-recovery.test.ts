import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import {
  artifactPath,
  MAX_RESUME_CONTENT_BYTES,
  recoverApplicationEvidence,
  type ApplicationEvidenceRecoverySource,
} from '../src/lib/application-evidence-recovery.js'

const APPLICATION_ID = '10000000-0000-4000-8000-000000000001'
const RESUME_ID = '20000000-0000-4000-8000-000000000002'
const RECOVERY_ID = '30000000-0000-4000-8000-000000000003'
const RECORDED_AT = '2026-09-15T12:00:00.000Z'

function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    recovery_id: RECOVERY_ID,
    application_id: APPLICATION_ID,
    expected_company: 'Example Corp',
    expected_role: 'Staff Engineer',
    resume_id: RESUME_ID,
    resume_content: { summary: 'Recovered exact content' },
    source_ref: 'job-hunt-agent:output:resume-1788216250730',
    docx_bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
    ...overrides,
  }
}

function fixture() {
  const uploads = new Map<string, Uint8Array>()
  let savedArgs: Record<string, unknown> | null = null
  let savedReadback: Awaited<ReturnType<ApplicationEvidenceRecoverySource['readback']>>['data'] = null
  let recoveryCalls = 0
  const source: ApplicationEvidenceRecoverySource = {
    readApplication: async () => ({ data: { id: APPLICATION_ID, company: 'Example Corp', role: 'Staff Engineer', stage: 'rejected' }, error: null }),
    upload: async (path, bytes) => {
      if (uploads.has(path)) return { error: new Error('already exists') }
      uploads.set(path, Uint8Array.from(bytes))
      return { error: null }
    },
    download: async path => ({ data: uploads.has(path) ? stream(uploads.get(path)!) : null, error: null }),
    recover: async args => {
      recoveryCalls++
      if (savedArgs && !isDeepStrictEqual(savedArgs, args)) return { data: null, error: new Error('conflict') }
      const idempotent = Boolean(savedArgs)
      savedArgs = structuredClone(args)
      savedReadback = {
        recovery_id: String(args.p_recovery_id), application_id: String(args.p_application_id), resume_id: String(args.p_resume_id),
        source_ref: String(args.p_source_ref), recorded_at: RECORDED_AT, original_generated_at: null,
        resume_content: structuredClone(args.p_resume_content), docx_url: args.p_docx_url as string | null,
        docx_hash: args.p_docx_hash as string | null, pdf_url: args.p_pdf_url as string | null,
        pdf_hash: args.p_pdf_hash as string | null, is_submitted: false,
      }
      return { data: { recovery_id: RECOVERY_ID, application_id: APPLICATION_ID, resume_id: RESUME_ID, recorded_at: RECORDED_AT, idempotent }, error: null }
    },
    readback: async () => ({ data: savedReadback, error: null }),
  }
  return { source, uploads, get recoveryCalls() { return recoveryCalls } }
}

describe('source-owner application evidence recovery', () => {
  it('verifies a deterministic private artifact, records a non-submitted version, and replays identically', async () => {
    const target = fixture()
    const first = await recoverApplicationEvidence(input(), target.source)
    assert.equal(first.status, 'ok')
    if (first.status !== 'ok') return
    assert.equal(first.recovery.is_submitted, false)
    assert.equal(first.recovery.original_generation_time_status, 'unknown')
    assert.equal(first.recovery.idempotent, false)
    assert.deepEqual([...target.uploads.keys()], [artifactPath(APPLICATION_ID, RESUME_ID, 'docx')])

    const replay = await recoverApplicationEvidence(input(), target.source)
    assert.equal(replay.status, 'ok')
    if (replay.status === 'ok') assert.equal(replay.recovery.idempotent, true)
    assert.equal(target.uploads.size, 1)
    assert.equal(target.recoveryCalls, 2)
  })

  it('fails before artifact or database writes when the existing application identity differs', async () => {
    const target = fixture()
    const result = await recoverApplicationEvidence(input({ expected_role: 'Different Role' }), target.source)
    assert.deepEqual(result, { status: 'refused', code: 'application_identity_mismatch' })
    assert.equal(target.uploads.size, 0)
    assert.equal(target.recoveryCalls, 0)
  })

  it('rejects changed local bytes at the immutable deterministic path on retry', async () => {
    const target = fixture()
    assert.equal((await recoverApplicationEvidence(input(), target.source)).status, 'ok')
    const changed = await recoverApplicationEvidence(input({ docx_bytes: new Uint8Array([9, 8, 7]) }), target.source)
    assert.deepEqual(changed, { status: 'refused', code: 'artifact_hash_mismatch' })
    assert.equal(target.recoveryCalls, 1)
  })

  it('rejects missing artifacts, arbitrary source references, and inconsistent readback', async () => {
    const target = fixture()
    assert.deepEqual(await recoverApplicationEvidence(input({ docx_bytes: undefined }), target.source), { status: 'refused', code: 'invalid_input' })
    assert.deepEqual(await recoverApplicationEvidence(input({ source_ref: 'https://example.test/arbitrary' }), target.source), { status: 'refused', code: 'invalid_input' })

    const originalReadback = target.source.readback
    target.source.readback = async recoveryId => {
      const result = await originalReadback(recoveryId)
      return { ...result, data: result.data && { ...result.data, is_submitted: true } }
    }
    assert.deepEqual(await recoverApplicationEvidence(input(), target.source), { status: 'refused', code: 'invalid_source_payload' })
  })

  it('caps structured resume content and is absent from both MCP registration modules', async () => {
    const target = fixture()
    assert.deepEqual(await recoverApplicationEvidence(input({
      resume_content: { oversized: 'x'.repeat(MAX_RESUME_CONTENT_BYTES) },
    }), target.source), { status: 'refused', code: 'invalid_input' })
    for (const route of ['src/routes/mcp.ts', 'src/routes/public-mcp.ts']) {
      assert.doesNotMatch(readFileSync(route, 'utf8'), /recover_application_(?:resume|evidence)/)
    }
  })
})
