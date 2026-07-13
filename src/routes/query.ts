import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { supabase } from '../lib/supabase.js'
import { getModel, MODEL } from '../lib/ai.js'
import { generateText, streamText } from 'ai'
import { parseJSON, salvageTrailingSourcesBlock } from '../lib/parse-json.js'
import { detectCaller, callerContextFromQuery } from '../lib/detect-caller.js'
import { logObservedQuery } from '../lib/log-observed-query.js'
import { queryRelevantThoughtsForQuestion } from '../lib/thoughts-query.js'
import { buildSystemPrompt, deriveCandidateName, parseShownProjectSlugs, sanitizeCallerHint, sortProjectsByRecency } from '../lib/query-prompt.js'
import { isBinaryQuestion, isBehavioralQuestion, maxTokensForQuestion } from '../lib/query-classify.js'
import { classifyRoute, ROUTE_CLASSIFIER_RULE, type Route } from '../lib/route-classifier.js'
import { parseHiddenProjectSlugs, filterVisibleProjects } from '../lib/hidden-projects.js'
import { isDeclineShapedAnswer } from '../lib/decline-phrases.js'
import type { QueryResponse } from '../types.js'

const app = new Hono()

// Project slugs excluded from candidate-facing output (#176) — same env var
// and parsing as /resume (src/routes/resume.ts), shared via
// src/lib/hidden-projects.ts. Computed once at module load, mirroring
// resume.ts's HIDE_FROM_PROJECTS. Unset (the current prod default) parses to
// an empty Set, which `filterVisibleProjects` treats as a no-op.
const HIDE_FROM_PROJECTS = parseHiddenProjectSlugs(process.env.HIDE_FROM_PROJECTS)

// ── Profile cache ────────────────────────────────────────
// Profile changes at most a few times per day (via MCP or sync).
// A 5-min TTL eliminates one Supabase round-trip per request.
// Intentional tradeoff: callers may see data up to 5 minutes stale after
// a profile update. Acceptable given how infrequently the profile changes.

interface ProfileCache { data: unknown; expiresAt: number }
let profileCache: ProfileCache | null = null
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000

async function fetchProfile() {
  const now = Date.now()
  if (profileCache && now < profileCache.expiresAt) {
    return { data: profileCache.data, error: null }
  }
  const result = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()
  if (!result.error && result.data) {
    profileCache = { data: result.data, expiresAt: now + PROFILE_CACHE_TTL_MS }
  }
  return result
}

/**
 * Candidate name for scorer call sites outside the request path (the eval
 * runner). Derived from the same live profile `queryProfile` reads — never a
 * hardcoded literal (#202). Exported so `scripts/eval/run-eval.ts` can wire
 * the real name into `scoreAnswer` without duplicating the profile fetch.
 */
export async function fetchCandidateName(): Promise<string> {
  const { data: profile } = await fetchProfile()
  return deriveCandidateName(profile)
}

// ── Thoughts version cache ───────────────────────────────
// A lightweight version token for OB1 public thoughts: MAX(updated_at) across
// all thoughts rows. Changes whenever any thought is added or updated, which
// is the signal needed to invalidate observation-grounded cached responses.
// TTL: 60s — fast enough to pick up new captures within a minute.
// Note: thoughts.updated_at is not indexed by default; this query does an
// ORDER BY … LIMIT 1 which may scan/sort as the table grows. Add an
// updated_at DESC index if thoughts volume becomes large.

interface ThoughtsVersionCache { version: string; expiresAt: number }
let thoughtsVersionCache: ThoughtsVersionCache | null = null
const THOUGHTS_VERSION_TTL_MS = 60 * 1000

async function fetchThoughtsVersion(): Promise<string> {
  const now = Date.now()
  if (thoughtsVersionCache && now < thoughtsVersionCache.expiresAt) {
    return thoughtsVersionCache.version
  }
  const { data, error } = await supabase
    .from('thoughts')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    // On failure: return a volatile value so no cached response is served
    // (volatile key = cache miss on every request until the query recovers).
    // Don't persist to thoughtsVersionCache — keep retrying each request.
    return `error:${now}`
  }
  const version = (data as { updated_at?: string } | null)?.updated_at ?? ''
  thoughtsVersionCache = { version, expiresAt: now + THOUGHTS_VERSION_TTL_MS }
  return version
}

