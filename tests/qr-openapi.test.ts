/**
 * Routing contract tests — /openapi.json and /qr endpoints.
 *
 * Run: npm run test:unit
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import openApiRoute from '../src/routes/openapi.js'
import qrRoute from '../src/routes/qr.js'

function buildApp() {
  const app = new Hono()
  app.route('/openapi.json', openApiRoute)
  app.route('/qr', qrRoute)
  return app
}

describe('/openapi.json and /qr routes', () => {
  let baseUrl: string
  let server: ReturnType<typeof serve>

  before(async () => {
    const app = buildApp()
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://localhost:${info.port}`
        resolve()
      })
    })
  })

  after(() => server.close())

  describe('GET /openapi.json', () => {
    it('AC-1: returns 200 with application/json', async () => {
      const res = await fetch(`${baseUrl}/openapi.json`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    })

    it('AC-2: body has openapi 3.1.0 and exactly 5 paths', async () => {
      const res = await fetch(`${baseUrl}/openapi.json`)
      const body = await res.json() as Record<string, unknown>
      assert.equal(body.openapi, '3.1.0')
      const paths = Object.keys(body.paths as object)
      assert.equal(paths.length, 5, `expected 5 paths, got ${paths.length}: ${paths.join(', ')}`)
      assert.ok(paths.includes('/query'))
      assert.ok(paths.includes('/match'))
      assert.ok(paths.includes('/info'))
      assert.ok(paths.includes('/availability'))
      assert.ok(paths.includes('/projects'))
    })

    it('AC-3: servers[0].url uses PUBLIC_URL env var when set', async () => {
      const saved = process.env.PUBLIC_URL
      process.env.PUBLIC_URL = 'https://agent.example.com'
      try {
        const res = await fetch(`${baseUrl}/openapi.json`)
        const body = await res.json() as { servers: Array<{ url: string }> }
        assert.equal(body.servers[0].url, 'https://agent.example.com')
      } finally {
        if (saved === undefined) delete process.env.PUBLIC_URL
        else process.env.PUBLIC_URL = saved
      }
    })
  })

  describe('GET /qr', () => {
    it('AC-4: returns 200 with image/png', async () => {
      const res = await fetch(`${baseUrl}/qr`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /image\/png/)
    })

    it('AC-5: response body is a non-empty PNG buffer', async () => {
      const res = await fetch(`${baseUrl}/qr`)
      const buf = Buffer.from(await res.arrayBuffer())
      assert.ok(buf.length > 0, 'PNG buffer should not be empty')
      // PNG magic bytes: 89 50 4E 47
      assert.equal(buf[0], 0x89)
      assert.equal(buf[1], 0x50) // P
      assert.equal(buf[2], 0x4e) // N
      assert.equal(buf[3], 0x47) // G
    })

    it('AC-6: uses QR_TARGET_URL env var when set — PNG differs from fallback', async () => {
      const saved = process.env.QR_TARGET_URL
      delete process.env.QR_TARGET_URL
      const baseline = Buffer.from(await (await fetch(`${baseUrl}/qr`)).arrayBuffer())

      process.env.QR_TARGET_URL = 'https://chatgpt.com/g/g-TEST'
      try {
        const res = await fetch(`${baseUrl}/qr`)
        assert.equal(res.status, 200)
        const withTarget = Buffer.from(await res.arrayBuffer())
        assert.notDeepEqual(withTarget, baseline, 'QR PNG should differ when QR_TARGET_URL changes')
      } finally {
        if (saved === undefined) delete process.env.QR_TARGET_URL
        else process.env.QR_TARGET_URL = saved
      }
    })

    it('AC-7: falls back gracefully when QR_TARGET_URL is unset', async () => {
      const savedTarget = process.env.QR_TARGET_URL
      const savedPublic = process.env.PUBLIC_URL
      delete process.env.QR_TARGET_URL
      delete process.env.PUBLIC_URL
      try {
        const res = await fetch(`${baseUrl}/qr`)
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type') ?? '', /image\/png/)
      } finally {
        if (savedTarget !== undefined) process.env.QR_TARGET_URL = savedTarget
        if (savedPublic !== undefined) process.env.PUBLIC_URL = savedPublic
      }
    })
  })
})
