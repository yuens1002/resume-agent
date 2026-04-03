/**
 * update_profile MCP tool — integration tests
 *
 * Calls the live MCP server over HTTP, exercises `update_profile` end-to-end
 * against the real Supabase database, and restores the original value after.
 *
 * Requirements:
 *   MCP_URL        — e.g. https://agent.yuens.me/mcp (or local http://localhost:3000/mcp)
 *   OPEN_BRAIN_KEY — the x-brain-key value
 *
 * Run:
 *   npm run test:integration
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { config } from "dotenv";
import { createMcpClient } from "./helpers/mcp.js";

config({ path: ".env.local" });

const MCP_URL = process.env.MCP_URL ?? `http://localhost:${process.env.PORT ?? 3000}/mcp`;
const MCP_KEY = process.env.OPEN_BRAIN_KEY;

if (!MCP_KEY) {
  throw new Error("OPEN_BRAIN_KEY must be set in .env.local");
}

const SUPA_URL = process.env.SUPA_PROJECT_URL;
const SUPA_ROLE_KEY = process.env.SUPA_SERVICE_ROLE;
if (!SUPA_URL || !SUPA_ROLE_KEY) {
  throw new Error("SUPA_PROJECT_URL and SUPA_SERVICE_ROLE must be set in .env.local (required for restore)");
}

const { callTool, getText } = createMcpClient(MCP_URL, MCP_KEY);

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
