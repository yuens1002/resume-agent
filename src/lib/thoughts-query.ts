/**
 * Query OB1 thoughts by semantic similarity.
 *
 * Two flavors:
 *  - queryRelevantThoughts(jd): for /resume — filtered to shipped enrichment
 *    facts via match_thoughts.
 *  - queryRelevantThoughtsForQuestion(question): for public /query and
 *    /public-mcp — the full non-private corpus via match_thoughts_public.
 *
 * Both fall back to [] on any error so the calling endpoint is never blocked
 * by OB1 unavailability.
 */

import { embed } from 'ai'
import { openrouter } from './ai.js'
import { supabase } from './supabase.js'

async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openrouter.embedding('openai/text-embedding-3-small'),
    value: text.slice(0, 4000), // cap to avoid token limits
  })
  return embedding
}

export async function queryRelevantThoughts(
  jd: string,
  limit = 8,
): Promise<string[]> {
  try {
    const embedding = await embedText(jd)

    const { data, error } = await supabase.rpc('match_thoughts', {
      query_embedding: embedding,
      match_threshold: 0.55,
      match_count: limit,
      filter: { status: 'shipped', source: 'enrichment' },
    })

    if (error) {
      console.warn('[thoughts-query] Supabase RPC error:', error.message)
      return []
    }

    return (data ?? []).map((row: { content: string }) => row.content)
  } catch (err) {
    console.warn('[thoughts-query] Failed (non-blocking):', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * Coarse pre-filter threshold for the question-path RPC. NOT the relevance gate:
 * fine-grained relevance judgment is the model's job per the system prompt's
 * `RULE_OBSERVATIONS_RELEVANCE` (see `src/lib/query-prompt.ts` and
 * `docs/query-engagement-rules.md`). This threshold just keeps obvious noise out
 * of the prompt. Live calibration on the corpus: on-topic questions land at
 * ~0.40–0.55, clearly off-topic at ~0.18–0.24; 0.35 catches the former with
 * margin and rejects the latter. The eval harness sweeps this value via
 * `npm run eval:query -- --threshold <n>` — change with evidence, not vibes.
 */
const DEFAULT_QUESTION_THRESHOLD = 0.35

function getQuestionThreshold(): number {
  const raw = process.env.QUERY_THOUGHTS_THRESHOLD
  if (!raw) return DEFAULT_QUESTION_THRESHOLD
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_QUESTION_THRESHOLD
  return parsed
}

/**
 * Semantic search over the full non-private thoughts corpus for a natural
 * language question. Powers the "lived experience" grounding on the public
 * /query and /public-mcp surfaces. Thoughts flagged `metadata.private = true`
 * are excluded at the database layer by match_thoughts_public.
 */
export async function queryRelevantThoughtsForQuestion(
  question: string,
  limit = 8,
): Promise<string[]> {
  try {
    const embedding = await embedText(question)

    const { data, error } = await supabase.rpc('match_thoughts_public', {
      query_embedding: embedding,
      match_threshold: getQuestionThreshold(),
      match_count: limit,
    })

    if (error) {
      console.warn('[thoughts-query] Supabase RPC error (public):', error.message)
      return []
    }

    return (data ?? []).map((row: { content: string }) => row.content)
  } catch (err) {
    console.warn('[thoughts-query] Failed (non-blocking, public):', err instanceof Error ? err.message : err)
    return []
  }
}
