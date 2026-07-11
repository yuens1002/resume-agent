import { config } from 'dotenv'
config({ path: '.env.local' })
// Key isolation (#201): eval runs prefer the dedicated eval key so a burn
// can never exhaust the production key's monthly cap again. dotenv never
// overwrites already-set vars, so ai.ts's own `import './env.js'` is a
// no-op after this — the override below is what ai.ts's client reads.
if (process.env.OPENROUTER_API_KEY_EVAL) process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY_EVAL
