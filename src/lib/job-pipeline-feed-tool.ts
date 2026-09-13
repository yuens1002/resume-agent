import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { JobFeedInputSchema, readJobPipelineFeed, type JobFeedRpc } from './job-pipeline-feed.js'

export function registerJobPipelineFeed(server: McpServer, rpc: JobFeedRpc) {
  server.registerTool('get_job_pipeline_feed', {
    title: 'Job Pipeline Summary, Changes and Due Work',
    description: 'Read recorded application totals, changes after a saved cursor, and due/overdue follow-ups. Omit cursor for an explicit baseline. Returns a proposed next cursor; persist it only after downstream processing succeeds. A refusal has no checkpoint. Totals cover recorded applications, not verified real-world submission completeness.',
    inputSchema: JobFeedInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    const result = await readJobPipelineFeed(input, rpc)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: result.status === 'refused',
    }
  })
}