// ── Response cache ───────────────────────────────────────
// Key: JSON-encoded tuple of [normalized(question), style, callerHint[:80], profile.updated_at, thoughts_version, prompt_version]
// (JSON-encoded, not delimiter-joined — several fields can legally contain
// a plain separator character like ":", which would risk key collisions)
// Dimensions:
//   - style       — cited vs conversational changes the system prompt format
//   - callerHint  — affects tone; truncated to 80 chars to bound key size while
//                   still separating major caller types (ATS, human, interviewer)
//   - profile.updated_at — changes on every profile mutation
//   - thoughts_version   — changes on every OB1 thought add/update (60s TTL)
//   - prompt_version      — hash of the actual prompt/tool-calling source (below).
//     Nothing else in this key changes when a RULE_* constant or a tool
//     `description` changes, which let a pre-fix cached response for the exact
//     "Show recent work" starter-chip question keep serving the broken
//     open_match_tool routing from #180 well after #181/#182 shipped — the
//     process never restarted the way a deploy was assumed to guarantee.
//     Hashing the prompt source makes this dimension self-maintaining: any
//     future prompt-logic edit automatically orphans the old cache entries,
//     with no manual version bump and no dependence on process-restart timing.
// Staleness bound: max(profile cache TTL 5min, thoughts version TTL 60s) = 5min,
// PLUS instant invalidation on any prompt-logic change via prompt_version.
// Eviction: LRU (Map insertion order; get refreshes recency). Cap: 200 entries.
// Streaming path is not cached (returns a live streamText handle).

/** Pure hash over prompt-logic source strings — exported so tests can verify the mechanism without depending on real prompt content. */
export function computePromptVersion(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12)
}

const RESPONSE_CACHE_MAX = 200
const responseCache = new Map<string, import('../types.js').QueryResponse>()

export function responseCacheKey(
  question: string,
  style: string,
  callerHint: string,
  profileUpdatedAt: string,
  thoughtsVersion: string,
  promptVersion: string,
): string {
  const q = question.toLowerCase().trim().replace(/\s+/g, ' ')
  const hint = callerHint.toLowerCase().trim().slice(0, 80)
  // JSON-encode the tuple rather than joining with a delimiter (e.g. ":") —
  // several fields can legally contain that delimiter themselves
  // (callerHint, ISO timestamps in profileUpdatedAt, thoughtsVersion's
  // `error:${now}` fallback), which risks two different tuples colliding on
  // the same key string.
  return JSON.stringify([q, style, hint, profileUpdatedAt, thoughtsVersion, promptVersion])
}

// Exported alongside responseCacheKey/computePromptVersion so the "never
// serve/store an action_intent-bearing response" contract (#188) is directly
// unit-testable — seed the cache via responseCacheSet, then assert
// responseCacheGet treats it as a miss, without needing a live model call.
export function responseCacheGet(
  question: string,
  style: string,
  callerHint: string,
  profileUpdatedAt: string,
  thoughtsVersion: string,
): import('../types.js').QueryResponse | undefined {
  const key = responseCacheKey(question, style, callerHint, profileUpdatedAt, thoughtsVersion, PROMPT_VERSION)
  const value = responseCache.get(key)
  if (value === undefined) return undefined
  // Guard the read side too, not just responseCacheSet: an action_intent-bearing
  // entry can already be sitting in the Map from before this guard existed (this
  // is exactly what happened in production — see the "never cache" comment
  // below). Treat it as a miss and evict it, rather than trusting that nothing
  // was ever written that shouldn't have been.
  if (value.action_intent) {
    responseCache.delete(key)
    return undefined
  }
  // Move to end to refresh LRU recency
  responseCache.delete(key)
  responseCache.set(key, value)
  return value
}

export function responseCacheSet(
  question: string,
  style: string,
  callerHint: string,
  profileUpdatedAt: string,
  thoughtsVersion: string,
  response: import('../types.js').QueryResponse,
): void {
  const key = responseCacheKey(question, style, callerHint, profileUpdatedAt, thoughtsVersion, PROMPT_VERSION)
  if (responseCache.size >= RESPONSE_CACHE_MAX && !responseCache.has(key)) {
    const firstKey = responseCache.keys().next().value
    if (firstKey !== undefined) responseCache.delete(firstKey)
  }
  responseCache.set(key, response)
}

const schema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
  style: z.enum(['cited', 'conversational']).optional(),
})

