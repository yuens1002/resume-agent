import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CreateApplicationEvidenceSnapshotInputSchema,
  GetApplicationEvidenceSnapshotPageInputSchema,
  createApplicationEvidenceSnapshot,
  getApplicationEvidenceSnapshotPage,
  type ApplicationEvidenceSnapshotRpc,
} from './application-evidence-snapshot.js'

export function registerApplicationEvidenceSnapshotTools(server: McpServer, rpc: ApplicationEvidenceSnapshotRpc) {
  server.registerTool('create_application_evidence_snapshot', {
    title: 'Create Application Evidence Snapshot',
    description: 'Materialize a private, immutable application-evidence snapshot for bounded cohort review. This records a protected source snapshot; it does not submit an application or acknowledge downstream processing.',
    inputSchema: CreateApplicationEvidenceSnapshotInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => {
    const result = await createApplicationEvidenceSnapshot(input, rpc)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: result.status === 'refused',
    }
  })

  server.registerTool('get_application_evidence_snapshot_page', {
    title: 'Get Application Evidence Snapshot Page',
    description: 'Read one bounded private page from a previously materialized application-evidence snapshot. The final-page marker means this response is terminal; callers reconcile all page ordinals to the snapshot total.',
    inputSchema: GetApplicationEvidenceSnapshotPageInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    const result = await getApplicationEvidenceSnapshotPage(input, rpc)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: result.status === 'refused',
    }
  })
}
