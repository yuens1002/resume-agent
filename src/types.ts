export interface Contact {
  name: string
  email: string
  phone?: string
  location?: string
  linkedin?: string
  github?: string
  website?: string
  calendly?: string
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
  contact: Partial<Pick<Contact, 'email' | 'calendly'>>
  meta: { model: string; latency_ms: number; retrieval_ms?: number }
}

export interface MatchRequest {
  job_description: string
}

export interface MatchScoring {
  skills: {
    matched: string[]
    partial: string[]
    missing: string[]
    score: number
  }
  experience: {
    years: number
    scope: number
    recency: number
    score: number
  }
  domain: {
    industry: number
    product_type: number
    scale: number
    score: number
  }
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
