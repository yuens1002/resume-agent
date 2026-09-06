# ACs — Publication citations in `/query` (#177 chunk 2)

Plan: `docs/plans/publication-citations.md` · Branch: `feat/177-publication-citations`

Pass conditions are stated as **invariants**, not as equality against a config
literal or seed value. Where a test needs a publication, it builds its own
fixture — no test pins the live profile's real slug, title, or URL.

| ID | Plan ref | Role | Acceptance criterion | Pass (invariant) | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-1 | D1 | backend-architect | Index-form source entries resolve to the slug form | For a profile with N publications, a source entry `publications[i]` (0 ≤ i < N) is rewritten to `publications.<slug of publications[i]>` — the slug read from the fixture, never a literal | PASS — tests:43,48 resolve index 1 to beta and index 0 to alpha off a 2-element fixture | PASS · spot-checked — probe E confirms an always-[0] impl fails tests:43 | |
| AC-FN-2 | D1 | backend-architect | Out-of-range and malformed index forms are left alone | A source entry whose index is ≥ N, negative, or non-numeric is returned byte-identical to its input | PASS — tests:62-76, all four malformed forms deepEqual to input | PASS · trust | |
| AC-FN-3 | D1 | backend-architect | Sub-path citations keep their field | `publications[i].grounded_in` becomes `publications.<slug>.grounded_in`; the machine-readable `sources` array carries no URL on any entry | PASS — tests:82-89, exact equality plus a negative URL assertion | PASS after Phase 4.4 — the original negative assertion was vacuous (the array surface carries no URL for anything); scope narrowed to the array surface, which is what it actually tests | |
| AC-FN-4 | D1 | backend-architect | Every cited publication reaches the reader with a link, exactly once | Each publication cited in the prose `Sources:` block has its `canonical_url` on the first line citing it — including when every line for that piece is a field sub-path — and on no later line for the same piece. The `sources` array stays bare paths, with the URL carried structurally in the envelope | PASS (contract corrected) — prose line carries the URL (tests:93-96); array form asserted bare (tests:105-109) | PASS · re-scoped twice from live evidence: the first smoke found the array-suffix bug, the Phase 4.4 smoke found the model citing only field sub-paths for a "where can I read it" question, which the old sub-path rule left with no link at all. Link is now once-per-publication, on its first line. 5 tests | |
| AC-FN-5 | D1 | backend-architect | Bare `publications` resolves only when unambiguous | With exactly one publication in the profile, a bare `publications` entry resolves to that slug. With two or more and no title/URL match in the answer, the entry is returned unchanged | PASS — tests:113-125 | PASS · trust | |
| AC-FN-6 | D1 | backend-architect | Answer-mention matching resolves the right piece among several | With multiple publications, a bare `publications` entry resolves to the one whose title or `canonical_url` appears in the answer text — not to the first array element | PASS — tests:127-144, resolves index 1 by title and by URL, refuses when both named | PASS · trust | |
| AC-FN-7 | D1 | backend-architect | Already-canonical entries are idempotent | Running the normalizers twice over the same input produces the same output as running them once | PASS — tests:147-170 | PASS · trust | |
| AC-FN-8 | D1 | backend-architect | Malformed publication records never throw | Given a publications array containing `null`, a non-object, and a record missing `slug`/`canonical_url`, every exported function returns without throwing and leaves affected entries unchanged | FAIL on first impl — index resolved against the filtered array and emitted a neighbour | PASS after rewrite — reproduced as probe A, fixed at publication-citations.ts:140-148, pinned by AC-FN-15 | |
| AC-FN-9 | D2 | backend-architect | The prose `Sources:` block is normalized in cited style | For a cited-style response whose answer contains a `Sources:` block with an index-form publication line, the returned `answer` contains the slug form; non-publication source lines in the same block are unchanged | PASS with caveat — body-vs-block anchoring was unasserted | PASS after rewrite — anchoring added (SOURCES_BLOCK_RE). Phase 4.4 showed AC-FN-16/17 did NOT actually pin it (removing the slice left the suite green); now pinned by the body-line-above-a-real-block regression, verified by mutation | |
| AC-FN-10 | D2 | backend-architect | The JSON `sources` array is normalized in both styles | The returned `sources` array contains no bare `publications` or index-form entry when resolution succeeded, and preserves every non-publication path unchanged and in order | PASS with caveat — unscoped dedupe/filtering of non-publication entries | PASS after rewrite — pass-through preserved, pinned by AC-FN-18 | |
| AC-FN-11 | D2/D3 | backend-architect | The envelope carries machine-readable citations | For an answer citing a publication, `response.publications` is a non-empty array whose entries carry `slug`, `title`, `platform`, `canonical_url`, `date` sourced from the profile record — never from the model's text | PASS — tests:213-222 deepEqual the whole record against fixture fields | PASS · spot-checked live: envelope canonical_url matches the profile record byte-for-byte | |
| AC-FN-12 | D2/D3 | backend-architect | The envelope field is absent-safe and quiet | An answer citing no publication, and a profile with no `publications` field at all, both yield an empty `publications` array and no thrown error | FAIL on first impl — the prose word "publications" populated the envelope | PASS after rewrite — reproduced as probe B, fixed by dropping the answer-body scan, pinned by AC-FN-16 | |
| AC-FN-13 | D2 | backend-architect | Empty publications arrays are dropped from the prompt | `buildQueryPrompt` output contains no `"publications"` key when the profile's array is empty or the field is absent, and does contain it when non-empty (carried from the parked branch) | PASS — thoughts-grounded-query.test.ts:227-231 is the load-bearing assertion | PASS · trust | |
| AC-FN-14 | D2 | backend-architect | Normalization happens before caching | The value stored in the response cache is the normalized response, so a cache hit and a cache miss return identical citation forms | PASS by code trace (query.ts:503-504 -> 507-520 -> 533); no test existed | PASS by code trace only (query.ts: normalize -> build -> responseCacheSet). The round-trip test covers cache *fidelity* — that stored citations come back intact — not the ordering itself; swapping the cache-set above the normalizers would still pass. Stated plainly rather than credited to a test that cannot fail for it | |
| AC-REG-1 | D2 | backend-architect | `PROMPT_VERSION` is byte-identical to `main` | `buildSystemPrompt` output for all four mode × style combinations is byte-identical between this branch and `main`, so `PROMPT_VERSION` is unchanged | not verified by sub-agent (assigned to main thread) | PASS — all four buildSystemPrompt mode x style hashes byte-identical to main; PROMPT_VERSION inputs are those two plus untouched ROUTE_CLASSIFIER_RULE | |
| AC-REG-2 | D2 | test-engineer | No regression in the existing suites | `npm run build` and `npm run test:unit` both pass, with no fewer tests than `main` (this repo has no `precheck` script — `build` is the tsc gate) | PASS on substance; AC text named a non-existent `precheck` script | PASS — build exit 0, test:unit 610 tests / 0 fail (main ~559, diff is additive); AC text corrected | |
| AC-DOC-1 | D5 | backend-architect | The engagement-rules doc describes the real mechanism | `docs/query-engagement-rules.md` documents publication citations as deterministic post-processing and does not claim a prompt rule produces them | PASS — new section states the prompt is deliberately not the fix | PASS · read in full | |
| AC-DOC-2 | D4 | backend-architect | The OpenAPI `/query` response documents the new field | The `/query` response schema in `src/routes/openapi.ts` includes the `publications` array with its per-entry fields | PASS — openapi.ts:56-70 carries all five fields | PASS · trust | |
| AC-TST-1 | D6 | test-engineer | New test file is wired into the runner | `tests/publication-citations.test.ts` is listed in `package.json`'s `test:unit` script (this repo enumerates test files explicitly) | PASS — registered in test:unit and observed executing | PASS · trust | |
| AC-SMK-1 | D7 | test-engineer | Live behavior improves for the real question | Against the live profile, a "where can I read it" question in both `cited` and `conversational` styles returns a source entry in slug form and a `publications` envelope entry whose `canonical_url` matches the live profile record | not verified by sub-agent (assigned to main thread) | PASS both styles on the running server after the fix — cited prose line carries slug+URL; conversational envelope carries the full record | |
| AC-SMK-2 | D7 | test-engineer | The overview follow-up offer is not displaced | The overview-projects question still produces a remainder-offer follow-up at the same rate as `main` — the interaction the park note flagged as the standing risk for any change in this file | not verified by sub-agent (assigned to main thread) | PASS — remainder offer first in 5/5 independent generations (3 pre-fix, 2 post-fix, all cache misses). Limitation: the live profile has a non-empty publications array, so the empty-array branch of the prompt change (AC-FN-13) is covered by unit tests only, never live | |

