#!/usr/bin/env node
// .claude/hooks/block-direct-main-commit-node.js
//
// Claude Code PreToolUse hook — blocks `git commit` when current branch is
// main/master, directing the agent to use the /commit skill (which creates
// a feature branch, updates CHANGELOG + roadmap + version, opens a PR,
// waits for Copilot review, and squash-merges).
//
// This enforces the rule established in .claude/retro-log.md (2026-04-05):
//   "The rule is unambiguous: branch → PR → Copilot review → merge.
//    Direct-to-main is never correct for substantive changes."
//
// Allowed:
//   - git commit on any non-main branch
//   - git commit --amend (escape hatch for fixups during the /commit flow)
//
// Blocked:
//   - git commit (without --amend) while on main / master
//
// Exit code 0 = allow, exit code 2 = block (reason on stderr).

import { execSync } from "node:child_process";

function deny(reason) {
  process.stderr.write(reason);
  process.exit(2);
}

/**
 * Strip single- and double-quoted string contents so their bodies don't
 * contribute to flag/subcommand detection. Handles escaped quotes inside.
 */
function stripQuotedStrings(s) {
  return s
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * Detect `git commit` as a real invocation, not a substring in a message.
 * Handles wrappers: `cd x && git commit`, `git -C path commit`,
 * `GIT_EDITOR=vim git commit`, etc.
 */
function isGitCommit(command) {
  const stripped = stripQuotedStrings(command);
  return /(?:^|[\s;&|])git(?:\s+\S+)*?\s+commit(?:\s|$)/i.test(stripped);
}

/**
 * Detect --amend as a standalone flag, not inside a quoted -m message.
 */
function hasAmendFlag(command) {
  const stripped = stripQuotedStrings(command);
  return /(?:^|\s)--amend(?:\s|=|$)/.test(stripped);
}

function main(input) {
  let command = "";
  try {
    const parsed = JSON.parse(input);
    command = (parsed.tool_input && parsed.tool_input.command) || "";
  } catch {
    process.exit(0);
  }

  if (!isGitCommit(command)) {
    process.exit(0);
  }

  // Allow --amend as an actual flag (escape hatch for fixups during /commit flow)
  if (hasAmendFlag(command)) {
    process.exit(0);
  }

  // Get current branch
  let branch = "";
  try {
    branch = execSync("git branch --show-current", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Can't detect branch — allow (don't block on infra failure)
    process.exit(0);
  }

  if (branch !== "main" && branch !== "master") {
    process.exit(0);
  }

  deny(
    `\n⛔ BLOCKED: direct commit to ${branch}.\n\n` +
      `The /commit skill enforces the ship protocol for this repo:\n` +
      `  • Create a feature branch\n` +
      `  • Update CHANGELOG.md + .claude/docs/roadmap.md (if present)\n` +
      `  • Bump patch version\n` +
      `  • Open PR, wait for Copilot, resolve threads\n` +
      `  • Squash-merge\n\n` +
      `See .claude/commands/commit.md for the full protocol.\n\n` +
      `If this is a genuine fixup during an in-flight /commit flow, use\n` +
      `  git commit --amend\n` +
      `instead.\n\n` +
      `Rule origin: .claude/retro-log.md (2026-04-05, 2026-04-24).\n`,
  );
}

let data = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => main(data));
