/**
 * Query OB1 thoughts by semantic similarity to a job description.
 *
 * Returns attributed thought strings filtered to shipped enrichment
 * facts only. Falls back to [] on any error so resume generation
 * is never blocked by OB1 unavailability.
 */

import { embed } from 'ai'
import { openrouter } from './ai.js'
import { supabase } from './supabase.js'

export async function queryRelevantThoughts(
  jd: string,
  limit = 8,
): Promise<string[]> {
  try {
    const { embedding } = await embed({
      model: openrouter.embedding('openai/text-embedding-3-small'),
      value: jd.slice(0, 4000), // cap to avoid token limits
    })

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
