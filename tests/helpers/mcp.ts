/**
 * Shared MCP JSON-RPC test helper.
 * Creates a stateful client that tracks the mcp-session-id across calls.
 */

export type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }

export function createMcpClient(mcpUrl: string, mcpKey: string) {
  let sessionId: string | undefined

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-brain-key": mcpKey,
    }
    if (sessionId) headers["mcp-session-id"] = sessionId

    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })

    if (!sessionId) {
      sessionId = res.headers.get("mcp-session-id") ?? undefined
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`MCP request failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
    }

    const text = await res.text()

    if (text.includes("data:")) {
      const lines = text.split("\n").filter((l) => l.startsWith("data:"))
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
    return result.content.map((c) => c.text).join("\n")
  }

  return { callTool, getText }
}
