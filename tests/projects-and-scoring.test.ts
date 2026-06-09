/**
 * score_match + upsert_project MCP tools — integration tests
 *
 * Calls the live MCP server over HTTP against the real Supabase database.
 * Projects array and updated_at are snapshotted before and restored after.
 *
 * Requirements:
 *   MCP_URL        — e.g. https://agent.yuens.me/mcp (or http://localhost:3000/mcp)
 *   OPEN_BRAIN_KEY — the x-brain-key value
 *   SUPA_PROJECT_URL + SUPA_SERVICE_ROLE — for snapshot/restore
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

// ── Constants ─────────────────────────────────────────────

const PROFILE_ID = "00000000-0000-0000-0000-000000000001";
const TEST_SLUG = `__test_project_${Date.now()}`;

const SAMPLE_JD = `
  Senior TypeScript Engineer — 4+ years required.
  Required: TypeScript, Node.js, REST API design, PostgreSQL.
  Nice to have: React, Docker.
  Remote-first, IC role on a small product team.
`;

// ── Test state ────────────────────────────────────────────

let snapshotTaken = false;
let originalProjects: unknown[];
let originalUpdatedAt: string;

// ── Tests ─────────────────────────────────────────────────

describe("score_match + upsert_project MCP tools", () => {
  before(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data, error } = await supabase
      .from("public_profile")
      .select("projects, updated_at")
      .eq("id", PROFILE_ID)
      .single();
    if (error || !data) throw new Error(`Could not snapshot profile: ${error?.message}`);
    originalProjects = data.projects ?? [];
    originalUpdatedAt = data.updated_at;
    snapshotTaken = true;
  });

  after(async () => {
    if (!snapshotTaken) return;
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { error } = await supabase
      .from("public_profile")
      .update({ projects: originalProjects, updated_at: originalUpdatedAt })
      .eq("id", PROFILE_ID);
    if (error) console.warn(`Restore warning: ${error.message}`);
  });

  it("score_match — returns a valid fit score for a sample JD", async () => {
    const result = await callTool("score_match", { job_description: SAMPLE_JD });
    const text = getText(result);
    assert.ok(!result.isError, `Expected success, got error: ${text}`);
    assert.match(text, /Fit score:/, "Response should contain fit score");
    assert.match(text, /Verdict:/, "Response should contain verdict");
    assert.match(text, /apply|pass/, "Response should contain recommended action");
  });

  it("upsert_project — inserts a new project when slug is new", async () => {
    const result = await callTool("upsert_project", {
      slug: TEST_SLUG,
      name: "Test Project",
      description: "A test project for integration testing",
      problem: "Verifying upsert works",
      role: "Author",
      tech: ["TypeScript", "Node.js"],
      highlights: ["Created for test purposes"],
      status: "active",
    });
    const text = getText(result);
    assert.ok(!result.isError, `Expected success, got error: ${text}`);
    assert.match(text, /added/, "Should confirm project was added");
    assert.match(text, new RegExp(TEST_SLUG), "Should mention the slug");
  });

  it("upsert_project — merges an existing project without overwriting unspecified fields", async () => {
    const result = await callTool("upsert_project", {
      slug: TEST_SLUG,
      url: "https://example.com/test",
    });
    const text = getText(result);
    assert.ok(!result.isError, `Expected success, got error: ${text}`);
    assert.match(text, /updated/, "Should confirm project was updated");

    // Verify the merge — name should be preserved, url should be new
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data, error } = await supabase
      .from("public_profile")
      .select("projects")
      .eq("id", PROFILE_ID)
      .single();
    assert.ok(!error && data, "Should be able to read profile");
    const project = (data.projects as { slug: string; name?: string; url?: string }[])
      .find((p) => p.slug === TEST_SLUG);
    assert.ok(project, "Test project should still exist");
    assert.equal(project.name, "Test Project", "Name should be preserved after merge");
    assert.equal(project.url, "https://example.com/test", "URL should be updated");
  });

  it("upsert_project — persists sync escape hatch fields (skipChangelog, docsPath, featureDocsGlobs)", async () => {
    const result = await callTool("upsert_project", {
      slug: TEST_SLUG,
      skipChangelog: true,
      docsPath: "docs/architecture.md",
      featureDocsGlobs: ["docs/features"],
    });
    const text = getText(result);
    assert.ok(!result.isError, `Expected success, got error: ${text}`);

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data, error } = await supabase
      .from("public_profile")
      .select("projects")
      .eq("id", PROFILE_ID)
      .single();
    assert.ok(!error && data, "Should be able to read profile");
    const project = (data.projects as {
      slug: string
      skipChangelog?: boolean
      docsPath?: string
      featureDocsGlobs?: string[]
    }[]).find((p) => p.slug === TEST_SLUG);
    assert.ok(project, "Test project should still exist");
    assert.equal(project.skipChangelog, true, "skipChangelog should be persisted");
    assert.equal(project.docsPath, "docs/architecture.md", "docsPath should be persisted");
    assert.deepEqual(project.featureDocsGlobs, ["docs/features"], "featureDocsGlobs should be persisted");
  });
});