## Gate 1 — plan ↔ ACs coverage

Every deliverable has at least one AC, and every AC's Plan ref names a real
deliverable:

| Deliverable | Covering ACs |
| --- | --- |
| D1 | AC-FN-1 … AC-FN-8 |
| D2 | AC-FN-9, AC-FN-10, AC-FN-11, AC-FN-12, AC-FN-13, AC-FN-14, AC-REG-1, AC-REG-2 |
| D3 | AC-FN-11, AC-FN-12 |
| D4 | AC-DOC-2 |
| D5 | AC-DOC-1 |
| D6 | AC-TST-1, plus every AC-FN row — each is realized as at least one test, including AC-FN-14, whose cache round-trip lives in `tests/thoughts-grounded-query.test.ts` |
| D7 | AC-SMK-1, AC-SMK-2 |

No orphan deliverables, no orphan ACs.

## Verification-sourced additions (Phase 3)

The Phase 3 sub-agent found two AC invariants violated by the first
implementation, in both cases with tests shaped so the bug stayed green. The
module was rewritten and the following rows were added; each new test fails
against the original implementation (verified by re-running the suite against
the reverted file — 13/13 fail).

| ID | Plan ref | Role | Acceptance criterion | Pass (invariant) | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-15 | D1 | backend-architect | An index never slides onto a neighbouring record | With a malformed record at position i, `publications[i]` resolves to nothing and is left unchanged — never to the record that would occupy position i after filtering. A later index still resolves to the record actually at that position | n/a — added after the verification pass | PASS — 3 tests, all fail against the previous implementation | |
| AC-FN-16 | D1 | backend-architect | The word "publications" in prose is not a citation | An ordinary sentence containing the word populates no envelope entry and rewrites no line; only `sources` entries and `[N] <path>` lines inside the `Sources:` block are treated as citations | n/a — added after the verification pass | PASS — 3 tests, all fail against the previous implementation | |
| AC-FN-17 | D1 | backend-architect | The prose rewrite preserves surrounding whitespace | Blank lines after the Sources block, a trailing newline, and every character above the `Sources:` line survive normalization byte-identical | n/a — added after the verification pass | PASS — 3 tests, all fail against the previous implementation | |
| AC-FN-18 | D1/D2 | backend-architect | `sources` keeps the model's semantics but honors its declared type | Non-publication entries, including duplicates, pass through untouched and in order — no reordering, no deduping of entries this module did not rewrite. The declared `string[]` contract is enforced: non-string entries are dropped and a non-array becomes `[]`, since `eval-query-answer.ts` calls `.toLowerCase()` on every entry | n/a — added after the verification pass | PASS — 4 tests, all fail against the previous implementation | |