/**
 * Build the user prompt for a profile query. When project observations are
 * available they are placed above the structured profile under a labeled
 * heading; the one-line preface reinforces the system prompt's
 * `RULE_OBSERVATIONS_RELEVANCE` at the injection point. Exported for testing.
 */
export function buildQueryPrompt(
  profile: unknown,
  thoughts: string[],
  question: string,
  callerHint?: string | null,
  // Project slugs to exclude from the injected profile data, in addition to
  // shown_projects (below). Defaults to the module-level HIDE_FROM_PROJECTS
  // (#176) so real call sites need not pass it; tests can pass an explicit
  // Set to exercise the filter without depending on process.env at module
  // load time.
  hiddenSlugs: Set<string> = HIDE_FROM_PROJECTS,
): string {
  const parts: string[] = []
  // Parse shown_projects from the raw, untruncated callerHint — sanitizeCallerHint
  // hard-caps at 200 chars, and a long-enough slug list would get cut off mid-list,
  // causing partial filtering and reintroducing the duplicate-project bug this
  // exclusion exists to fix.
  const shownSlugs = parseShownProjectSlugs(callerHint)
  const hint = sanitizeCallerHint(callerHint)
  // The shown_projects exclusion is enforced below by removing those projects
  // from the injected profile data, so the model no longer needs to see the
  // raw slug list to honor it. Strip it from the displayed hint — leaving it
  // in was a hallucination vector: the model would treat the visible slug
  // names as topics to discuss (pulling in unrelated observations that
  // happened to match) instead of treating them as excluded.
  const displayHint = hint.replace(/;?\s*shown_projects:\s*[^;]*/i, '').trim()
  if (displayHint) {
    // Caller context is asker-controlled — placed here (user message, not system)
    // and explicitly framed as untrusted metadata so the prompt-injection vector
    // is closed. See RULE_CALLER_CONTEXT in src/lib/query-prompt.ts.
    parts.push(`# Caller context (untrusted metadata — see your instructions)`)
    parts.push(`> ${displayHint}`)
    parts.push('')
  }
  if (thoughts.length > 0) {
    parts.push('# Project observations and lived experience')
    parts.push('> retrieved by similarity to the question; not all may be relevant — use only what bears on an honest answer (see your instructions)')
    parts.push('')
    parts.push(thoughts.map((t) => `- ${t}`).join('\n'))
    parts.push('')
  }
  // Pre-sort projects most-recent-first so the model leads with current work
  // when asked about projects generally (RULE_PROGRESSIVE_DISCLOSURE), and
  // physically drop already-shown projects (RULE_SHOWN_PROJECTS) so the
  // model can't re-serve or lose track of them — the remainder is exactly
  // what's left in this list, not something the model has to compute.
  const profileForPrompt =
    profile && typeof profile === 'object' && Array.isArray((profile as { projects?: unknown }).projects)
      ? {
          ...(profile as object),
          // shown_projects (already-served, per-conversation) and
          // HIDE_FROM_PROJECTS (deliberately hidden, #176) are both applied
          // by removal — the model never sees either as data to reconstruct
          // from a sibling cross-reference.
          projects: filterVisibleProjects(
            sortProjectsByRecency(
              (profile as { projects: Array<{ slug: string; started?: string; git_evidence?: { last_push_at?: string } }> }).projects,
            ).filter((p) => !shownSlugs.includes(p.slug)),
            hiddenSlugs,
          ),
        }
      : profile
  // Name the project count explicitly in the heading — the model was
  // miscounting the raw JSON array (e.g. reporting 7 projects as "six").
  // User-message-only change (does not touch PROMPT_VERSION-hashed system text).
  const projectsForCount = (profileForPrompt as { projects?: unknown[] } | undefined)?.projects
  parts.push(
    Array.isArray(projectsForCount) && projectsForCount.length > 0
      ? `# Profile data (${projectsForCount.length} projects)`
      : '# Profile data',
  )
  parts.push(JSON.stringify(profileForPrompt, null, 2))
  parts.push('')
  parts.push('# Question')
  parts.push(question)
  return parts.join('\n')
}

// ── Action-intent routing (#195) ─────────────────────────────
//
// Routing used to be an AI SDK tool exposed during answer generation (#174):
// the model both answered the question AND decided whether to open the
// job-match/résumé-tailoring flow, read back from `toolCalls`. That let the
// routing rule compete with ~15k chars of unrelated answer-generation
// instructions and misfired on capability questions ("what projects
// demonstrate the candidate's understanding of AI engineering?" → tool, #194) even
// though the rule's literal text didn't apply. It's replaced by a dedicated
// classifier pre-pass — classifyRoute() in ../lib/route-classifier.ts — that
// runs BEFORE generateText and decides the route from a closed two-value
// enum. The 'narrate' route never receives a tool at all, so there is
// nothing left for a routing rule to misfire against during generation.

