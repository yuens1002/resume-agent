/**
 * update_profile MCP tool — integration tests
 *
 * Calls the live MCP server over HTTP, exercises `update_profile` end-to-end
 * against the real Supabase database, and restores the original value after.
 *
 * Requirements:
 *   MCP_URL        — e.g. https://agent.yuens.me/mcp (or local http://localhost:3000/mcp)
 *   MCP_ACCESS_KEY — the x-brain-key value
 *
 * Run:
 *   npm run test:integration
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { config } from "dotenv";

config({ path: ".env.local" });

const MCP_URL = process.env.MCP_URL ?? `http://localhost:${process.env.PORT ?? 3000}/mcp`;
const MCP_KEY = process.env.MCP_ACCESS_KEY;

if (!MCP_KEY) {
  throw new Error("MCP_ACCESS_KEY must be set in .env.local");
}

const SUPA_URL = process.env.SUPA_PROJECT_URL;
const SUPA_ROLE_KEY = process.env.SUPA_SERVICE_ROLE;
if (!SUPA_URL || !SUPA_ROLE_KEY) {
  throw new Error("SUPA_PROJECT_URL and SUPA_SERVICE_ROLE must be set in .env.local (required for restore)");
}

// ── MCP JSON-RPC helper ───────────────────────────────────

let sessionId: string | undefined;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-brain-key": MCP_KEY!,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (!sessionId) {
    sessionId = res.headers.get("mcp-session-id") ?? undefined;
  }

  const text = await res.text();

  if (text.includes("data:")) {
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    for (const line of lines.reverse()) {
      try {
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.result) return payload.result;
        if (payload.error) throw new Error(JSON.stringify(payload.error));
      } catch { /* skip */ }
    }
    throw new Error(`No result in SSE response: ${text.slice(0, 200)}`);
  }

  const payload = JSON.parse(text);
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.result;
}

function getText(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

// ── Tests ─────────────────────────────────────────────────

const PROFILE_ID = "00000000-0000-0000-0000-000000000001";
let originalSummary: string;

describe("update_profile MCP tool", () => {
  before(async () => {
    // Snapshot current summary so we can restore it after
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data, error } = await supabase
      .from("public_profile")
      .select("summary")
      .eq("id", PROFILE_ID)
      .single();
    if (error || !data) throw new Error(`Could not read profile for snapshot: ${error?.message}`);
    originalSummary = data.summary;
  });

  after(async () => {
    // Restore original summary
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { error } = await supabase
      .from("public_profile")
      .update({ summary: originalSummary })
      .eq("id", PROFILE_ID);
    if (error) console.warn(`Restore warning: ${error.message}`);
  });

  it("update_profile — updates a field and confirms success", async () => {
    const testSummary = `__test_summary_${Date.now()}`;
    const result = await callTool("update_profile", { summary: testSummary });
    const text = getText(result);
    assert.ok(text.includes("summary"), `Expected 'summary' in response, got: ${text}`);
    assert.ok(!result.isError, `Expected success, got error: ${text}`);
  });

  it("update_profile — no fields returns informational message, not error", async () => {
    const result = await callTool("update_profile", {});
    const text = getText(result);
    assert.ok(text.toLowerCase().includes("no fields"), `Expected 'no fields' message, got: ${text}`);
    assert.ok(!result.isError, `Should not be an error response`);
  });
});
