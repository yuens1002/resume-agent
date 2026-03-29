/**
 * Job Hunt Pipeline — integration tests
 *
 * Calls the live OB1 MCP Edge Function over HTTP, exercising all 7 pipeline
 * tools end-to-end against the real Supabase database.
 *
 * Requirements:
 *   SUPABASE_MCP_URL   — e.g. https://<ref>.supabase.co/functions/v1/open-brain-mcp
 *   MCP_ACCESS_KEY     — the x-brain-key value
 *
 * Run:
 *   npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { config } from "dotenv";

config({ path: ".env.local" });

const MCP_URL = process.env.SUPABASE_MCP_URL;
const MCP_KEY = process.env.MCP_ACCESS_KEY;

if (!MCP_URL || !MCP_KEY) {
  console.error("SUPABASE_MCP_URL and MCP_ACCESS_KEY must be set in .env.local");
  process.exit(1);
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

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });

  const res = await fetch(MCP_URL!, { method: "POST", headers, body });

  if (!sessionId) {
    sessionId = res.headers.get("mcp-session-id") ?? undefined;
  }

  const text = await res.text();

  // SSE response: extract the last `data:` line that contains a JSON-RPC result
  if (text.includes("data:")) {
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    for (const line of lines.reverse()) {
      try {
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.result) return payload.result;
        if (payload.error) throw new Error(JSON.stringify(payload.error));
      } catch {
        /* skip non-JSON lines */
      }
    }
    throw new Error(`No result in SSE response: ${text.slice(0, 200)}`);
  }

  const payload = JSON.parse(text);
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.result;
}

function getText(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c: { type: string; text: string }) => c.text).join("\n");
}

// ── Test state ────────────────────────────────────────────

let applicationId: string;
let contactId: string;

const TEST_COMPANY = `__test_${Date.now()}`;
const TEST_ROLE = "Senior TypeScript Engineer";
const SAMPLE_JD = `
  We are looking for a Senior TypeScript Engineer with 4+ years of experience.
  Required: TypeScript, Node.js, REST API design, PostgreSQL.
  Nice to have: React, Docker.
  You will build and maintain backend services in a remote-first team.
`;

// ── Tests ─────────────────────────────────────────────────

describe("Job Hunt Pipeline", () => {
  after(async () => {
    // Clean up test data so repeated runs don't accumulate rows
    if (applicationId) {
      // Deleting the application cascades to stages and contacts via FK
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(
        process.env.SUPA_PROJECT_URL!,
        process.env.SUPA_SERVICE_ROLE!
      );
      await supabase.from("job_applications").delete().eq("id", applicationId);
    }
  });

  it("log_application — creates an application and returns an ID", async () => {
    const result = await callTool("log_application", {
      company: TEST_COMPANY,
      role: TEST_ROLE,
      source: "test",
      notes: "Automated test run",
    });
    const text = getText(result);
    assert.match(text, /Application logged/);
    assert.match(text, new RegExp(TEST_COMPANY));

    // Extract the ID for subsequent tests
    const match = text.match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a UUID");
    applicationId = match[1];
  });

  it("log_application — auto-scores when JD is provided", async () => {
    // Create a second application with a JD to verify scoring
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_scored`,
      role: TEST_ROLE,
      job_description: SAMPLE_JD,
      source: "test",
    });
    const text = getText(result);
    assert.match(text, /Fit:/, "Should include fit score when JD is provided");
    assert.doesNotMatch(text, /not scored/, "Should not say 'not scored' when JD provided");

    // Clean up the scored test application
    const match = text.match(/ID: ([0-9a-f-]{36})/);
    if (match) {
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(
        process.env.SUPA_PROJECT_URL!,
        process.env.SUPA_SERVICE_ROLE!
      );
      await supabase.from("job_applications").delete().eq("id", match[1]);
    }
  });

  it("update_stage — moves application to phone_screen", async () => {
    const result = await callTool("update_stage", {
      application_id: applicationId,
      stage: "phone_screen",
      note: "Recruiter reached out",
    });
    const text = getText(result);
    assert.match(text, /applied.*phone_screen|phone_screen/);
  });

  it("add_contact — attaches a contact to the application", async () => {
    const result = await callTool("add_contact", {
      application_id: applicationId,
      name: "Test Recruiter",
      title: "Senior Recruiter",
      notes: "Friendly, responded quickly",
    });
    const text = getText(result);
    assert.match(text, /Contact added/);
    assert.match(text, /Test Recruiter/);

    const match = text.match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a contact UUID");
    contactId = match[1];
  });

  it("set_follow_up — sets a follow-up date", async () => {
    const nextWeek = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
    const result = await callTool("set_follow_up", {
      application_id: applicationId,
      follow_up_date: nextWeek,
      notes: "Check in on next steps",
    });
    const text = getText(result);
    assert.match(text, /Follow-up set/);
    assert.match(text, new RegExp(nextWeek));
  });

  it("list_applications — returns the test application", async () => {
    const result = await callTool("list_applications", {
      company: TEST_COMPANY,
      limit: 5,
    });
    const text = getText(result);
    assert.match(text, new RegExp(TEST_COMPANY));
    assert.match(text, new RegExp(applicationId));
  });

  it("list_applications — upcoming_followups filter returns the application", async () => {
    const result = await callTool("list_applications", {
      upcoming_followups: true,
      limit: 20,
    });
    const text = getText(result);
    // The application we just set a follow-up on should appear
    assert.match(text, new RegExp(applicationId));
  });

  it("get_application — returns full details including contact and stage history", async () => {
    const result = await callTool("get_application", {
      application_id: applicationId,
    });
    const text = getText(result);
    assert.match(text, new RegExp(TEST_COMPANY));
    assert.match(text, /phone_screen/);
    assert.match(text, /Test Recruiter/);
    assert.match(text, /Stage history/);
  });

  it("search_applications — finds the application by company name", async () => {
    const result = await callTool("search_applications", {
      query: TEST_COMPANY,
      limit: 5,
    });
    const text = getText(result);
    assert.match(text, new RegExp(TEST_COMPANY));
    assert.match(text, new RegExp(applicationId));
  });
});
