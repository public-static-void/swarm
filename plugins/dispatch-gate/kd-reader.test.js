// plugins/dispatch-gate/kd-reader.test.js
// Tests for the KD reader utility — frontmatter parsing, section extraction, mode resolution.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import {
  readIntentKd,
  readSpecKd,
  readKd,
  extractSessionDate,
  getPhaseKds,
} from "./kd-reader.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), "kd-reader-test-" + Date.now());
const KNOWLEDGE_DIR = path.join(TMP_DIR, "knowledge");

beforeAll(() => {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** Write a fixture file under the tmp knowledge/ directory. */
function writeFixture(fileName, content) {
  const filePath = path.join(KNOWLEDGE_DIR, fileName);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Relative path as the functions would receive it. */
function relPath(fileName) {
  return path.join(KNOWLEDGE_DIR, fileName);
}

// ---------------------------------------------------------------------------
// Fixture: INTENT KD (with Objective and Success Criteria)
// ---------------------------------------------------------------------------

const INTENT_KD_CONTENT = `---
title: "INTENT: Test Feature — Build authentication"
version: 1.0.0
status: draft
type: intent
created: 2026-07-07
author: Overseer
superseded_by: null
---

## Objective

Build a complete authentication system with JWT tokens and OAuth2 support.

The system must handle login, registration, and token refresh flows.

## Success Criteria

- [ ] Users can register with email and password
- [ ] Users can log in and receive a JWT token
- [ ] Token refresh works within expiry window
- [ ] OAuth2 integration with Google provider
`;

// ---------------------------------------------------------------------------
// Fixture: INTENT KD with ## Fixes instead of ## Success Criteria
// ---------------------------------------------------------------------------

const INTENT_KD_FIXES_CONTENT = `---
title: "INTENT: Fix bug — Login timeout"
version: 1.0.0
status: draft
type: intent
created: 2026-07-07
author: Overseer
superseded_by: null
---

## Objective

Fix the login timeout issue causing 504 errors under load.

## Fixes

### Fix 1 — Increase connection pool
Increase the database connection pool from 10 to 50.

### Fix 2 — Add query timeout
Add a 5-second query timeout to prevent long-running queries from blocking the pool.
`;

// ---------------------------------------------------------------------------
// Fixture: INTENT KD with no Success Criteria or Fixes
// ---------------------------------------------------------------------------

const INTENT_KD_MINIMAL = `---
title: "INTENT: Quick fix"
version: 1.0.0
status: draft
type: intent
created: 2026-07-07
author: Overseer
superseded_by: null
---

## Objective

A quick fix for the login page.
`;

// ---------------------------------------------------------------------------
// Fixture: SPEC KD with requirements and acceptance criteria
// ---------------------------------------------------------------------------

const SPEC_KD_CONTENT = `---
title: "SPEC: Authentication System"
version: 1.0.0
status: draft
type: spec
created: "2026-07-07"
author: Spec Weaver
superseded_by: null
---

# SPEC: Authentication System

## Overview

Complete authentication system specification.

## Functional Requirements

### R001: User Registration
The system must allow users to register with email and password.

### R002: User Login
The system must authenticate users and return JWT tokens.

### R003: Token Refresh
The system must support token refresh via refresh tokens.

## Acceptance Criteria

- [ ] AC001: User registration flow works end-to-end with valid data
- [ ] AC002: Login with valid credentials returns JWT token
- [ ] AC003: Login with invalid credentials returns 401
- [ ] AC004: Token refresh works within 15-minute expiry window
`;

// ---------------------------------------------------------------------------
// Fixture: SPEC KD with inline bold requirements
// ---------------------------------------------------------------------------

const SPEC_KD_BOLD = `---
title: "SPEC: Simple Config"
version: 1.0.0
status: draft
type: spec
created: "2026-07-07"
author: Spec Weaver
superseded_by: null
---

# SPEC: Simple Config

**R001**: Config must be loaded from YAML files.
**R002**: Config must support environment variable overrides.

## Acceptance Criteria

- **AC001**: Loading a valid YAML config succeeds
- **AC002**: Environment vars override file values
`;

// ---------------------------------------------------------------------------
// Fixture: Generic KD (exploration)
// ---------------------------------------------------------------------------

const EXPLORATION_KD_CONTENT = `---
title: "EXPLORATION: Codebase structure analysis"
version: 1.0.0
status: draft
type: exploration
created: 2026-07-07
author: Explorer
superseded_by: null
---

This exploration covers the authentication module in the codebase. It identifies key components, data flow, and potential risks.

## Key Findings

- Authentication uses Passport.js with JWT strategy
- Token expiry is handled by the auth middleware
`;

// ---------------------------------------------------------------------------
// Fixture: KD with no frontmatter
// ---------------------------------------------------------------------------

const NO_FRONTMATTER_KD = `# Just a heading

Some content here without frontmatter.
`;

// ---------------------------------------------------------------------------
// Fixture: KD with invalid frontmatter
// ---------------------------------------------------------------------------

const INVALID_FRONTMATTER_KD = `---
title: "Broken
no closing quote
version: oops
---

Body content here
`;

// ---------------------------------------------------------------------------
// Fixtures for getPhaseKds tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Create a full set of session KDs for date 2026-07-07
  writeFixture("intent-auth-2026-07-07.md", INTENT_KD_CONTENT);
  writeFixture("spec-auth-2026-07-07.md", SPEC_KD_CONTENT);
  writeFixture("exploration-auth-2026-07-07.md", EXPLORATION_KD_CONTENT);
  writeFixture("analysis-auth-2026-07-07.md", `---
title: "ANALYSIS: Auth perf"
type: analysis
created: 2026-07-07
---
Analysis body`);
  writeFixture("plan-auth-2026-07-07.md", `---
title: "PLAN: Auth impl"
type: plan
created: 2026-07-07
---
Plan body`);
  writeFixture("impl-auth-2026-07-07.md", `---
title: "IMPL: Auth impl"
type: impl
created: 2026-07-07
---
Impl body`);
  writeFixture("review-auth-2026-07-07.md", `---
title: "REVIEW: Auth impl"
type: review
created: 2026-07-07
---
Review body`);
  writeFixture("process-auth-2026-07-07.md", `---
title: "PROCESS: Auth friction"
type: process
created: 2026-07-07
---
Process body`);
  writeFixture("composed-auth-2026-07-07.md", `---
title: "COMPOSED: Auth session"
type: composed
created: 2026-07-07
---
Composed body`);
  writeFixture("report-auth-2026-07-07.md", `---
title: "REPORT: Auth session"
type: report
created: 2026-07-07
---
Report body`);
  // A KD from a different date
  writeFixture("intent-other-2026-07-06.md", `---
title: "INTENT: Other"
type: intent
created: 2026-07-06
---
Other`);
});

// ===========================================================================
// Tests: YAML frontmatter parsing (internal via readKd)
// ===========================================================================

describe("YAML frontmatter parsing", () => {
  it("parses title, type, created from a valid KD", () => {
    const result = readKd(relPath("exploration-auth-2026-07-07.md"));
    expect(result.title).toBe("EXPLORATION: Codebase structure analysis");
    expect(result.type).toBe("exploration");
    expect(result.created).toBe("2026-07-07");
  });

  it("returns null fields when frontmatter is missing", () => {
    const fp = writeFixture("no-fm-1.md", NO_FRONTMATTER_KD);
    const result = readKd(fp);
    expect(result.title).toBeNull();
    expect(result.type).toBeNull();
    expect(result.created).toBeNull();
  });

  it("returns null fields when frontmatter is invalid", () => {
    const fp = writeFixture("invalid-fm-1.md", INVALID_FRONTMATTER_KD);
    const result = readKd(fp);
    expect(result.title).toBeNull();
    expect(result.type).toBeNull();
    expect(result.created).toBeNull();
  });
});

// ===========================================================================
// Tests: readIntentKd
// ===========================================================================

describe("readIntentKd", () => {
  it("extracts title, objective, and success criteria", () => {
    const result = readIntentKd(relPath("intent-auth-2026-07-07.md"));
    expect(result.title).toBe("INTENT: Test Feature — Build authentication");
    expect(result.objective).toContain("Build a complete authentication system");
    expect(result.objective).toContain("handle login, registration, and token refresh");
    expect(result.successCriteria).toHaveLength(4);
    expect(result.successCriteria[0]).toContain("Users can register with email and password");
    expect(result.successCriteria[3]).toContain("OAuth2 integration with Google provider");
  });

  it("extracts success criteria from ## Fixes section when no ## Success Criteria", () => {
    const fp = writeFixture("intent-fixes-test.md", INTENT_KD_FIXES_CONTENT);
    const result = readIntentKd(fp);
    expect(result.objective).toContain("Fix the login timeout issue");
    expect(result.successCriteria.length).toBeGreaterThanOrEqual(2);
    expect(result.successCriteria[0]).toContain("Increase connection pool");
  });

  it("returns empty successCriteria when no ## Success Criteria or ## Fixes", () => {
    const fp = writeFixture("intent-minimal-test.md", INTENT_KD_MINIMAL);
    const result = readIntentKd(fp);
    expect(result.title).toBe("INTENT: Quick fix");
    expect(result.objective).toContain("A quick fix for the login page");
    expect(result.successCriteria).toEqual([]);
  });

  it("returns null/empty for missing file", () => {
    const result = readIntentKd("/nonexistent/path.md");
    expect(result.title).toBeNull();
    expect(result.objective).toBe("");
    expect(result.successCriteria).toEqual([]);
  });

  it("handles null/undefined path gracefully", () => {
    expect(readIntentKd(null).title).toBeNull();
    expect(readIntentKd(undefined).title).toBeNull();
  });
});

// ===========================================================================
// Tests: readSpecKd
// ===========================================================================

describe("readSpecKd", () => {
  it("extracts title, numbered requirements, and acceptance criteria", () => {
    const result = readSpecKd(relPath("spec-auth-2026-07-07.md"));
    expect(result.title).toBe("SPEC: Authentication System");
    expect(result.requirements).toHaveLength(3);
    expect(result.requirements[0].id).toBe("R001");
    expect(result.requirements[0].text).toContain("User Registration");
    expect(result.requirements[1].id).toBe("R002");
    expect(result.requirements[2].id).toBe("R003");
    expect(result.acceptanceCriteria).toHaveLength(4);
    expect(result.acceptanceCriteria[0]).toContain("User registration flow works");
  });

  it("returns empty arrays for missing file", () => {
    const result = readSpecKd("/nonexistent/spec.md");
    expect(result.title).toBeNull();
    expect(result.requirements).toEqual([]);
    expect(result.acceptanceCriteria).toEqual([]);
  });

  it("handles null path gracefully", () => {
    const result = readSpecKd(null);
    expect(result.title).toBeNull();
    expect(result.requirements).toEqual([]);
  });
});

// ===========================================================================
// Tests: readKd (generic)
// ===========================================================================

describe("readKd", () => {
  it("extracts title, type, created from frontmatter", () => {
    const result = readKd(relPath("intent-auth-2026-07-07.md"));
    expect(result.title).toBe("INTENT: Test Feature — Build authentication");
    expect(result.type).toBe("intent");
    expect(result.created).toBe("2026-07-07");
  });

  it("extracts summary as first paragraph after frontmatter", () => {
    const result = readKd(relPath("exploration-auth-2026-07-07.md"));
    expect(result.summary).toContain("authentication module");
    expect(result.summary).toContain("key components, data flow, and potential risks");
    // Summary should not contain section headings
    expect(result.summary).not.toContain("## Key Findings");
  });

  it("returns null/empty for missing file", () => {
    const result = readKd("/nonexistent/kd.md");
    expect(result.title).toBeNull();
    expect(result.type).toBeNull();
    expect(result.created).toBeNull();
    expect(result.summary).toBe("");
  });
});

// ===========================================================================
// Tests: extractSessionDate
// ===========================================================================

describe("extractSessionDate", () => {
  it("extracts date from a valid KD path", () => {
    expect(extractSessionDate("knowledge/intent-auth-2026-07-07.md")).toBe("2026-07-07");
  });

  it("extracts date from an absolute KD path", () => {
    expect(extractSessionDate("/home/user/knowledge/plan-foo-2026-12-31.md")).toBe("2026-12-31");
  });

  it("returns null for a path without a date pattern", () => {
    expect(extractSessionDate("knowledge/foo.md")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(extractSessionDate(null)).toBeNull();
    expect(extractSessionDate(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractSessionDate("")).toBeNull();
  });
});

// ===========================================================================
// Tests: getPhaseKds
// ===========================================================================

describe("getPhaseKds", () => {
  const intentPath = relPath("intent-auth-2026-07-07.md");

  it("explore mode returns [intent_kd]", () => {
    const result = getPhaseKds(intentPath, "explore");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("intent-auth-2026-07-07.md");
  });

  it("investigate mode returns [intent_kd, exploration_kd]", () => {
    const result = getPhaseKds(intentPath, "investigate");
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("intent-auth-2026-07-07.md");
    expect(result[1]).toContain("exploration-auth-2026-07-07.md");
  });

  it("align mode returns [intent_kd, exploration_kd, analysis_kd]", () => {
    const result = getPhaseKds(intentPath, "align");
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("intent-auth-2026-07-07.md");
    expect(result[1]).toContain("exploration-auth-2026-07-07.md");
    expect(result[2]).toContain("analysis-auth-2026-07-07.md");
  });

  it("decompose mode returns [spec_kd]", () => {
    const result = getPhaseKds(intentPath, "decompose");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("spec-auth-2026-07-07.md");
  });

  it("swarm mode returns [spec_kd, plan_kd]", () => {
    const result = getPhaseKds(intentPath, "swarm");
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("spec-auth-2026-07-07.md");
    expect(result[1]).toContain("plan-auth-2026-07-07.md");
  });

  it("verify mode returns [spec_kd, plan_kd, impl_kd]", () => {
    const result = getPhaseKds(intentPath, "verify");
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("spec-auth-2026-07-07.md");
    expect(result[1]).toContain("plan-auth-2026-07-07.md");
    expect(result[2]).toContain("impl-auth-2026-07-07.md");
  });

  it("extract mode returns all session KDs matching the date", () => {
    const result = getPhaseKds(intentPath, "extract");
    // Should match all 10 KDs for 2026-07-07
    expect(result.length).toBeGreaterThanOrEqual(9);
    // Should include various KD types for the session
    expect(result.some((p) => p.includes("intent-auth-2026-07-07"))).toBe(true);
    expect(result.some((p) => p.includes("spec-auth-2026-07-07"))).toBe(true);
    expect(result.some((p) => p.includes("exploration-auth-2026-07-07"))).toBe(true);
    // Should NOT include KDs from different dates
    expect(result.some((p) => p.includes("intent-other-2026-07-06"))).toBe(false);
  });

  it("evolve mode returns all session KDs", () => {
    const result = getPhaseKds(intentPath, "evolve");
    expect(result.length).toBeGreaterThanOrEqual(9);
  });

  it("commit mode returns empty array", () => {
    const result = getPhaseKds(intentPath, "commit");
    expect(result).toEqual([]);
  });

  it("report mode returns all session KDs", () => {
    const result = getPhaseKds(intentPath, "report");
    expect(result.length).toBeGreaterThanOrEqual(9);
  });

  it("preflight mode returns [intent_kd]", () => {
    const result = getPhaseKds(intentPath, "preflight");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("intent-auth-2026-07-07.md");
  });

  it("checkpoint mode returns empty array", () => {
    const result = getPhaseKds(intentPath, "checkpoint");
    expect(result).toEqual([]);
  });

  it("returns empty array for unknown mode", () => {
    const result = getPhaseKds(intentPath, "unknown-mode");
    expect(result).toEqual([]);
  });

  it("returns empty array for null intentPath", () => {
    expect(getPhaseKds(null, "explore")).toEqual([]);
  });

  it("returns empty array for null mode", () => {
    expect(getPhaseKds(intentPath, null)).toEqual([]);
  });

  it("returns empty array for path without date pattern", () => {
    expect(getPhaseKds("knowledge/foo.md", "explore")).toEqual([]);
  });
});

// ===========================================================================
// Tests: Error handling
// ===========================================================================

describe("Error handling", () => {
  it("missing file returns null/empty values (no crash)", () => {
    const result = readKd("/tmp/nonexistent-kd-file.md");
    expect(result.title).toBeNull();
    expect(result.type).toBeNull();
    expect(result.created).toBeNull();
    expect(result.summary).toBe("");
  });

  it("invalid frontmatter does not crash readKd", () => {
    const fp = writeFixture("bad-frontmatter.md", INVALID_FRONTMATTER_KD);
    const result = readKd(fp);
    // Should not crash — returns null for frontmatter fields
    expect(result.title).toBeNull();
    expect(result.type).toBeNull();
  });

  it("empty file returns null/empty values", () => {
    const fp = writeFixture("empty.md", "");
    const result = readKd(fp);
    expect(result.title).toBeNull();
    expect(result.summary).toBe("");
  });
});
