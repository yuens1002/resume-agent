import './env.js'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { google } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'

const PROVIDER = process.env.AI_PROVIDER ?? 'anthropic'
const MODEL = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001'

export function getModel(): LanguageModel {
  switch (PROVIDER) {
    case 'openai':
      return openai(MODEL)
    case 'google':
      return google(MODEL)
    case 'anthropic':
    default:
      return anthropic(MODEL)
  }
}

export { PROVIDER, MODEL }
