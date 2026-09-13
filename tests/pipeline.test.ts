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
import { createHash } from "node:crypto";
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

  it("log_application — attaches resume content and file, creating the durable evidence bundle", async () => {
    const docxBytes = Buffer.from("fake docx bytes for pipeline test");
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_evidence`,
      role: TEST_ROLE,
      job_description: SAMPLE_JD,
      source: "test",
      resume_content: { summary: "Test summary", skills: ["TypeScript"] },
      docx_base64: docxBytes.toString("base64"),
    });
    const text = getText(result);
    assert.doesNotMatch(text, /evidence bundle not fully saved/, "Evidence bundle should save without error");

    const match = text.match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a UUID");
    const evidenceAppId = match[1];

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);

    const { data: resumeRows } = await supabase
      .from("application_resumes")
      .select("resume_content, docx_url, docx_hash, is_submitted")
      .eq("application_id", evidenceAppId);
    assert.equal(resumeRows?.length, 1, "Should create exactly one application_resumes row");
    assert.equal(resumeRows![0].is_submitted, true);
    assert.deepEqual(resumeRows![0].resume_content, { summary: "Test summary", skills: ["TypeScript"] });
    assert.equal(resumeRows![0].docx_hash, createHash("sha256").update(docxBytes).digest("hex"));

    const { data: scoreRows } = await supabase
      .from("application_scores")
      .select("score_type, model")
      .eq("application_id", evidenceAppId);
    assert.equal(scoreRows?.length, 1);
    assert.equal(scoreRows![0].score_type, "jd_fit");
    assert.ok(scoreRows![0].model, "Should record a resolved model identifier, not null");

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from("resume-artifacts")
      .download(resumeRows![0].docx_url);
    assert.ok(!downloadErr, `Uploaded blob should be downloadable: ${downloadErr?.message}`);
    const downloadedBuf = Buffer.from(await fileData!.arrayBuffer());
    assert.equal(downloadedBuf.toString(), docxBytes.toString(), "Downloaded blob should match what was uploaded");

    // get_application is the actual read path other callers use — verify it
    // surfaces the evidence bundle too, not just the raw table rows.
    const getResult = await callTool("get_application", { application_id: evidenceAppId });
    const getText_ = getText(getResult);
    assert.match(getText_, /\[submitted\]/, "Should show the submitted resume version");
    assert.match(getText_, new RegExp(resumeRows![0].docx_hash), "Should surface the docx hash");
    assert.match(getText_, /Test summary/, "Should surface the submitted resume content");
    assert.match(getText_, /Score history:/);
    assert.match(getText_, /\[jd_fit\]/);

    await supabase.storage.from("resume-artifacts").remove([resumeRows![0].docx_url]);
    await supabase.from("job_applications").delete().eq("id", evidenceAppId);
  });

  it("log_application — attaches a PDF-only evidence bundle (separate upload/hash path from docx)", async () => {
    const pdfBytes = Buffer.from("fake pdf bytes for pipeline test");
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_pdfonly`,
      role: TEST_ROLE,
      source: "test",
      resume_content: { summary: "PDF-only summary" },
      pdf_base64: pdfBytes.toString("base64"),
    });
    const text = getText(result);
    assert.doesNotMatch(text, /evidence bundle not fully saved/);

    const match = text.match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a UUID");
    const pdfAppId = match[1];

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data: resumeRows } = await supabase
      .from("application_resumes")
      .select("pdf_url, pdf_hash, docx_url, docx_hash")
      .eq("application_id", pdfAppId);
    assert.equal(resumeRows?.length, 1);
    assert.equal(resumeRows![0].pdf_hash, createHash("sha256").update(pdfBytes).digest("hex"));
    assert.equal(resumeRows![0].docx_url, null, "No docx was sent, so docx_url must stay null");
    assert.equal(resumeRows![0].docx_hash, null);

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from("resume-artifacts")
      .download(resumeRows![0].pdf_url);
    assert.ok(!downloadErr, `PDF blob should be downloadable: ${downloadErr?.message}`);
    const downloadedBuf = Buffer.from(await fileData!.arrayBuffer());
    assert.equal(downloadedBuf.toString(), pdfBytes.toString());

    await supabase.storage.from("resume-artifacts").remove([resumeRows![0].pdf_url]);
    await supabase.from("job_applications").delete().eq("id", pdfAppId);
  });

  it("log_application — records the jd_fit score even when no resume evidence is attached", async () => {
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_scoreonly`,
      role: TEST_ROLE,
      job_description: SAMPLE_JD,
      source: "test",
    });
    const text = getText(result);
    const match = text.match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a UUID");
    const scoreOnlyAppId = match[1];

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data: scoreRows } = await supabase
      .from("application_scores")
      .select("score_type, resume_id, model")
      .eq("application_id", scoreOnlyAppId);
    assert.equal(scoreRows?.length, 1, "Score history must not be skipped just because no resume was attached");
    assert.equal(scoreRows![0].score_type, "jd_fit");
    assert.equal(scoreRows![0].resume_id, null, "No resume was attached, so resume_id should be null, not a defect");

    await supabase.from("job_applications").delete().eq("id", scoreOnlyAppId);
  });

  it("log_application + confirm_application_submission keep the real writer path and exact evidence consistent", async () => {
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_draft`,
      role: TEST_ROLE,
      job_description: SAMPLE_JD,
      source: "test",
      resume_content: { summary: "Draft summary" },
      is_submitted: false,
    });
    const text = getText(result);
    const match = text.match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a UUID");
    const draftAppId = match[1];

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);

    const { data: appRow } = await supabase
      .from("job_applications")
      .select("stage")
      .eq("id", draftAppId)
      .single();
    assert.equal(appRow?.stage, "draft", "A logged-but-not-submitted application must not count as 'applied'");

    const { data: stageRows } = await supabase
      .from("application_stages")
      .select("stage")
      .eq("application_id", draftAppId);
    assert.equal(stageRows?.[0]?.stage, "draft");

    const { data: resumeRows } = await supabase
      .from("application_resumes")
      .select("id, is_submitted")
      .eq("application_id", draftAppId);
    assert.equal(resumeRows?.[0]?.is_submitted, false);

    const bypass = await callTool("update_stage", {
      application_id: draftAppId,
      stage: "phone_screen",
    });
    assert.match(getText(bypass), /confirm_application_submission/);

    const confirmation = await callTool("confirm_application_submission", {
      application_id: draftAppId,
      resume_id: resumeRows![0].id,
      note: "Integration-test confirmation",
    });
    assert.match(getText(confirmation), /draft.*applied/);

    const { data: confirmedApp } = await supabase
      .from("job_applications")
      .select("stage")
      .eq("id", draftAppId)
      .single();
    assert.equal(confirmedApp?.stage, "applied");

    const { data: confirmedResumeRows } = await supabase
      .from("application_resumes")
      .select("id, is_submitted")
      .eq("application_id", draftAppId);
    assert.equal(confirmedResumeRows?.length, 1);
    assert.equal(confirmedResumeRows?.[0]?.id, resumeRows![0].id);
    assert.equal(confirmedResumeRows?.[0]?.is_submitted, true);

    const { data: confirmedStageRows } = await supabase
      .from("application_stages")
      .select("stage, note")
      .eq("application_id", draftAppId);
    assert.equal(confirmedStageRows?.filter(row => row.stage === "draft").length, 1);
    assert.equal(confirmedStageRows?.filter(row => row.stage === "applied").length, 1);
    assert.ok(confirmedStageRows?.some(row => row.stage === "applied" && row.note === "Integration-test confirmation"));

    await supabase.from("job_applications").delete().eq("id", draftAppId);
  });

  it("log_application — rejects a draft without durable resume evidence", async () => {
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_missingdraftproof`,
      role: TEST_ROLE,
      source: "test",
      is_submitted: false,
    });
    const text = getText(result);
    assert.match(text, /requires tailored resume_content, docx_base64, or pdf_base64/);
    assert.doesNotMatch(text, /ID: [0-9a-f-]{36}/);
  });

  it("update_stage — cannot revive a terminal draft into the submitted pipeline without confirmation evidence", async () => {
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_terminaldraft`,
      role: TEST_ROLE,
      source: "test",
      resume_content: { summary: "Terminal draft summary" },
      is_submitted: false,
    });
    const match = getText(result).match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a UUID");
    const terminalDraftAppId = match[1];

    const rejected = await callTool("update_stage", {
      application_id: terminalDraftAppId,
      stage: "rejected",
    });
    assert.match(getText(rejected), /draft.*rejected/);

    for (const stage of ["applied", "phone_screen"]) {
      const bypass = await callTool("update_stage", { application_id: terminalDraftAppId, stage });
      assert.match(getText(bypass), /cannot re-enter the submitted pipeline/);
    }

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data: appRow } = await supabase
      .from("job_applications")
      .select("stage")
      .eq("id", terminalDraftAppId)
      .single();
    assert.equal(appRow?.stage, "rejected");
    const { data: resumeRows } = await supabase
      .from("application_resumes")
      .select("is_submitted")
      .eq("application_id", terminalDraftAppId);
    assert.equal(resumeRows?.[0]?.is_submitted, false);

    await supabase.from("job_applications").delete().eq("id", terminalDraftAppId);
  });

  it("update_stage — permits an active-stage correction back to applied", async () => {
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_activecorrection`,
      role: TEST_ROLE,
      source: "test",
    });
    const match = getText(result).match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a UUID");
    const activeAppId = match[1];

    const advanced = await callTool("update_stage", { application_id: activeAppId, stage: "phone_screen" });
    assert.match(getText(advanced), /applied.*phone_screen/);
    const corrected = await callTool("update_stage", { application_id: activeAppId, stage: "applied" });
    assert.match(getText(corrected), /phone_screen.*applied/);

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data: appRow } = await supabase
      .from("job_applications")
      .select("stage")
      .eq("id", activeAppId)
      .single();
    assert.equal(appRow?.stage, "applied");

    await supabase.from("job_applications").delete().eq("id", activeAppId);
  });

  it("log_application — omitting is_submitted still defaults to stage 'applied' (existing callers unaffected)", async () => {
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_defaultsubmitted`,
      role: TEST_ROLE,
      job_description: SAMPLE_JD,
      source: "test",
    });
    const text = getText(result);
    const match = text.match(/ID: ([0-9a-f-]{36})/);
    assert.ok(match, "Response should contain a UUID");
    const defaultAppId = match[1];

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPA_URL!, SUPA_ROLE_KEY!);
    const { data: appRow } = await supabase
      .from("job_applications")
      .select("stage")
      .eq("id", defaultAppId)
      .single();
    assert.equal(appRow?.stage, "applied");

    await supabase.from("job_applications").delete().eq("id", defaultAppId);
  });

  it("log_application — malformed base64 fails the evidence bundle but not the application log", async () => {
    const result = await callTool("log_application", {
      company: `${TEST_COMPANY}_badb64`,
      role: TEST_ROLE,
      docx_base64: "not-valid-base64!!!",
    });
    const text = getText(result);
    assert.match(text, /Application logged/, "Application itself must still be logged");
    assert.match(text, /evidence bundle not fully saved/);
    assert.match(text, /not valid base64/);

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
