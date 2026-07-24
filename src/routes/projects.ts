import { Hono } from 'hono'
import { fetchProfile, PROFILE_ERROR_HTTP } from '../lib/profile-cache.js'
import type { Project } from '../types.js'

const app = new Hono()

// GET /projects — project list: summary fields only (excludes highlights, problem, architecture, impact)
// Includes url/repo/started intentionally — useful for list consumers without the full narrative payload
app.get('/', async (c) => {
  const result = await fetchProfile()

  if (result.kind !== 'ok') {
    const { status, body } = PROFILE_ERROR_HTTP[result.kind]
    return c.json(body, status)
  }

  const projects: Project[] = result.profile.projects ?? []

  return c.json(
    projects.map(({ name, slug, description, role, tech, status, started, url, repo, cover }) => ({
      name,
      slug,
      description,
      role,
      tech,
      status,
      started,
      url,
      repo,
      cover,
      // git_evidence excluded from list — detail-view only via GET /projects/:slug
    }))
  )
})

// GET /projects/:slug — full project detail
app.get('/:slug', async (c) => {
  const slug = c.req.param('slug')

  const result = await fetchProfile()

  if (result.kind !== 'ok') {
    const { status, body } = PROFILE_ERROR_HTTP[result.kind]
    return c.json(body, status)
  }

  const projects: Project[] = result.profile.projects ?? []
  const project = projects.find((p) => p.slug === slug)

  if (!project) {
    return c.json({ error: `Project '${slug}' not found` }, 404)
  }

  return c.json(project)
})

export default app