// Response-cache versioning dimension (see the "Response cache" section
// above) — computed once at module load from the actual prompt/routing-rule
// source, not maintained by hand. Any edit to a RULE_* constant or the
// classifier's rule text automatically changes this value.
//
// Known, accepted deviation (#202 profile-name decoupling): this call uses
// `buildSystemPrompt`'s default (token) candidate-name argument because the
// profile is fetched from Supabase asynchronously and isn't available at
// module-load time — see `buildSystemPrompt`'s own doc comment in
// query-prompt.ts. That means this hash's *value* differs from pre-#202
// main (which baked the literal name directly into the rule constants),
// even though the served prompt (built per-request with the derived name via
// `deriveCandidateName`) is byte-identical to main for the live profile. This
// is harmless: PROMPT_VERSION only keys the per-process in-memory response
// cache, which is already empty after every deploy, and profile-name changes
// are independently covered by the `profileUpdatedAt` cache dimension. Signed
// off as an accepted one-time cache-key value change, not a behavior change.
const PROMPT_VERSION = computePromptVersion(
  buildSystemPrompt('json', 'cited'),
  buildSystemPrompt('json', 'conversational'),
  ROUTE_CLASSIFIER_RULE,
)

/**
 * Pull OpenRouter's `provider` field out of a `generateText` result's raw
 * `response` (an OpenRouter-specific extension of the OpenAI-compatible
 * response body, not part of the AI SDK's own typed shape — hence the
 * defensive unknown-narrowing rather than a direct property access). Pure
 * and exported for unit testing without a live model call; see #189.
 */
export function extractProvider(modelResponse: unknown): string | undefined {
  const body = (modelResponse as { body?: unknown } | undefined)?.body
  const provider = (body as { provider?: unknown } | undefined)?.provider
  return typeof provider === 'string' ? provider : undefined
}

/**
 * Whether a computed `/query` response is safe to cache. `open_match_tool`'s
 * routing decision is a model judgment call, not perfectly deterministic
 * (#188/#189) — caching a response that carries an `action_intent` risks
 * freezing a single bad (or good) roll and serving it to every subsequent
 * visitor asking the same question, until something else invalidates the
 * entry. Extracted to a named predicate so the "never cache this class of
 * response" contract is unit-testable in isolation.
 */
export function shouldCacheResponse(response: Pick<QueryResponse, 'action_intent'>): boolean {
  return !response.action_intent
}

/** Minimal shape `generateWithLengthRetry` needs from a `generateText` call — kept
 * loose (not the full AI SDK result type) so the helper is unit-testable with
 * plain stub functions instead of a live model call. */
export interface LengthRetryResult {
  text: string
  finishReason: string
  response: unknown
}

/**
 * Calls `callFn` once at `cap` maxTokens. If the model truncated the answer
 * (`finishReason === 'length'`), retries ONCE at `min(cap * 2, 2048)` maxTokens
 * — same prompt/system/model, whatever `callFn` closes over — and returns the
 * retry's result regardless of its own finishReason (no further retries).
 * A truncated mid-sentence answer is bad; a second truncated answer is a
 * signal the question itself needs a real cap increase, not more retries.
 * Single call (no retry) when the first result already finished cleanly.
 */
export async function generateWithLengthRetry(
  callFn: (maxTokens: number) => Promise<LengthRetryResult>,
  cap: number,
): Promise<LengthRetryResult> {
  const first = await callFn(cap)
  if (first.finishReason !== 'length') return first
  const retryCap = Math.min(cap * 2, 2048)
  return callFn(retryCap)
}

// ── Shared core ─────────────────────────────────────────────
//
// queryProfile / queryProfileStream are pure functions — no Hono Context,
// no framework deps. Called by both the HTTP /query handler below and the
// ask_candidate MCP tool in public-mcp.ts.

export interface QueryProfileArgs {
  question: string
  callerHint: string
  style?: 'cited' | 'conversational'
}

export interface ProfileNotFoundError {
  kind: 'profile_not_found'
}

export interface ParseError {
  kind: 'parse_error'
  raw: string
}

