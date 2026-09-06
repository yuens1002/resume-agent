export interface Contact {
  name: string
  email: string
  phone?: string
  location?: string
  linkedin?: string
  github?: string
  website?: string
  calendly?: string
  pronouns?: string   // e.g. "he/him" — used by /query to refer back to the candidate correctly; falls back to a neutral default when absent
}

export interface Skill {
  category: string
  items: string[]
}

export interface Employment {
  company: string
  title: string
  start_date: string
  end_date: string | null   // null = current
  description?: string
  bullets: string[]
  attestations?: PeerAttestation[]
}

export interface Education {
  institution: string
  degree: string
  field: string
  start_date: string
  end_date: string | null
}

export interface Project {
  name: string
  slug: string
  description: string       // one-liner for list views
  problem: string           // what problem it solves
  role: string              // your role on the project
  tech: string[]
  highlights: string[]      // key achievements
  architecture?: string     // technical architecture summary
  impact?: string           // measurable business/user impact
  status: 'active' | 'in-progress' | 'archived'
  started?: string          // YYYY-MM
  url?: string              // live URL
  urlLabel?: string         // custom text for the live URL button, e.g. "Deploy on Railway" — consumers fall back to "Live demo" when unset
  repo?: string             // source repo URL
  cover?: string            // public cover image URL
  git_evidence?: GitEvidence
}

export interface Publication {
  title: string
  slug: string
  platform: 'X' | 'Dev.to' | 'Medium' | 'YouTube' | (string & {})  // known platforms keep autocomplete; any string still allowed
  canonical_url: string
  date: string
  tags: string[]
  grounded_in: string       // link back to the knowledge_base concept/finding the piece is based on
  signature?: EvidenceSignature
}

/**
 * One published piece cited by a /query answer (#177). Resolved server-side
 * from the profile record — see `src/lib/publication-citations.ts`, which
 * imports this type rather than declaring its own copy.
 */
export interface PublicationCitation {
  slug: string
  title: string
  platform: string
  canonical_url: string
  date: string
}

export interface EvidenceSignature {
  alg: 'ed25519'
  key_url: string       // URL to /.well-known/oep-public-key.json
  fingerprint: string   // base64url SHA256 of raw public key (same as Phase 1)
  value: string         // base64url Ed25519 signature over canonical JSON of evidence
  signed_at: string     // ISO timestamp
}

export interface GitEvidence {
  verified_at: string
  repo_created_at: string   // YYYY-MM-DD — when the repo was created on the host
  last_push_at: string      // YYYY-MM-DD — last push to any branch
  commit_count: number
  contributors: number
  default_branch: string
  provider: 'github' | 'gitlab' | 'bitbucket'
  repo_stats: {
    total_files: number
    typescript_files: number
    test_files: number
  }
  source: string
  signature?: EvidenceSignature
}

export interface PeerAttestation {
  author: string
  author_url: string
  post_url: string
  posted_at: string         // YYYY-MM-DD
  excerpt: string
  employer_match: boolean
}

export interface VerificationStatus {
  domain: 'verified' | 'unverified'
  git_evidence: 'partial' | 'none'
  peer_attestations: 'pending' | 'attested' | 'not_sought'
  employer_cosignature: 'pending_ecosystem'
  note: string
}

export interface Availability {
  seeking: boolean
  status: 'open' | 'actively-looking' | 'not-looking'
  preferred_roles: string[]
  preferred_locations: string[]
  remote: boolean
  start_date?: string
}

export interface PublicProfile {
  id: string
  contact: Contact
  summary: string
  tagline?: string | null
  skills: Skill[]
  employment: Employment[]
  education: Education[]
  projects: Project[]
  publications: Publication[]
  availability: Availability
  updated_at: string
}

// API request/response shapes

export interface QueryRequest {
  question: string
  context?: string
  style?: 'cited' | 'conversational'
}

export interface QueryResponse {
  answer: string
  confidence: 'high' | 'medium' | 'low'
  sources: string[]
  project_slugs: string[]
  follow_up_suggestions: string[]
  /**
   * Action-intent routing signal (#174). Set server-side from an actual AI SDK
   * tool call — never a free-text field the model writes and could contradict
   * itself on. `null` when the question is a narrated answer, not a request
   * to open a different flow (job-match / résumé-tailoring today).
   */
  action_intent: { tool: string } | null
  /**
   * True when the classifier routed the question as narrate_fit (#199): a
   * question ABOUT the candidate's fit/suitability, answered in prose per the
   * narrate-first spec (#195). The frontend renders its deterministic
   * "run the full fit check" follow-up chip from this — never by re-guessing
   * intent from the answer text (resume-agent-web#26).
   */
  fit_question: boolean
  /**
   * Published pieces this answer cites (#177), the parallel of `project_slugs`
   * for publications. Every field is read from the profile record rather than
   * from the model's prose — same reason `injectProjectUrls` exists on the
   * résumé path: a URL the model retyped is a URL that can be wrong. Empty
   * array when the answer cites no publication. Populated deterministically
   * after generation; see `src/lib/publication-citations.ts`.
   */
  publications: PublicationCitation[]
  contact: Partial<Pick<Contact, 'email' | 'calendly'>>
  meta: {
    model: string
    latency_ms: number
    retrieval_ms?: number
    /**
     * Which upstream actually served the model call (e.g. "Amazon Bedrock",
     * "Anthropic"), when OpenRouter reports one — undefined otherwise
     * (streaming callers, or a provider that doesn't report this). Added
     * after #189: diagnosing a production-only reliability dip in
     * `action_intent` routing required manually SSHing into the deployed
     * container to compare provider metadata against local calls — logging
     * it here means a future recurrence is queryable instead of requiring
     * that live forensic reconstruction again.
     */
    provider?: string
    /** The generation's finish reason (e.g. "stop", "tool-calls") — same #189 motivation as `provider`. */
    finish_reason?: string
  }
}

export interface MatchRequest {
  job_description: string
}

// JD-driven extraction-first scoring (docs/plans/match-quality-extraction.md)
// replaced the fixed skills/experience/domain sub-factor shape: every JD is
// scored on the qualities it actually raises, not a fixed six-axis rubric
// applied identically to every posting. `matched`/`gaps` on `MatchResponse`
// stay skill-scoped and unchanged for `job-hunt-agent` compatibility; this
// per-quality detail is additional, not a replacement for those two fields.
export type MatchQualityCategory = 'skill' | 'experience' | 'domain'
export type MatchQualityImportance = 'must_have' | 'preferred'
export type MatchQualityVerdict = 'matched' | 'partial' | 'missing'
export type MatchQualityEvidenceGrade = 'verified' | 'claimed' | 'absent'

export interface MatchRequiredQuality {
  name: string
  category: MatchQualityCategory
  jd_importance: MatchQualityImportance
}

export interface MatchScoredQuality {
  name: string
  category: MatchQualityCategory
  jd_importance: MatchQualityImportance
  verdict: MatchQualityVerdict
  evidence_grade: MatchQualityEvidenceGrade
}

export interface MatchScoring {
  required_qualities: MatchRequiredQuality[]
  scored_qualities: MatchScoredQuality[]
}

export interface MatchResponse {
  fit_score: number
  matched: string[]
  gaps: string[]
  verdict: string
  recommended_action: 'apply' | 'apply-with-tailoring' | 'pass'
  scoring: MatchScoring
}

export interface ResumeRequest {
  job_description: string
}

export interface ResumeResponse {
  contact: Contact
  summary: string
  skills: Skill[]
  employment: Employment[]
  education: Education[]
  projects: Project[]
}
