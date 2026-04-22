/**
 * Shared MCP JSON-RPC test helper — stateless transport.
 *
 * Each callTool() is a fully independent POST. No mcp-session-id is tracked
 * or sent. This matches the stateless Streamable HTTP transport on the server.
 */

export type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }

export function createMcpClient(mcpUrl: string, mcpKey: string) {
  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'x-brain-key': mcpKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`MCP request failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
    }

    const text = await res.text()

    if (text.includes('data:')) {
      const lines = text.split('\n').filter(l => l.startsWith('data:'))
      for (const line of lines.reverse()) {
        try {
          const payload = JSON.parse(line.slice(5).trim())
          if (payload.result) return payload.result
          if (payload.error) throw new Error(JSON.stringify(payload.error))
        } catch { /* skip non-JSON lines */ }
      }
      throw new Error(`No result in SSE response: ${text.slice(0, 200)}`)
    }

    const payload = JSON.parse(text)
    if (payload.error) throw new Error(JSON.stringify(payload.error))
    return payload.result
  }

  function getText(result: ToolResult): string {
    return result.content.map(c => c.text).join('\n')
  }

  return { callTool, getText }
}
