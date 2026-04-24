/**
 * Public MCP route — unauthenticated, rate-limited, single-tool surface.
 *
 * Exposes exactly one tool: `ask_candidate`. Wraps the same queryProfile /
 * queryProfileStream core used by HTTP POST /query, so prompt changes and
 * response shape stay in sync between the two surfaces.
 *
 * Transport: stateless Streamable HTTP (same pattern as private /mcp).
 * No session map, no GC, no TTL. Session IDs stripped from responses.
 *
 * Observability: every call writes a row to `observed_queries` via the
 * fire-and-forget logObservedQuery helper. Request IP (salted hash) and
 * user-agent are captured at the route boundary and closed over by the
 * tool handler — that way the tool stays pure while still recording the
 * origin metadata that abuse detection needs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'
import { z } from 'zod'
import { corsHeaders, checkOrigin } from '../lib/mcp-common.js'
import { queryProfile, queryProfileStream } from './query.js'
import { logObservedQuery } from '../lib/log-observed-query.js'

interface RequestContext {
  ip?: string
  userAgent?: string
}

function buildPublicServer(reqCtx: RequestContext): McpServer {
  const server = new McpServer({ name: 'resume-agent-public', version: '1.0.0' })

  server.registerTool(
    'ask_candidate',
    {
      title: 'Ask the Candidate',
      description:
        'Ask a natural-language question about this candidate\'s skills, experience, or background. ' +
        'Responses are grounded in the candidate\'s canonical published profile — not inferred by the calling AI. ' +
        'Use this when a recruiter, hiring manager, or screening tool needs answers about the candidate.',
      inputSchema: {
        question: z.string().describe('Natural-language question about the candidate'),
        context: z
          .string()
          .optional()
          .describe('Optional caller context: "ATS", "recruiter", "ai-agent", etc. Adjusts tone.'),
        stream: z
          .boolean()
          .optional()
          .describe('If true, the response streams progressively via MCP progress notifications.'),
      },
    },
    async ({ question, context, stream }, extra) => {
      const callerHint = context?.trim() || 'public'
      const start = Date.now()

      // MCP clients that want progress notifications pass a progressToken in
      // the request's _meta. Echo it back verbatim — clients route progress
      // events to the calling tool by matching this token. Without it, the
      // client drops our notifications as unrelated.
      const progressToken = (extra as { _meta?: { progressToken?: string | number } })._meta?.progressToken

      if (stream) {
        const streamResult = await queryProfileStream({ question, callerHint })
        if ('kind' in streamResult && streamResult.kind === 'profile_not_found') {
          return {
            content: [{ type: 'text' as const, text: 'Profile not found.' }],
            isError: true,
          }
        }

        let collected = ''
        let chunkIndex = 0
        const live = streamResult as Awaited<ReturnType<typeof queryProfileStream>>
        // The non-error variant has a textStream AsyncIterable<string>
        if ('textStream' in live) {
          for await (const chunk of live.textStream) {
            collected += chunk
            chunkIndex += 1
            if (progressToken !== undefined) {
              try {
                await extra.sendNotification?.({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: chunkIndex,
                    message: chunk,
                  },
                })
              } catch {
                // Client may not support progress notifications — continue accumulating
              }
            }
          }
        }

        void logObservedQuery({
          source: 'mcp',
          question,
          caller_hint: callerHint,
          response: { answer: collected },
          latency_ms: Date.now() - start,
          ip: reqCtx.ip,
          user_agent: reqCtx.userAgent,
        })

        return { content: [{ type: 'text' as const, text: collected }] }
      }

      const result = await queryProfile({ question, callerHint })
      if ('kind' in result) {
        const message = result.kind === 'profile_not_found'
          ? 'Profile not found.'
          : 'Failed to parse agent response.'
        return { content: [{ type: 'text' as const, text: message }], isError: true }
      }

      void logObservedQuery({
        source: 'mcp',
        question,
        caller_hint: callerHint,
        response: result,
        latency_ms: Date.now() - start,
        ip: reqCtx.ip,
        user_agent: reqCtx.userAgent,
      })

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  return server
}

// ── Routes ────────────────────────────────────────────────

const publicMcpRoute = new Hono()

// CORS preflight — no auth required
publicMcpRoute.options('*', (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr
  return c.text('ok', 200, corsHeaders)
})

// POST — stateless: fresh server + transport per request, no auth
publicMcpRoute.post('*', async (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr

  // Capture request-level metadata so the tool handler can log IP/UA without
  // needing access to Hono Context. Salted hashing happens in the logger.
  const reqCtx: RequestContext = {
    ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: c.req.header('user-agent') ?? undefined,
  }

  const server = buildPublicServer(reqCtx)
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)

  const response = await transport.handleRequest(c)
  if (!response) return c.json({ error: 'No response from MCP transport' }, 500, corsHeaders)

  // Strip any session ID the transport may emit — this server is stateless.
  response.headers.delete('mcp-session-id')

  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value)
  }
  return response
})

export default publicMcpRoute