/** Non-streaming query — returns a structured QueryResponse or a typed error. */
export async function queryProfile(
  args: QueryProfileArgs,
): Promise<QueryResponse | ProfileNotFoundError | ParseError> {
  // Fetch profile + OB1 version token in parallel — both are in-process cached
  // and usually synchronous; parallel fetch keeps cold-start cost minimal.
  const [{ data: profile, error }, thoughtsVersion] = await Promise.all([
    fetchProfile(),
    fetchThoughtsVersion(),
  ])
  if (error || !profile) return { kind: 'profile_not_found' }

  const profileUpdatedAt = (profile as { updated_at?: string }).updated_at ?? ''

  const style = args.style ?? 'cited'

  // Response cache check — all question types. Key covers both data dimensions
  // plus style and callerHint to prevent cross-caller response bleed.
  // On hit: skip retrieval + LLM entirely; stamp fresh meta.
  const cached = responseCacheGet(args.question, style, args.callerHint, profileUpdatedAt, thoughtsVersion)
  if (cached) return { ...cached, meta: { ...cached.meta, latency_ms: 0, retrieval_ms: 0 } }

  // Retrieval — only on cache miss, skipped entirely for binary questions.
  // Classifier pre-pass (#195) runs IN PARALLEL with retrieval — the two are
  // independent, so wiring in the pre-pass adds ~0 wall-clock. On classifier
  // error, fall back to 'narrate' (the safe default; classifyRoute's own doc
  // comment makes the caller responsible for this decision).
  const skipThoughts = isBinaryQuestion(args.question)
  // Both branches start immediately and time themselves, but only the
  // classifier is awaited up front: the tool-route short-circuit below must
  // not be latency-gated by retrieval work it would discard (retrieval p95
  // ~1.5s). The narrate path awaits retrieval right after the route check,
  // so it still gets full parallelism. Retrieval never rejects
  // (queryRelevantThoughtsForQuestion falls back to [] internally), so the
  // floating promise on the tool path is safe to abandon.
  const retrievalPromise = (async (): Promise<[string[], number]> => {
    if (skipThoughts) return [[], 0]
    const t0 = Date.now()
    const t = await queryRelevantThoughtsForQuestion(args.question)
    return [t, Date.now() - t0]
  })()
  const [route, classify_ms] = await (async (): Promise<[Route, number]> => {
    const t0 = Date.now()
    try {
      const r = await classifyRoute(args.question)
      return [r, Date.now() - t0]
    } catch (err) {
      console.warn('[query] classifyRoute failed — falling back to narrate:', (err as Error).message)
      return ['narrate', Date.now() - t0]
    }
  })()

  if (route === 'open_match_tool') {
    // Deterministic short-circuit — no generateText call at all, and the
    // still-running retrieval promise is abandoned unawaited (it never
    // rejects, see above), so this path's latency is the classifier call
    // alone. Keeps the /query response shape fully backward-compatible
    // (resume-agent-web keeps reading action_intent exactly as before).
    // Never cached (see shouldCacheResponse below) — this branch returns
    // before reaching the cache-set call.
    return {
      answer: 'Opening the job-fit tool now.',
      confidence: 'high',
      sources: [],
      follow_up_suggestions: [],
      project_slugs: [],
      action_intent: { tool: 'open_match_tool' },
      fit_question: false,
      contact: {
        email: profile.contact?.email,
        calendly: profile.contact?.calendly,
      },
      meta: { model: MODEL, latency_ms: classify_ms },
    }
  }

  const [thoughts, retrieval_ms] = await retrievalPromise

  const prompt = buildQueryPrompt(profile, thoughts, args.question, args.callerHint)

  const cap = maxTokensForQuestion(args.question, args.style ?? 'cited', route === 'narrate_fit')
  const start = Date.now()
  const { text: raw, finishReason, response: modelResponse } = await generateWithLengthRetry(
    (maxTokens) =>
      generateText({
        model: getModel(),
        maxTokens,
        system: buildSystemPrompt('json', style, deriveCandidateName(profile)),
        prompt,
      }),
    cap,
  )
  const latency_ms = Date.now() - start
  const provider = extractProvider(modelResponse)

  let parsed: Pick<QueryResponse, 'answer' | 'confidence' | 'sources' | 'follow_up_suggestions'> & { project_slugs?: string[] }
  try {
    parsed = parseJSON(raw)
  } catch (err) {
    console.error('[query] parse_error:', err, '— finishReason:', finishReason, '— raw (first 500 chars):', raw.slice(0, 500))
    return { kind: 'parse_error', raw }
  }

  // parseJSON casts without runtime validation — guard so a valid-JSON but
  // wrong-shape response (non-string answer) can't turn the salvage into an
  // unhandled throw; it flows on to the same downstream handling as before.
  if (typeof parsed.answer === 'string') {
    parsed.answer = salvageTrailingSourcesBlock(raw, parsed.answer)

    // #215: the v2 contract is "the decline is the answer; no follow-up
    // offers" for off-topic/no-data declines, but that's prompt-only
    // guidance and the model doesn't reliably comply for the no-data case
    // (its sibling gap examples — binary, capability — are worked with
    // non-empty follow_up_suggestions). Enforce it deterministically rather
    // than editing the prompt, which has a history of displacing unrelated
    // behavior when touched.
    //
    // Gated on an empty sources array (review fix, PR #217): a decline
    // phrase alone isn't sufficient — a legitimate capability-gap answer
    // ("does not appear to have direct AWS experience, but ... [1]") can
    // contain the same substring while citing sources and legitimately
    // wanting its follow-up kept. True off-topic/no-data declines carry no
    // sources; a citation-backed gap answer does.
    if (isDeclineShapedAnswer(parsed.answer) && (parsed.sources?.length ?? 0) === 0) {
      parsed.follow_up_suggestions = []
    }
  }

  const response: QueryResponse = {
    ...parsed,
    project_slugs: parsed.project_slugs ?? [],
    action_intent: null,
    // narrate_fit answers identically to narrate — the flag is the only
    // difference, and it's what the frontend's follow-up chip keys on (#199).
    fit_question: route === 'narrate_fit',
    contact: {
      email: profile.contact?.email,
      calendly: profile.contact?.calendly,
    },
    meta: { model: MODEL, latency_ms, retrieval_ms, provider, finish_reason: finishReason },
  }

  // Cache — key covers all prompt dimensions (question, style, callerHint,
  // profile version, OB1 version, prompt version). EXCEPT: never cache a
  // response that carries an action_intent. open_match_tool's routing
  // decision is a model judgment call, not perfectly deterministic — a
  // single unlucky (or lucky) roll caching itself here would freeze that
  // one outcome and serve it to every subsequent visitor asking the same
  // question, until something else invalidates the entry. Recomputing
  // every time trades a latency win for correctness on exactly the
  // decision where a stuck wrong answer does the most damage (redirecting,
  // or failing to redirect, every visitor to the job-fit flow).
  if (shouldCacheResponse(response)) {
    responseCacheSet(args.question, style, args.callerHint, profileUpdatedAt, thoughtsVersion, response)
  }

  return response
}

