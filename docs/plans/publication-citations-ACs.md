# ACs — Publication citations in `/query` (#177 chunk 2)

Plan: `docs/plans/publication-citations.md` · Branch: `feat/177-publication-citations`

Pass conditions are stated as **invariants**, not as equality against a config
literal or seed value. Where a test needs a publication, it builds its own
fixture — no test pins the live profile's real slug, title, or URL.

| ID | Plan ref | Role | Acceptance criterion | Pass (invariant) | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-1 | D1 | backend-architect | Index-form source entries resolve to the slug form | For a profile with N publications, a source entry `publications[i]` (0 ≤ i < N) is rewritten to `publications.<slug of publications[i]>` — the slug read from the fixture, never a literal | | | |
| AC-FN-2 | D1 | backend-architect | Out-of-range and malformed index forms are left alone | A source entry whose index is ≥ N, negative, or non-numeric is returned byte-identical to its input | | | |
| AC-FN-3 | D1 | backend-architect | Sub-path citations keep their field and take no URL | `publications[i].grounded_in` becomes `publications.<slug>.grounded_in` and the output contains no `canonical_url` for that line | | | |
| AC-FN-4 | D1 | backend-architect | Whole-record citations carry the canonical URL in the prose block only | A normalized whole-record line in the prose `Sources:` block contains that publication's `canonical_url` as read from the fixture; the same citation in the machine-readable `sources` array is the bare path, with the URL carried structurally in the envelope instead | | | |
| AC-FN-5 | D1 | backend-architect | Bare `publications` resolves only when unambiguous | With exactly one publication in the profile, a bare `publications` entry resolves to that slug. With two or more and no title/URL match in the answer, the entry is returned unchanged | | | |
| AC-FN-6 | D1 | backend-architect | Answer-mention matching resolves the right piece among several | With multiple publications, a bare `publications` entry resolves to the one whose title or `canonical_url` appears in the answer text — not to the first array element | | | |
| AC-FN-7 | D1 | backend-architect | Already-canonical entries are idempotent | Running the normalizers twice over the same input produces the same output as running them once | | | |
| AC-FN-8 | D1 | backend-architect | Malformed publication records never throw | Given a publications array containing `null`, a non-object, and a record missing `slug`/`canonical_url`, every exported function returns without throwing and leaves affected entries unchanged | | | |
| AC-FN-9 | D2 | backend-architect | The prose `Sources:` block is normalized in cited style | For a cited-style response whose answer contains a `Sources:` block with an index-form publication line, the returned `answer` contains the slug form; non-publication source lines in the same block are unchanged | | | |
| AC-FN-10 | D2 | backend-architect | The JSON `sources` array is normalized in both styles | The returned `sources` array contains no bare `publications` or index-form entry when resolution succeeded, and preserves every non-publication path unchanged and in order | | | |
| AC-FN-11 | D2/D3 | backend-architect | The envelope carries machine-readable citations | For an answer citing a publication, `response.publications` is a non-empty array whose entries carry `slug`, `title`, `platform`, `canonical_url`, `date` sourced from the profile record — never from the model's text | | | |
| AC-FN-12 | D2/D3 | backend-architect | The envelope field is absent-safe and quiet | An answer citing no publication, and a profile with no `publications` field at all, both yield an empty `publications` array and no thrown error | | | |
| AC-FN-13 | D2 | backend-architect | Empty publications arrays are dropped from the prompt | `buildQueryPrompt` output contains no `"publications"` key when the profile's array is empty or the field is absent, and does contain it when non-empty (carried from the parked branch) | | | |
| AC-FN-14 | D2 | backend-architect | Normalization happens before caching | The value stored in the response cache is the normalized response, so a cache hit and a cache miss return identical citation forms | | | |
| AC-REG-1 | D2 | backend-architect | `PROMPT_VERSION` is byte-identical to `main` | `buildSystemPrompt` output for all four mode × style combinations is byte-identical between this branch and `main`, so `PROMPT_VERSION` is unchanged | | | |
| AC-REG-2 | D2 | test-engineer | No regression in the existing suites | `npm run build` and `npm run test:unit` both pass, with no fewer tests than `main` (this repo has no `precheck` script — `build` is the tsc gate) | | | |
| AC-DOC-1 | D5 | backend-architect | The engagement-rules doc describes the real mechanism | `docs/query-engagement-rules.md` documents publication citations as deterministic post-processing and does not claim a prompt rule produces them | | | |
| AC-DOC-2 | D4 | backend-architect | The OpenAPI `/query` response documents the new field | The `/query` response schema in `src/routes/openapi.ts` includes the `publications` array with its per-entry fields | | | |
| AC-TST-1 | D6 | test-engineer | New test file is wired into the runner | `tests/publication-citations.test.ts` is listed in `package.json`'s `test:unit` script (this repo enumerates test files explicitly) | | | |
| AC-SMK-1 | D7 | test-engineer | Live behavior improves for the real question | Against the live profile, a "where can I read it" question in both `cited` and `conversational` styles returns a source entry in slug form and a `publications` envelope entry whose `canonical_url` matches the live profile record | | | |
| AC-SMK-2 | D7 | test-engineer | The overview follow-up offer is not displaced | The overview-projects question still produces a remainder-offer follow-up at the same rate as `main` — the interaction the park note flagged as the standing risk for any change in this file | | | |

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
| AC-FN-15 | D1 | backend-architect | An index never slides onto a neighbouring record | With a malformed record at position i, `publications[i]` resolves to nothing and is left unchanged — never to the record that would occupy position i after filtering. A later index still resolves to the record actually at that position | | | |
| AC-FN-16 | D1 | backend-architect | The word "publications" in prose is not a citation | An ordinary sentence containing the word populates no envelope entry and rewrites no line; only `sources` entries and `[N] <path>` lines inside the `Sources:` block are treated as citations | | | |
| AC-FN-17 | D1 | backend-architect | The prose rewrite preserves surrounding whitespace | Blank lines after the Sources block, a trailing newline, and every character above the `Sources:` line survive normalization byte-identical | | | |
| AC-FN-18 | D1/D2 | backend-architect | `sources` is not quietly revalidated | Non-publication entries — including duplicates and non-strings — pass through untouched and in order; a non-array `sources` is returned as-is; an array is returned unchanged when the profile has no publications | | | |

Gate 1 coverage for the new rows: all four reference D1 (AC-FN-18 also D2), both real deliverables. Gate 2: their fixtures are the same invented `alpha-piece`/`beta-piece` records, plus a slug-less `{ title: 'legacy row, no slug' }` — none appear in seed data or the live profile.

## Gate 2 — anti-drift lint

No AC Pass cell pins a string literal that also lives in seed data or the live
profile. The live-smoke rows (AC-SMK-1) assert *agreement between the response
and the profile record*, not equality with a hardcoded slug or URL — so seeding
a second publication, or renaming the first, cannot turn these green-but-wrong.
