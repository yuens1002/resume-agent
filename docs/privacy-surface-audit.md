# Privacy surface audit — what decides whether a thought is public

Audit date: 2026-08-03 · against `main` @ `f0660fe` (post-#231, #234)
Companion to #233 (invert the default). This documents the **current** state, so the
inversion has a complete list of paths to change rather than a partial one.

A thought's visibility is decided in three places: what a **producer** stamps at write
time, what a **mutator** changes afterwards, and what a **consumer** filters on at read
time. All three currently disagree about what "unset" means.

---

## The governing predicate

```ts
// src/lib/observations.ts:105
export function isPublicThought(metadata) {
  return (metadata?.private as unknown) !== true
}
```

```ts
// src/lib/thought-metadata.ts:26 — inside buildThoughtMetadata
if (opts.private) base.private = true      // written ONLY when true
```

Together these make the default **fail-open**, and — critically — they make
"deliberately public" and "nobody considered it" the *same database state*: no `private`
key at all. Nothing downstream can distinguish them. That is the single fact that makes
#233's migration a curation pass rather than an `UPDATE`.

---

## 1. Producers — every path that inserts a thought

| # | Path | Stamps | Resulting stance |
|---|---|---|---|
| 1 | `src/routes/mcp.ts:461` — `capture_thought` | `buildThoughtMetadata(…, {source:'mcp', private: isPrivate})` | **public unless caller passes `private:true`** |
| 2 | `src/routes/resume.ts:276` — rubric telemetry | `RUBRIC_FAILURE_METADATA` (frozen, `private:true`) | private ✅ *(fixed in #227)* |
| 3 | `scripts/sync.ts:346` — version-drift warning | `{type:'observation', source:'sync', topics:[…,'version_drift']}` | **public — no flag written** |
| 4 | `scripts/sync.ts:448` — changelog enrichment | `{type:'reference', source:'enrichment', …}` | **public — no flag written** *(intended: grounds `/query`)* |
| 5 | `scripts/sync.ts:532` — employment delta | `buildEmploymentDeltaMetadata(slug)` | private ✅ (unapproved résumé bullets) |
| 6 | `scripts/sync.ts:1090` — employment notification | `buildEmploymentNotificationMetadata()` | private ✅ (archives previous bullets) |
| 7 | `scripts/sync.ts:1127` — `CANDIDATE_STACK` | `{type:'reference', topics:['candidate_stack'], source:'sync'}` | **public — no flag written** |

**4 of 7 producers write no flag at all** (1 when the caller omits it, plus 3, 4, 7).
Two of those are *intentionally* public and load-bearing — #4 and #7 ground `/query` and
`/resume`, so the #233 migration must stamp them explicitly public or grounding breaks.

Producers 5 and 6 are the only ones that treat privacy as a first-class decision at the
call site rather than a default. They are the pattern the others should follow — but note
they only became so in **#234**; before it they wrote `{type:'review_needed'|'notification',
source:'sync'}` with no flag, i.e. they were two more instances of row 3/4/7. That is the
same fail-open default producing the same outcome a third time, which is the argument for
#233 rather than a fourth patch.

---

## 2. Mutators — every path that changes an existing stance

| Path | Behaviour |
|---|---|
| `src/routes/mcp.ts:502` — `update_thought` | `resolveThoughtUpdateOpts` preserves the existing flag unless an explicit boolean is passed; `undefined` means *leave unchanged*, not *make public* ✅ |
| `scripts/backfill-private-telemetry.ts:180,229` | Bulk `metadata` update setting `private:true`; dry-run by default, re-queries to verify ✅ |
| `scripts/sync.ts:1135` | Deletes stale `candidate_stack` rows — removal, not a stance change |

Both mutators are well-behaved **for `private`**. The model cannot flip a stance:
`buildThoughtMetadata` strips `source`/`private` out of model-extracted metadata and sets
them only from explicit caller arguments, so a prompt-injected `"private": true` inside
thought text is inert. That invariant should survive the inversion unchanged.

### A mutator changed a *different* stance, silently — the cautionary tale for #233

`resolveThoughtUpdateOpts` used to fall back to `source: 'mcp'` for a row with no usable
`source`. Harmless while `source` was mere provenance — but #222 made `'mcp'` the marker of
a hand-authored note, so from then on *any* edit to a source-less row silently promoted
machine output to authored. #234 fixed the fallback to `UNKNOWN_THOUGHT_SOURCE`
(`'unknown'`, outside the allowlist — fail-closed).

It had already fired: 122 rows whose content is literally `RESUME_RUBRIC_FAILURE: …` and
`Applied to …` had acquired `source: 'mcp'` by being edited during the #227 privacy sweep.
The sweep that fixed one exposure created a latent second one.

**Both are now repaired.** `scripts/backfill-private-telemetry.ts` gained a source-repair
pass alongside #234, and it has been run — verified by dry run on 2026-08-04:

```
rubric telemetry            134 total, 134 already private, 0 to update
job-application logs         22 total,  22 already private, 0 to update
employment delta proposals   63 total,  63 already private, 0 to update
employment sync notifications 2 total,   2 already private, 0 to update
→ 0 rows to re-stamp
```

Independently confirmed from the public side: `?authored=1&limit=500` returns 159 notes
with **0** telemetry among them.

Note the repair is gated on the **content signature**, not the topic alone — a hand-written
note could legitimately carry `job-application`, and rewriting its provenance would be a
worse error than the one being fixed. That gating is the reusable lesson.

**The standing warning for #233.** This episode is the reason its curation pass must select
against `content`, never against `source`: `source` has already been wrong once, silently,
for reasons that had nothing to do with privacy. Re-run this script's dry run before the
migration to confirm the population is still clean at that point.

---

## 3. Consumers — every path that reads and filters

| Surface | Path | Guard |
|---|---|---|
| `GET /observations` (listing) | `src/routes/observations.ts` → `buildObservationsListing` | `.filter(isPublicThought)` ✅ |
| `GET /observations/:id` | `src/routes/observations.ts:168` | `isPublicThought` → `404` (never `403`) ✅ |
| `POST /query` — question grounding | `queryRelevantThoughtsForQuestion` → **`match_thoughts_public`** | SQL guard ✅ |
| `POST /query` — shipped-work grounding | `queryRelevantThoughts` → **`match_thoughts`** | ⚠️ **none** — see below |
| `POST /resume` | `queryRelevantThoughts` → **`match_thoughts`** | ⚠️ **none** — see below |
| Private MCP (`/mcp`) | `match_thoughts` | intentionally unguarded (owner-only surface) |

### SQL layer

```sql
-- supabase/migrations/20260512000000_match_thoughts_public.sql:39
and not (t.metadata @> '{"private": true}'::jsonb)
```

`match_thoughts` — the original RPC — has **no privacy clause**. RLS is enabled on
`thoughts`, but the API uses the service role, so RLS is not the boundary here.

---

## Finding: `/resume` and part of `/query` reach thoughts through an unguarded RPC

`queryRelevantThoughts` calls `match_thoughts` (no privacy clause) and is used by **both**
`/resume` and `/query`. Its only protection is the relevance filter:

```ts
// src/lib/thoughts-query.ts:37
filter: { status: 'shipped', source: 'enrichment' }
```

That is privacy-preserving **by coincidence, not by design**. It holds only because
`source: 'enrichment'` is written by exactly one producer (sync.ts:448, the public
changelog ledger). Nothing enforces that coupling. It breaks if:

- any future producer writes `source:'enrichment'` with private content
- the filter is relaxed or made configurable for relevance reasons
- a private thought is ever hand-edited to `status:'shipped'` + `source:'enrichment'`

A private thought reaching this path would be injected into a **generated résumé** or a
public `/query` answer. This is a second fail-open, independent of the default-visibility
one in #233, and inverting the default does **not** close it — an inverted default changes
what "unset" means, while this path never consults the flag at all.

**Suggested fix, separable from #233:** add the same containment guard to `match_thoughts`
and let the private MCP call a deliberately-unguarded sibling, so the *default* RPC is safe
and the unguarded one is the named exception. That inverts this the same way #233 inverts
the metadata default — the safe path becomes the one you get without asking.

---

## What #233 must touch

1. `isPublicThought` — invert to `metadata?.public === true`
2. `buildThoughtMetadata` — always write the resolved flag, never omit
3. `capture_thought` — swap the `private:true` opt-out for a `public:true` opt-in
4. `match_thoughts_public` SQL — invert the containment guard to match
5. Producers 3, 4, 7 — stamp an explicit stance; 4 and 7 must be explicitly **public** or `/query` and `/resume` grounding breaks
6. Backfill — curate, do not bulk-update; the two states are indistinguishable in the data
7. `resolveThoughtUpdateOpts` — preserve-unless-explicit semantics carry over unchanged

## Verification after the change

- `GET /observations` still returns the curated authored corpus (non-zero)
- `POST /query` still grounds on the reference ledger — a regression here is silent, since
  a thinner answer still looks like a valid answer
- `POST /resume` still produces populated résumés
- A newly captured thought with no explicit flag is **absent** from every public surface
- TS predicate and SQL guard agree — disagreement between them is worse than either default
