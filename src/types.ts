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
  repo?: string             // source repo URL
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
}

export interface QueryResponse {
  answer: string
  confidence: 'high' | 'medium' | 'low'
  sources: string[]
  follow_up_suggestions: string[]
  contact: Partial<Pick<Contact, 'email' | 'calendly'>>
  meta: { model: string; latency_ms: number }
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
