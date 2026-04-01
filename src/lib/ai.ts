import './env.js'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
if (!OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY')

export const MODEL = process.env.AI_MODEL ?? 'anthropic/claude-haiku-4-5-20251001'

export const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_API_KEY,
})

export function getModel(modelOverride?: string): LanguageModel {
  return openrouter(modelOverride ?? MODEL)
}