Gate 1 coverage for the new rows: all four reference D1 (AC-FN-18 also D2), both real deliverables. Gate 2: their fixtures are the same invented `alpha-piece`/`beta-piece` records, plus a slug-less `{ title: 'legacy row, no slug' }` — none appear in seed data or the live profile.

## OCR-review-sourced additions (Phase 4.4)

Three Fable 5 reviewers ran over the diff. The test reviewer mutation-tested
the suite and found five mutations that survived it; the source reviewer found
two ways the module could still emit a *wrong* citation once a second
publication is seeded. The rows below pin what was fixed. Every new test was
verified by re-running the suite against the mutated implementation — all six
targeted mutations now fail (sub-path guard, Sources-block anchoring, the
` — ` separator, the title floor, the index cross-check, envelope order).

| ID | Plan ref | Role | Acceptance criterion | Pass (invariant) | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-19 | D1 | backend-architect | A short or generic title never resolves by prose mention | A publication whose title is shorter than the match floor does not resolve from answer prose, and no title matches inside a longer word; matching stays case-insensitive, and `canonical_url` matching still resolves such a record | n/a — added at Phase 4.4 | PASS — 4 tests; removing the floor and the word-boundary check fails 2 of them | |
| AC-FN-20 | D1 | backend-architect | An index the prose contradicts is refused | When the answer unambiguously names a different publication than `publications[i]` points at, the entry is left unchanged; when the answer names that same piece, or names none, the index resolves | n/a — added at Phase 4.4 | PASS — 3 tests; removing the cross-check fails 1 | |
| AC-FN-21 | D1/D2 | backend-architect | The two-pass composition holds | Feeding the prose pass's output into the array pass resolves a bare `publications` entry to the piece the Sources block cited, and refuses when the block cited two; envelope order follows first appearance | n/a — added at Phase 4.4 | PASS — 3 tests; the order dependency is now also documented at the call site in query.ts | |

