/**
 * computeAuthzCodeSecretObservability (src/routes/oauth.ts) — offline, no
 * live server required.
 *
 * Temporary, for issue #273: asserts the actual present/matches computation
 * the authorization_code grant's observability log reports, independent of
 * console.log itself (which a test can't assert against directly). Never
 * logs or asserts on the real secret value — only that the comparison
 * against it behaves correctly for present/absent/matching/non-matching
 * inputs.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'

config({ path: '.env.local' })

import { computeAuthzCodeSecretObservability } from '../src/routes/oauth.js'

const REAL_SECRET = process.env.OAUTH_CLIENT_SECRET
if (!REAL_SECRET) throw new Error('OAUTH_CLIENT_SECRET must be set in .env.local')

describe('computeAuthzCodeSecretObservability', () => {
  it('undefined secret is absent, not matching', () => {
    assert.deepEqual(computeAuthzCodeSecretObservability(undefined), {
      client_secret_present: false,
      client_secret_matches: false,
    })
  })

  it('a present but wrong secret is present, not matching', () => {
    assert.deepEqual(computeAuthzCodeSecretObservability(`not-${REAL_SECRET}`), {
      client_secret_present: true,
      client_secret_matches: false,
    })
  })

  it('the real secret is present and matching', () => {
    assert.deepEqual(computeAuthzCodeSecretObservability(REAL_SECRET), {
      client_secret_present: true,
      client_secret_matches: true,
    })
  })
})
