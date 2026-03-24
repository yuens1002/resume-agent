import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import type { Project } from '../types.js'

const app = new Hono()

// GET /projects — lightweight list of all projects
app.get('/', async (c) => {
  const { data, error } = await supabase
    .from('public_profile')
    .select('projects')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !data) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  const projects: Project[] = data.projects ?? []

  return c.json(
    projects.map(({ name, slug, description, role, tech, status, started, url, repo }) => ({
      name,
      slug,
      description,
      role,
      tech,
      status,
      started,
      url,
      repo,
    }))
  )
})

// GET /projects/:slug — full project detail
app.get('/:slug', async (c) => {
  const slug = c.req.param('slug')

  const { data, error } = await supabase
    .from('public_profile')
    .select('projects')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !data) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  const projects: Project[] = data.projects ?? []
  const project = projects.find((p) => p.slug === slug)

  if (!project) {
    return c.json({ error: `Project '${slug}' not found` }, 404)
  }

  return c.json(project)
})

export default app
