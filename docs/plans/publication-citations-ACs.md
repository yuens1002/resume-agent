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
| AC-FN-4 | D1 | backend-architect | Whole-record citations carry the canonical URL | A normalized whole-record source line contains that publication's `canonical_url` value as read from the fixture | | | |
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
| AC-REG-2 | D2 | test-engineer | No regression in the existing suites | `npm run precheck` and `npm run test:unit` pass with no fewer tests than `main`, and `eval:route` requal is unaffected (no routing surface touched) | | | |
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
| D6 | AC-TST-1 (plus every AC-FN row, which is realized as a test) |
| D7 | AC-SMK-1, AC-SMK-2 |

No orphan deliverables, no orphan ACs.

## Gate 2 — anti-drift lint

No AC Pass cell pins a string literal that also lives in seed data or the live
profile. The live-smoke rows (AC-SMK-1) assert *agreement between the response
and the profile record*, not equality with a hardcoded slug or URL — so seeding
a second publication, or renaming the first, cannot turn these green-but-wrong.