/** Streaming variant — returns the streamText result for caller-controlled consumption. */
export async function queryProfileStream(
  args: QueryProfileArgs,
): Promise<ReturnType<typeof streamText> | ProfileNotFoundError> {
  const skipThoughts = isBinaryQuestion(args.question)
  const [{ data: profile, error }, thoughts] = await Promise.all([
    fetchProfile(),
    skipThoughts ? Promise.resolve([]) : queryRelevantThoughtsForQuestion(args.question),
  ])

  if (error || !profile) {
    return { kind: 'profile_not_found' }
  }

  const prompt = buildQueryPrompt(profile, thoughts, args.question, args.callerHint)

  return streamText({
    model: getModel(),
    maxTokens: maxTokensForQuestion(args.question, args.style ?? 'cited'),
    system: buildSystemPrompt('stream', args.style ?? 'cited', deriveCandidateName(profile)),
    prompt,
  })
}

// ── HTTP wrapper ────────────────────────────────────────────

function deriveCallerHint(c: Context, question: string, context: string | undefined): string {
  const headerCaller = detectCaller(c)
  const queryCaller = callerContextFromQuery(question)
  const caller = headerCaller.type !== 'unknown'
    ? headerCaller
    : { ...headerCaller, ...queryCaller }
  return (context?.trim() || undefined) ?? caller.hint
}

