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
      // Lower than the JD path's 0.55: a short question embeds less richly than
      // a full job description, so on-topic thoughts land around 0.40–0.55
      // while clearly off-topic questions sit at ~0.18–0.24. 0.35 catches the
      // former with margin and rejects the latter.
      match_threshold: 0.35,
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
