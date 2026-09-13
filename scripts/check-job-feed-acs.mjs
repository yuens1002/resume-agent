import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const plan = readFileSync('docs/plans/job-pipeline-feed/plan.md', 'utf8')
const acs = readFileSync('docs/plans/job-pipeline-feed/ACs.md', 'utf8')
const deliverables = [...plan.matchAll(/^\| (D\d+) \|/gm)].map(match => match[1])
const references = [...acs.matchAll(/^\| AC-\d+ \| (D\d+) \|/gm)].map(match => match[1])
assert.ok(deliverables.length && references.length)
assert.deepEqual([...new Set(references)].sort(), deliverables.sort())
// This feature has no seed/scaffold values. Reject quoted Pass-cell pins;
// semantic fidelity is independently checked per AC in Gate 3.
for (const row of acs.split('\n').filter(line => /^\| AC-\d+/.test(line))) {
  assert.doesNotMatch(row.split('|')[6], /["'`]/)
}
console.log(`Gate 1: ${deliverables.length} deliverables covered; Gate 2: Pass cells contain no literal pins`)
