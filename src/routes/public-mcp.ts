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
import { MODEL } from '../lib/ai.js'
import { queryProfile, queryProfileStream } from './query.js'
import { logObservedQuery } from '../lib/log-observed-query.js'
import { fetchProfile } from '../lib/profile-cache.js'
import type { QueryResponse } from '../types.js'

interface RequestContext {
  ip?: string
  userAgent?: string
}

// ── Surface-capability mapping for action_intent (#183/#195) ────────────
//
// The classifier detects caller-agnostic intent; the surface decides the
// action (#195 design). resume-agent-web can open the job-fit/résumé-
// tailoring tool client-side. MCP/API callers (this route) have no UI to act
// on `action_intent` at all — leaving it set would hand them
// "Opening the job-fit tool now." with nothing to open (#183). Narrate a
// pointer to the interactive flow instead, with a URL when the profile
// publishes one.

/**
 * Rewrite a `QueryResponse` that carries a non-null `action_intent` into a
 * narrated pointer at the interactive flow, for surfaces (MCP/API) that
 * cannot open the tool themselves. Passes through unchanged when
 * `action_intent` is already null. Pure and exported for unit testing
 * without a live queryProfile call.
 */
export function narrateActionIntentForSurface(
  response: QueryResponse,
  profileUrl?: string,
): QueryResponse {
  if (!response.action_intent) return response
  const pointer = profileUrl
    ? `The interactive résumé and job-fit flow is available at ${profileUrl} — it can generate a tailored résumé against a specific job description.`
    : `The interactive résumé and job-fit flow is available on the candidate's site — it can generate a tailored résumé against a specific job description.`
  return {
    ...response,
    action_intent: null,
    answer: pointer,
  }
}

/** Best-effort lookup of the profile's published website URL, for the narrated pointer above. */
async function fetchProfileWebsiteUrl(): Promise<string | undefined> {
  const result = await fetchProfile()
  if (result.kind !== 'ok') return undefined
  return (result.profile as { contact?: { website?: string } }).contact?.website
}

/**
 * The single tool this server exposes. Shared between the MCP registration and
 * the GET descriptor (#223) so the two cannot drift: a descriptor that
 * advertises a tool name the server doesn't register is worse than the 404 the
 * descriptor replaced, because it fails at call time instead of at discovery.
 */
export const PUBLIC_TOOL_NAME = 'ask_candidate'