function deriveStyle(
  explicitStyle: 'cited' | 'conversational' | undefined,
): 'cited' | 'conversational' {
  if (explicitStyle) return explicitStyle
  // 'conversational' style used to default here for 'human' callers (a
  // shorter, citation-marker-free prose format for the chat UI). Removed:
  // that specific combination (conversational style + the real 'human'
  // caller-hint) was the one reliably reproducible open_match_tool
  // misfire found in #191's investigation — 'cited' style has never shown
  // this failure anywhere it's used (public-mcp, ATS, recruiter,
  // hiring-manager, personal-ai). resume-agent-web's sanitizeAnswer()
  // already strips [N] markers and the Sources: block unconditionally
  // (lib/answer.ts), so switching the default doesn't change what a
  // visitor actually sees — only the model's internal reliability.
  return 'cited'
}

async function handleQuery(
  c: Context,
  question: string,
  context: string | undefined,
  stream: boolean,
  style?: 'cited' | 'conversational',
): Promise<Response> {
  const callerHint = deriveCallerHint(c, question, context)
  const effectiveStyle = deriveStyle(style)
  const requestIp = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  const userAgent = c.req.header('user-agent')
  const overallStart = Date.now()

  if (stream) {
    // Conversational mode relies on the JSON sources[] array; stream returns plain text with no
    // JSON envelope, so conversational attribution cannot be emitted. Fall back to cited.
    const result = await queryProfileStream({ question, callerHint, style: 'cited' })
    if ('kind' in result && result.kind === 'profile_not_found') {
      return c.json({ error: 'Profile not found' }, 404)
    }

    // Tee the stream: forward bytes to the client, collect text for post-hoc logging.
    const live = result as ReturnType<typeof streamText>
    const response = live.toTextStreamResponse()
    const original = response.body
    if (!original) return response

    const [toClient, forLogging] = original.tee()

    // Collect the logging branch in the background (fire-and-forget)
    ;(async () => {
      const reader = forLogging.getReader()
      const decoder = new TextDecoder()
      let collected = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        collected += decoder.decode(value, { stream: true })
      }
      collected += decoder.decode()
      await logObservedQuery({
        source: 'http',
        question,
        caller_hint: callerHint,
        response: { answer: collected },
        latency_ms: Date.now() - overallStart,
        ip: requestIp,
        user_agent: userAgent,
      })
    })().catch((err) => {
      console.warn('[query] background streaming log failed:', (err as Error).message)
    })

    return new Response(toClient, response)
  }

  const result = await queryProfile({ question, callerHint, style: effectiveStyle })

  if ('kind' in result) {
    if (result.kind === 'profile_not_found') return c.json({ error: 'Profile not found' }, 404)
    return c.json({ error: 'Failed to parse agent response' }, 500)
  }

  // Fire-and-forget logging (never throws)
  void logObservedQuery({
    source: 'http',
    question,
    caller_hint: callerHint,
    response: result,
    latency_ms: Date.now() - overallStart,
    ip: requestIp,
    user_agent: userAgent,
  })

  c.header('Cache-Control', 'no-store')
  return c.json(result)
}

// ── Routes ──────────────────────────────────────────────────

app.get('/', async (c) => {
  const rawQuestion = c.req.query('question')
  if (rawQuestion !== undefined) {
    const parsedInput = schema.safeParse({ question: rawQuestion, context: c.req.query('context') })
    if (!parsedInput.success) {
      return c.json({ error: 'Invalid query', details: parsedInput.error.format() }, 400)
    }
    const stream = c.req.query('stream') === 'true'
    return handleQuery(c, parsedInput.data.question, parsedInput.data.context, stream)
  }
  const url = new URL(c.req.url)
  return c.json({
    endpoint: url.pathname,
    method: 'POST',
    also_supports: 'GET ?question=',
    description: 'Ask a natural language question about this candidate.',
    body: {
      question: 'string (required)',
      context: 'string (optional, e.g. "ATS", "recruiter", "ai-agent")',
      stream: 'boolean (optional, default false)',
    },
    response: {
      when_stream_false: 'application/json — { answer, confidence, sources, follow_up_suggestions, contact, meta }',
      when_stream_true: 'text/plain — streamed plain text chunks; response body is not JSON in this mode',
    },
    get_usage: 'GET /query?question=Your+question+here&stream=true',
    example: { question: 'What is your experience with TypeScript?', stream: false },
    example_streaming: { question: 'What is your experience with TypeScript?', stream: true },
  })
})

app.post('/', zValidator('json', schema.extend({ stream: z.boolean().optional() })), async (c) => {
  const { question, context, stream, style } = c.req.valid('json')
  return handleQuery(c, question, context, stream ?? false, style)
})

export default app
