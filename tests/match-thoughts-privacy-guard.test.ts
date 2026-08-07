/**
 * #235 — the default semantic-search RPC must be privacy-safe, and the only
 * unguarded one must be named so a public caller cannot reach it by accident.
 *
 * Static assertions over the migration SQL and the call sites, matching the
 * existing style in thoughts-grounded-query.test.ts (AC-1/AC-2). No database
 * and no model call, so these run in the unit suite.
 *
 * The regression these lock down: `match_thoughts` had no privacy clause while
 * backing `queryRelevantThoughts`, which serves both POST /query and POST /resume.
 * Nothing leaked only because that caller's `source: 'enrichment'` filter happens
 * to select a single public producer — an emergent property, not a boundary.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8')

const GUARD = `not (t.metadata @> '{"private": true}'::jsonb)`
const migration = read('supabase', 'migrations', '20260804000000_match_thoughts_privacy_guard.sql')

/** Body of one `create or replace function <name>(…) … $$;` block. */
function functionBody(sql: string, name: string): string {
  const start = sql.search(new RegExp(`create or replace function ${name}\\s*\\(`, 'i'))
  assert.notEqual(start, -1, `expected a definition for ${name}`)
  const end = sql.indexOf('$$;', start)
  assert.notEqual(end, -1, `expected ${name} to terminate with $$;`)
  return sql.slice(start, end)
}

describe('#235 migration — match_thoughts is guarded by default', () => {
  it('redefines match_thoughts', () => {
    assert.match(migration, /create or replace function match_thoughts\s*\(/i)
  })

  it('carries the index-friendly privacy guard (JSONB containment, not a text cast)', () => {
    const body = functionBody(migration, 'match_thoughts')
    assert.ok(body.includes(GUARD), 'expected the `@>` containment exclusion for private thoughts')
    assert.ok(!/->>\s*'private'/.test(body), 'should not use a ->> text cast — it defeats the GIN index')
  })

  it('keeps the original signature so existing callers are unaffected', () => {
    const body = functionBody(migration, 'match_thoughts')
    for (const param of ['query_embedding', 'match_threshold', 'match_count', 'filter']) {
      assert.ok(body.includes(param), `expected ${param} to survive the redefinition`)
    }
    assert.ok(body.includes('match_threshold float default 0.7'), 'default threshold must not drift')
    assert.ok(body.includes('match_count int default 10'), 'default count must not drift')
  })
})

describe('#235 migration — match_thoughts_owner is the named exception', () => {
  it('defines match_thoughts_owner', () => {
    assert.match(migration, /create or replace function match_thoughts_owner\s*\(/i)
  })

  it('is deliberately unguarded — the owner surface must see private thoughts', () => {
    const body = functionBody(migration, 'match_thoughts_owner')
    assert.ok(!body.includes(GUARD), 'match_thoughts_owner must NOT filter private thoughts')
  })

  it('documents that it is owner-only, so the exception is legible at the definition', () => {
    assert.match(migration, /never call this from a public surface/i)
  })
})

describe('#235 call sites — only the private MCP reads unguarded', () => {
  const mcp = read('src', 'routes', 'mcp.ts')
  const thoughtsQuery = read('src', 'lib', 'thoughts-query.ts')

  it('the private MCP calls match_thoughts_owner', () => {
    assert.ok(mcp.includes(`rpc('match_thoughts_owner'`), 'private MCP should read the unguarded RPC')
  })

  it('no public-surface helper calls match_thoughts_owner', () => {
    assert.ok(
      !thoughtsQuery.includes('match_thoughts_owner'),
      'thoughts-query.ts serves /query and /resume — it must never reach the unguarded RPC',
    )
  })

  it('queryRelevantThoughts still uses match_thoughts, which now carries the guard', () => {
    assert.ok(thoughtsQuery.includes(`rpc('match_thoughts'`), 'expected the guarded default RPC')
  })

  it('privacy no longer rests on the source filter alone', () => {
    // The filter stays for relevance — it just is not the thing keeping private
    // rows out any more. Per #234, `source` has already been silently wrong once.
    assert.ok(
      thoughtsQuery.includes(`source: 'enrichment'`),
      'the relevance filter is expected to remain; the guard is now independent of it',
    )
  })
})
