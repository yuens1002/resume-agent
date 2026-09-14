import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  GetApplicationResumeArtifactInputSchema,
  getApplicationResumeArtifact,
  type ApplicationResumeArtifactSource,
} from './application-resume-artifact.js'

export function registerApplicationResumeArtifactTool(server: McpServer, source: ApplicationResumeArtifactSource) {
  server.registerTool('get_application_resume_artifact', {
    title: 'Get Application Resume Artifact',
    description: 'Read one bounded private DOCX or PDF artifact by application and resume IDs. The server resolves its stored path, verifies its SHA-256 hash, and never accepts an arbitrary URL or storage path.',
    inputSchema: GetApplicationResumeArtifactInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    const result = await getApplicationResumeArtifact(input, source)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: result.status === 'refused',
    }
  })
}
