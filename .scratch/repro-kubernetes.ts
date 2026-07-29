// Scratch repro for #197 capability-kubernetes — replicates queryProfile's
// exact generateText call at the new 512 binary cap and prints the FULL raw
// so we can see where (if anywhere) the Sources block lands.
// Run from repo root: npx tsx .scratch/repro-kubernetes.ts
import '../scripts/eval/eval-env.js'
import { generateText } from 'ai'
import { getModel } from '../src/lib/ai.js'
import { supabase } from '../src/lib/supabase.js'
import { buildSystemPrompt } from '../src/lib/query-prompt.js'
import { buildQueryPrompt } from '../src/routes/query.js'
import { maxTokensForQuestion, isBinaryQuestion } from '../src/lib/query-classify.js'

const question = 'Have you run Kubernetes in production?'

async function main() {
  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()
  if (error || !profile) throw new Error('profile fetch failed: ' + error?.message)

  const cap = maxTokensForQuestion(question, 'cited')
  console.log('isBinary:', isBinaryQuestion(question), 'maxTokens:', cap)

  const prompt = buildQueryPrompt(profile, [], question, 'Unknown caller. Balance structure and readability. Be honest and direct.')

  const { text: raw, finishReason, usage } = await generateText({
    model: getModel(),
    maxTokens: cap,
    system: buildSystemPrompt('json', 'cited'),
    prompt,
  })
  console.log('finishReason:', finishReason)
  console.log('usage:', JSON.stringify(usage))
  console.log('--- FULL RAW ---')
  console.log(raw)
}

main()
