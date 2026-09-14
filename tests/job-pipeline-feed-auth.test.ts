import { it } from 'node:test'
import assert from 'node:assert/strict'

// Synthetic credentials only. This suite does not call database/model services.
process.env.OPEN_BRAIN_KEY = 'synthetic-test-brain-key'
process.env.OPENROUTER_API_KEY = 'synthetic-model-key'
process.env.SUPA_PROJECT_URL = 'https://synthetic.invalid'
process.env.SUPA_SERVICE_ROLE = 'synthetic-service-role'
const { default: privateRoute } = await import('../src/routes/mcp.js')
const { default: publicRoute } = await import('../src/routes/public-mcp.js')
const listingRequest = (key?: string) => ({
  method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(key ? { 'x-brain-key': key } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
})
async function toolNames(response: Response): Promise<string[]> {
  const text = await response.text()
  const json = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data:'))!.slice(5))
    : JSON.parse(text)
  assert.equal(json.error, undefined)
  assert.ok(Array.isArray(json.result?.tools) && json.result.tools.length > 0)
  return json.result.tools.map((tool: { name: string }) => tool.name)
}
it('AC-06 private route rejects missing/wrong credentials before serving tools', async () => {
  for (const key of [undefined, 'wrong-key']) {
    assert.equal((await privateRoute.request('/', listingRequest(key))).status, 401)
  }
})
it('AC-06 authenticated private listing includes private readers; public listing excludes them', async () => {
  const privateResponse = await privateRoute.request('/', listingRequest(process.env.OPEN_BRAIN_KEY))
  assert.equal(privateResponse.status, 200)
  const privateNames = await toolNames(privateResponse)
  for (const name of ['get_job_pipeline_feed', 'create_application_evidence_snapshot', 'get_application_evidence_snapshot_page', 'get_application_resume_artifact']) {
    assert.ok(privateNames.includes(name), `private listing should include ${name}`)
  }
  const publicResponse = await publicRoute.request('/', listingRequest())
  assert.equal(publicResponse.status, 200)
  const publicNames = await toolNames(publicResponse)
  assert.ok(publicNames.includes('ask_candidate'))
  for (const name of ['get_job_pipeline_feed', 'create_application_evidence_snapshot', 'get_application_evidence_snapshot_page', 'get_application_resume_artifact']) {
    assert.ok(!publicNames.includes(name), `public listing must exclude ${name}`)
  }
})
