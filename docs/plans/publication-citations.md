# Publication citations in `/query` (#177 chunk 2)

Status: planned · Branch: `feat/177-publication-citations` · Supersedes: `parked/177-chunk2-publication-citations`

## Why this is not the parked branch

Chunk 2 was parked on 2026-07-11 because the frozen spec's approach — adding a
`publications.<slug>` source form to `RULE_CITATION` — displaced the
overview-projects follow-up offer in 11/11 runs across 4 wording variants. The
park note named two unblock conditions; recon on 2026-09-05 found the ground had
moved under all of them:

1. **"Seed the first real publication."** Done — one publication has been live
   since 2026-08-14 (`beyond-the-chatbot-chief-of-staff-control-plane`, Dev.to).
2. **"Publications must be injected into the prompt."** Already true on `main`,
   and always was. `profile-cache.ts` fetches with `select('*')` and
   `buildQueryPrompt` stringifies the profile wholesale, so `publications` has
   been reaching the model since the column shipped in chunk 1. The parked
   branch's injection work is a no-op except for its empty-array-key drop.
3. **"Expect to pair the citation rule with a compensating
   `RULE_PROGRESSIVE_DISCLOSURE` strengthening."** That strengthening landed
   independently after the park — the rule now carries an explicit MUST for the
   remainder offer.

So the remaining gap is not injection and not the model's willingness to cite
publications. A live probe on 2026-09-05 shows the model *does* cite the
publication, but:

| Observed today (`main`) | Problem |
| --- | --- |
| `[1] publications[0]` | Array-index source form. Unstable across upserts, not resolvable by a consumer, and not the `publications.<slug>` convention chunk 1 documented. |
| `sources: ["publications"]` (conversational) | Coarse — names the collection, not the piece. |
| No `canonical_url` in the answer, even for *"where can I read it?"* | The issue's actual goal — cite the piece's URL as evidence — is unmet in both styles. |

## Approach: deterministic post-processing, no prompt edit

Fix these server-side, after `parseJSON`, instead of asking the model to do it.
This follows the precedent already established in `src/routes/query.ts` for the
#215 decline guard, quoting that comment verbatim:

> Enforce it deterministically rather than editing the prompt, which has a
> history of displacing unrelated behavior when touched.

Consequences that make this the cheaper path:

- `RULE_CITATION` and `RULE_CITATION_CONVERSATIONAL` are untouched →
  `PROMPT_VERSION` is byte-identical to `main` → no response-cache
  invalidation, no attention redistribution, and **no need for the 11-run
  overview-followup A/B** the parked approach required.
- The transformation is a pure function over `(answer, sources, publications)`,
  so unit tests verify it exactly. Under the parked approach the same
  guarantees needed an LLM judge.
- Both `cited` and `conversational` styles are the same code path, so the
  style the web chat actually uses is covered at marginal cost.

Owner decisions taken at plan time (2026-09-05): deterministic approach, both
styles in scope.

## Deliverables

| ID | Artifact | Kind | Owning role |
| --- | --- | --- | --- |
| D1 | `src/lib/publication-citations.ts` — pure resolver + normalizers | lib module | `/backend-architect` |
| D2 | `src/routes/query.ts` — wire normalizers post-parse; carry the parked branch's empty-key drop into `buildQueryPrompt` | endpoint | `/backend-architect` |
| D3 | `src/types.ts` — `PublicationCitation` type + `publications` on `QueryResponse` | type | `/backend-architect` |
| D4 | `src/routes/openapi.ts` — document the new `/query` response field | schema | `/backend-architect` |
| D5 | `docs/query-engagement-rules.md` — document the deterministic normalization as a post-processing step, not a prompt rule | docs | `/backend-architect` |
| D6 | `tests/publication-citations.test.ts` + `tests/thoughts-grounded-query.test.ts` additions, registered in `package.json`'s `test:unit` list | tests | `/test-engineer` |
| D7 | Live smoke against `agent.yuens.me` for both styles + `PROMPT_VERSION` identity check vs `main` | verification | `/test-engineer` |

### D1 — resolver + normalizers

One shared resolver, three thin callers (no duplicated matching logic):

```ts
resolveCitedPublications(answer, sources, publications): Map<string, Publication>
normalizePublicationSourceLines(answer, publications): string   // prose Sources: block
normalizePublicationSourcePaths(sources, answer, publications): string[]  // JSON sources[]
citedPublications(answer, sources, publications): PublicationCitation[]   // envelope
```

Resolution order, most specific first — never guess:

1. **Index form** (`publications[0]`, `publications[0].grounded_in`) → resolve by
   index into the same array that was injected into the prompt. Out-of-range
   indices resolve to nothing and the line is left untouched.
2. **Slug form** (`publications.<slug>`) → already canonical; pass through, but
   still eligible for URL suffixing.
3. **Bare collection** (`publications`) → resolve by which publication the
   answer actually mentions (title or `canonical_url` substring); if the profile
   holds exactly one publication, use it.
4. **Unresolvable or ambiguous** → leave the source entry exactly as the model
   wrote it. A wrong citation is worse than an unnormalized one.

Canonical output form for a whole-record citation:
`publications.<slug> — <canonical_url>`. A sub-path citation keeps its field
suffix and takes no URL: `publications.<slug>.grounded_in`.

### D2 — wiring

Normalizers run in the same post-`parseJSON` block as the #215 decline guard,
before the response is cached — so cached entries carry normalized citations.
The publications array passed in is `profile.publications`, i.e. the exact array
`buildQueryPrompt` stringified, which is what makes index resolution sound.

The streaming path (`stream=true`) returns plain text with no JSON envelope and
is out of scope, consistent with how the #215 guard is scoped.

## Not in scope

- **No new `eval:query` case.** The park note anticipated one, but that was for
  a model-behavior change needing an LLM judge. This change is a deterministic
  string transformation fully covered by unit tests, and a new case would
  require a new `EvalCategory` plus rubric calibration — cost with no added
  signal. `eval:query` is still run as a regression gate (baseline: 18 cases).
- No prompt-rule edits, no `PROMPT_VERSION` change.
- No `/publications` endpoint, no `knowledge_base` sync automation (both
  deferred by the issue body).
- No frontend work. The envelope field is additive and backward-compatible;
  `resume-agent-web` rendering it is a follow-up.

## Commit schedule

1. `docs: add plan + ACs for publication citations (#177 chunk 2)`
2. `feat(query): deterministic publication citation normalization (#177 chunk 2)`
3. `test: publication citation coverage`
4. `docs: sync query-engagement-rules + openapi for publication citations`