function buildPublicServer(reqCtx: RequestContext): McpServer {
  const server = new McpServer({ name: 'resume-agent-public', version: '1.0.0' })

  server.registerTool(
    PUBLIC_TOOL_NAME,
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
          .describe(
            'Optional caller context: "ATS", "recruiter", "ai-agent", etc. Adjusts tone. ' +
            'To follow up on a prior response and see remaining projects, append "; shown_projects: slug1, slug2" ' +
            'using the project_slugs from the previous response — the answer will cover only projects not already shown.',
          ),
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
        // `extra.signal` is the MCP request's cancellation signal (@hono/mcp
        // forwards the HTTP request's abort into the transport). Threading it
        // gives this surface the same property the HTTP one has: a client that
        // cancels stops the generation instead of leaving it to run to
        // completion and be billed.
        const streamResult = await queryProfileStream({ question, callerHint, abortSignal: extra.signal })
        if ('kind' in streamResult) {
          const message = streamResult.kind === 'profile_not_found'
            ? 'Profile not found.'
            : 'Profile temporarily unavailable — retry shortly.'
          return {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          }
        }

        let collected = ''
        let chunkIndex = 0
        // Chunks arrive already publication-normalized (#251) — queryProfileStream
        // runs the citation pass as a transform over the token stream, so the
        // progress notifications, the final tool result, and the logged row all
        // carry `publications.<slug> — <url>` rather than the model's raw
        // `publications[0]`.
        for await (const chunk of streamResult.textStream) {
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

        void logObservedQuery({
          source: 'mcp',
          question,
          caller_hint: callerHint,
          // Same reasoning as the HTTP stream path: ai@4 closes the stream
          // normally on a provider error, so without finish_reason a truncated
          // answer is logged as if it were complete. Read synchronously after
          // the loop — awaiting the SDK's own promise here never settled on a
          // provider error and hung this handler until the client timed out.
          // `latency_ms` here is wall-clock, not the generation span.
          response: {
            answer: collected,
            meta: {
              model: MODEL,
              latency_ms: Date.now() - start,
              finish_reason: streamResult.finishReason(),
            },
          },
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
          : result.kind === 'profile_unavailable'
            ? 'Profile temporarily unavailable — retry shortly.'
            : 'Failed to parse agent response.'
        return { content: [{ type: 'text' as const, text: message }], isError: true }
      }

      // MCP has no UI surface to open the job-fit tool — narrate a pointer
      // instead of handing back a dead-end "Opening the tool now." (#183).
      // Only fetch the profile URL on this rare path, not on every call.
      const surfaceResult = result.action_intent
        ? narrateActionIntentForSurface(result, await fetchProfileWebsiteUrl())
        : result

      // Log the PRE-mapping result: observed_queries.action_intent must
      // record what the classifier decided (#195's monitoring loop), not the
      // surface rewrite — logging surfaceResult would null the routing
      // signal on exactly this surface.
      void logObservedQuery({
        source: 'mcp',
        question,
        caller_hint: callerHint,
        response: result,
        latency_ms: Date.now() - start,
        ip: reqCtx.ip,
        user_agent: reqCtx.userAgent,
      })

      return { content: [{ type: 'text' as const, text: JSON.stringify(surfaceResult) }] }
    },
  )

  return server
}

// ── Routes ────────────────────────────────────────────────

const publicMcpRoute = new Hono()

/**
 * This route answers GET as well as POST (the #223 descriptor below), so its
 * preflight has to say so. The shared `corsHeaders` block is left alone because
 * the private `/mcp` surface it also serves really is POST-only — advertising a
 * method there that 404s would trade one wrong signal for another.
 *
 * This block is set on every response from this route, but the added `GET` only
 * ever *means* anything on the preflight: `Access-Control-Allow-Methods` is
 * read by the browser from the OPTIONS response, and is inert on the descriptor
 * and 405 responses that also carry it. A plain descriptor fetch is a CORS
 * "simple request" and is never preflighted at all.
 */
const publicCorsHeaders = {
  ...corsHeaders,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
} as const

// CORS preflight — no auth required
publicMcpRoute.options('*', (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr
  return c.text('ok', 200, publicCorsHeaders)
})

/**
 * The self-descriptor served to a GET (#223). Names the transport, the single
 * tool, and its argument shape, so an agent that fetches the advertised URL to
 * learn how to call it gets an answer instead of a bare 404.
 *
 * Kept beside the tool registration above deliberately: if `ask_candidate`'s
 * arguments change, both the schema and this description need the edit, and
 * they are two screens apart rather than two files apart.
 */
function buildDescriptor(pathname: string): Record<string, unknown> {
  return {
    endpoint: pathname,
    method: 'POST',
    transport: 'MCP (Model Context Protocol) over HTTP — Streamable HTTP, stateless. No session is established; every request is self-contained and no mcp-session-id is issued.',
    protocol: 'JSON-RPC 2.0',
    description: 'Ask a natural-language question about this candidate. Answers are grounded in the candidate\'s canonical published profile — not inferred by the calling model.',
    auth: 'none required — this endpoint is public',
    // Scoped to unauthenticated callers on purpose: the global middleware lets
    // a valid owner API key bypass the bucket, and every caller who can read
    // this descriptor is by definition in the unauthenticated case. Stating a
    // flat "30/min, no exceptions" would be inaccurate; spelling out the bypass
    // would advertise it to exactly the audience that shouldn't be probing for
    // it. Naming the scope is both true and useful.
    rate_limit: '30 requests per minute per IP for unauthenticated callers',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    tools: [
      {
        name: PUBLIC_TOOL_NAME,
        description: 'Ask a natural-language question about this candidate\'s skills, experience, or background.',
        arguments: {
          question: 'string (required) — natural-language question about the candidate',
          context: 'string (optional) — caller context, e.g. "ATS", "recruiter", "ai-agent". Adjusts tone.',
          stream: 'boolean (optional, default false) — stream the answer via MCP progress notifications',
        },
      },
    ],
    example: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: PUBLIC_TOOL_NAME,
        arguments: { question: 'What is the candidate\'s experience with TypeScript?' },
      },
    },
    // A crawler that can't speak JSON-RPC still has a way in.
    related: {
      same_answers_over_plain_http: 'POST /query',
      machine_schema: 'GET /openapi.json',
    },
  }
}

/**
 * GET /public-mcp — descriptor for crawlers, 405 for MCP clients (#223).
 *
 * `llms.txt` advertises this URL and `robots.txt` invites crawlers, so it gets
 * fetched with a GET; it used to answer with a bare 13-byte `404 Not Found`
 * (Google Search Console logged it as such). Two different callers issue that
 * GET, and they want opposite answers:
 *
 *   - A crawler or a human pasting the URL wants to know what lives here → 200
 *     with the self-descriptor, matching what `GET /query` returns.
 *   - A real MCP client sending `Accept: text/event-stream` is trying to open
 *     the server→client SSE stream of Streamable HTTP. This server is stateless
 *     and offers no such stream, and the MCP spec says a server that doesn't
 *     SHOULD answer that GET with `405 Method Not Allowed`. Handing it a 200
 *     `application/json` body instead would be a worse signal than the 404 it
 *     used to get.
 *
 * So the Accept header decides, and each caller gets the answer its protocol
 * expects. The 405 still carries the descriptor as its body — there is no
 * reason to make it less informative than the 200.
 */
publicMcpRoute.get('*', (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr

  const descriptor = buildDescriptor(new URL(c.req.url).pathname)
  const wantsSse = (c.req.header('accept') ?? '').toLowerCase().includes('text/event-stream')

  if (wantsSse) {
    return c.json(
      {
        ...descriptor,
        error: 'Method Not Allowed — this MCP server is stateless and does not offer a GET SSE stream. Send JSON-RPC requests as POST.',
      },
      405,
      { ...publicCorsHeaders, Allow: 'POST' },
    )
  }

  c.header('Cache-Control', 'public, max-age=3600')
  return c.json(descriptor, 200, publicCorsHeaders)
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