Gate 1: AC-FN-19/20 reference D1, AC-FN-21 references D1 and D2 — all real deliverables. Gate 2: fixtures are invented (`short-one`/`AI`, `a-piece`/`Evaluation`, `alpha-piece`/`beta-piece`); none appears in seed data or the live profile.

## Low-severity findings, fixed at owner request (post-4.4)

The four low-severity findings `/review` deferred were approved for fixing rather
than deferred to a follow-up. Each is pinned by at least one test that fails
against the pre-fix implementation (verified: 5 fail on the reverted file).

| ID | Plan ref | Role | Acceptance criterion | Pass (invariant) | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-22 | D1 | backend-architect | A slug containing `.` is not mis-split | With slugs `a` and `a.b` both present, `publications.a.b` resolves to the record `a.b` with no sub-path — not to `a` with sub-path `.b`. A trailing segment is still treated as a sub-path when no longer slug exists | n/a — post-4.4 | PASS — 3 tests; the string form is identical either way, so the assertions are on which record resolved | |
| AC-FN-23 | D1 | backend-architect | Non-string record fields are coerced, not forwarded | Every field of a `PublicationCitation` is a string even when the profile record carries a number, null, object, or array there; the record is still identified by its valid slug, and a non-string `canonical_url` produces no dangling separator | n/a — post-4.4 | PASS — 3 tests | |
| AC-FN-24 | D1 | backend-architect | The `Sources:` heading is as tolerant as its siblings | A bold heading (`**Sources:**`) normalizes. A citation sharing the heading's line is a deliberate no-op, matching `parse-json.ts`'s `Sources:` followed by a newline requirement and RULE_CITATION's one-source-per-line rule — asserted rather than left to chance | n/a — post-4.4 | PASS — 3 tests, including the boundary as an explicit assertion | |
| AC-FN-25 | D1 | backend-architect | Dedupe touches only what this module rewrote | Two forms normalizing onto one path collapse; duplicate *unresolved* publication entries are returned exactly as written, matching the code comment that describes the behavior | n/a — post-4.4 | PASS — 2 tests | |

Gate 1: all four reference D1. Gate 2: fixtures are invented (`a`, `a.b`, `weird`, `alpha-piece`); none appears in seed data or the live profile.

## Copilot review (Phase 6)

Copilot flagged one real contract violation, and it **contradicted** a Phase 4.4
finding — worth recording, because resolving it required deciding which reviewer
was right rather than applying both.

- **Phase 4.4 said:** don't quietly revalidate `sources`; passing non-strings
  through is preserving the model's output, and filtering them is an unscoped
  change to a public API field.
- **Copilot said:** `sources` is declared `string[]` in `QueryResponse` and in
  the OpenAPI schema, and `eval-query-answer.ts:181` calls `.toLowerCase()` on
  every entry — so a forwarded `null` crashes a real consumer.

**Resolution:** Copilot is right, and the two are reconcilable. Enforcing a type
the contract already declares is not the same as inventing semantics for the
field. The function now drops non-string entries and returns `[]` for a
non-array, while still refusing to reorder or dedupe anything it did not
rewrite. AC-FN-18 is restated above to say exactly that.

Worth noting the hazard is pre-existing, not introduced here — on `main`,
`parsed.sources` reaches the response straight from `parseJSON` with no
validation at all. This module is simply the first code to own that field.

## Gate 2 — anti-drift lint

No AC Pass cell pins a string literal that also lives in seed data or the live
profile. The live-smoke rows (AC-SMK-1) assert *agreement between the response
and the profile record*, not equality with a hardcoded slug or URL — so seeding
a second publication, or renaming the first, cannot turn these green-but-wrong.
