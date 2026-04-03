/**
 * Job Hunt Pipeline — integration tests
 *
 * Calls the live OB1 MCP server (Railway) over HTTP, exercising all 7 pipeline
 * tools end-to-end against the real Supabase database.
 *
 * Requirements:
 *   MCP_URL        — e.g. https://agent.yuens.me/mcp (or http://localhost:3000/mcp)
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
  throw new Error("SUPA_PROJECT_URL and SUPA_SERVICE_ROLE must be set in .env.local (required for test cleanup)");
}

// ── MCP helper ───────────────────────────────────────────

const { callTool, getText } = createMcpClient(MCP_URL, MCP_KEY!);

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
    // Deleting the application cascades to stages and contacts via FK
    if (applicationId) {
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
      const { error } = await supabase.from("job_applications").delete().eq("id", applicationId);
      if (error) console.warn(`Cleanup warning: failed to delete test application ${applicationId}: ${error.message}`);
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
      const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
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
