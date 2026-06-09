# Sync Convention

The nightly sync (`scripts/sync.ts`, triggered by `.github/workflows/sync.yml`) keeps portfolio project data in OB1 current. It reads from GitHub and writes to the `public_profile.projects` array in Supabase.

## What the sync updates

Per project with a `repo` GitHub URL in the profile:

| Field | Source | Notes |
|---|---|---|
| `architecture` | `README.md` (or `docsPath`) | LLM reconciles; no-ops if already accurate |
| `highlights` | `CHANGELOG.md` shipped sections | Additive enrichment; excludes `[Unreleased]` |
| `tech` | `package.json` dependencies | Additive, capped at 15; maps package names to display names |
| `status` | Repo `pushed_at` date | Inferred active/archived |
| `url` | README badges / repo homepage | First valid URL found |
| `git_evidence` | GitHub API | Commit count, contributors, OEP-signed |
| OB1 thoughts | CHANGELOG + feature docs | Extracted facts stored with embeddings |
| CANDIDATE_STACK | All active/in-progress projects | Rebuilt after every sync run |

## Fields the sync never touches

`description`, `problem`, `role`, `impact`, `started`, `name`, `slug`, `repo` — set these once via `upsert_project` and the sync leaves them alone.

## The default convention

For sync to work without any per-repo config, follow **keep-a-changelog** with **semver**:

```
## [Unreleased]
- work in progress goes here

## [1.2.3] - 2026-06-09
### Added
- concrete shipped thing

## [1.2.2] - 2026-05-30
...
```

**One rule:** every merge to main that ships real work gets a versioned section before or at merge. `[Unreleased]` is fine for in-progress work, but the sync treats it as planned — it won't appear in `highlights` until it has a version.

Version drift (package.json ahead of latest CHANGELOG section by more than 1 patch) is detected automatically and written as an OB1 warning thought so it surfaces rather than silently producing stale data.

## Per-repo escape hatches

Add these fields to the project entry in `public_profile.projects` (via `upsert_project`) when the default doesn't fit:

| Field | Type | Purpose |
|---|---|---|
| `docsPath` | `string` | Path to architecture doc if not `README.md` (e.g. `docs/platform/architecture.md`) |
| `featureDocsGlobs` | `string[]` | Directory prefixes to scan for additional `.md` feature docs (e.g. `["docs/features"]`) |
| `skipChangelog` | `boolean` | Skip all changelog processing — no highlights reconciliation, no changelog thought extraction. Feature doc thoughts via `featureDocsGlobs` are unaffected. |

`docsPath` is especially useful for private repos whose README is boilerplate or contains business logic — point it at a curated architecture file instead.

`skipChangelog: true` is the right choice for any private repo whose CHANGELOG contains business-sensitive content (customer details, pricing, internal ops) that should not flow into the public profile or OB1 thoughts. Architecture and feature doc thoughts remain available via `docsPath` and `featureDocsGlobs`.

## When to use `manual` strategy

Some projects don't have machine-readable docs the sync can use:

- **Docs-only repos** (no package.json, no CHANGELOG) — OEP is an example
- **Private repos with no safe architecture doc** — set no `docsPath`, omit the `repo` field, and maintain `architecture` / `highlights` / `description` by hand via `upsert_project`

## For downstream forks

If you fork `resume-agent` and run your own sync:

1. Follow keep-a-changelog + semver in your repos for zero-config sync
2. Use `docsPath` for any repo where the README isn't the right architecture source
3. Store your PAT as `GH_PAT` in Actions secrets — the default `GITHUB_TOKEN` cannot read private repos outside the resume-agent repo itself
4. Add a `repo` GitHub URL to each project entry you want synced; projects without one are silently skipped
