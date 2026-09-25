/**
 * Synthetic job descriptions for `npm run eval:resume` (#298 D8).
 *
 * Every JD here is written for this eval, not copied from a real employer's
 * posting, so no employer text lands in this public repo. They span distinct
 * role types so the format, budget and STAR/XYZ checks run against different
 * tailoring pressures.
 */

export interface ResumeEvalCase {
  id: string
  roleType: string
  jobDescription: string
}

export const RESUME_EVAL_CASES: ResumeEvalCase[] = [
  {
    id: 'ai-product-engineer',
    roleType: 'AI product engineering',
    jobDescription: `Job title: Senior AI Product Engineer

We're hiring a Senior AI Product Engineer to ship LLM-powered features end to end. You'll design agent workflows, build evaluation harnesses that gate releases, and own TypeScript services from spec to production.

Requirements:
- 5+ years building production web software in TypeScript and Node.js
- Experience shipping LLM features with evals, prompt versioning and regression detection
- Familiarity with the Model Context Protocol or similar tool-calling interfaces
- Comfort owning infrastructure: Postgres, CI/CD, cloud deployment`,
  },
  {
    id: 'fullstack-product',
    roleType: 'Full-stack product engineering',
    jobDescription: `Job title: Full-Stack Product Engineer

A growing commerce company is looking for a Full-Stack Product Engineer to build customer-facing features across a Next.js storefront and a Postgres-backed API.

You will:
- Build features end to end in React, Next.js and TypeScript
- Design data models with Prisma and PostgreSQL
- Integrate payments and subscriptions with Stripe
- Write tests with Playwright and Vitest and keep CI green`,
  },
  {
    id: 'frontend-design-systems',
    roleType: 'Frontend and design systems',
    jobDescription: `Job title: Senior Frontend Engineer, Design Systems

Our design systems team needs a Senior Frontend Engineer to evolve a shared React component library used across several products.

Responsibilities:
- Build accessible, type-safe React components in TypeScript
- Raise test coverage with Jest and React Testing Library
- Drive Section 508 and WCAG compliance across teams
- Partner with designers to turn Figma specs into production UI`,
  },
  {
    id: 'platform-backend',
    roleType: 'Backend and platform',
    jobDescription: `Job title: Backend Platform Engineer

We're seeking a Backend Platform Engineer to own services, data and deployment for an API platform.

What you'll do:
- Build and operate REST and GraphQL APIs in Node.js
- Manage PostgreSQL schemas, migrations and performance
- Run services on managed cloud platforms with CI/CD pipelines
- Instrument systems for reliability and on-call readiness`,
  },
]
