// plugins/dispatch-gate/template-engine.test.js
// Tests for the template engine — variable resolution, glob patterns, mode routing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { fillTemplate } from "./template-engine.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), "template-engine-test-" + Date.now());
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

// Create a set of fixture KDs for glob tests
beforeAll(() => {
  writeFixture("intent-auth-2026-07-07.md", "# INTENT: Auth\n## Objective\nBuild auth");
  writeFixture("exploration-auth-2026-07-07.md", "# EXPLORATION: Auth\n## Findings\n...");
  writeFixture("analysis-auth-2026-07-07.md", "# ANALYSIS: Auth\n## Analysis\n...");
  writeFixture("spec-auth-2026-07-07.md", "# SPEC: Auth\n## Requirements\n...");
  writeFixture("plan-auth-2026-07-07.md", "# PLAN: Auth\n## Tasks\n...");
  writeFixture("intent-other-2026-07-06.md", "# INTENT: Other\n## Objective\nOther");
});

// ---------------------------------------------------------------------------
// Tests: Basic variable resolution
// ---------------------------------------------------------------------------

describe("fillTemplate — basic resolution", () => {
  it("resolves {{intent_kd}}, {{name}}, {{date}} in a simple template", () => {
    const result = fillTemplate("explore", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });

    expect(result.target_agent).toBe("explorer");
    expect(result.prompt).toContain("DISPATCH TO: explorer");
    expect(result.prompt).toContain("ACTION: Create");
    expect(result.prompt).toContain("ARTIFACT: exploration KD");
    expect(result.prompt).toContain("DOMAIN: foo");
    expect(result.prompt).toContain("knowledge/intent-foo-2026-07-06.md");
    expect(result.prompt).toContain("knowledge/exploration-foo-2026-07-06.md");
    expect(result.self_execute).toBe(false);
  });

  it("resolves all mode templates with correct target agents", () => {
    const modeMap = {
      explore: "explorer",
      investigate: "analyzer",
      align: "spec-weaver",
      decompose: "pathfinder",
      swarm: "artisan",
      verify: "inspector",
      extract: "scribe",
      evolve: "habit-builder",
      commit: "committer",
      checkpoint: "committer",
      report: "overseer",
    };

    for (const [mode, expectedAgent] of Object.entries(modeMap)) {
      const result = fillTemplate(mode, "knowledge/intent-test-2026-07-06.md", {
        workspaceRoot: TMP_DIR,
      });
      expect(result.target_agent).toBe(expectedAgent);
      expect(result.prompt).toContain(`DISPATCH TO: ${expectedAgent}`);
    }
  });

  it("resolves preflight mode correctly", () => {
    const result = fillTemplate("preflight", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });

    expect(result.target_agent).toBe("committer");
    expect(result.prompt).toContain("MODE: PREFLIGHT");
    expect(result.prompt).not.toContain("{{");
  });

  it("resolves checkpoint mode correctly", () => {
    const result = fillTemplate("checkpoint", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });

    expect(result.target_agent).toBe("committer");
    expect(result.prompt).toContain("MODE: CHECKPOINT");
    expect(result.dispatch_fields.kds).toBeInstanceOf(Array);
    expect(result.dispatch_fields.kds).toHaveLength(0);
  });

  it("resolves commit mode correctly", () => {
    const result = fillTemplate("commit", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });

    expect(result.target_agent).toBe("committer");
    expect(result.prompt).toContain("MODE: CLEANUP");
  });
});

// ---------------------------------------------------------------------------
// Tests: Date and name extraction
// ---------------------------------------------------------------------------

describe("fillTemplate — date and name extraction", () => {
  it("extracts date from intent_kd filename", () => {
    const result = fillTemplate("explore", "knowledge/intent-my-feature-2026-12-31.md", {
      workspaceRoot: TMP_DIR,
    });
    expect(result.prompt).toContain("knowledge/exploration-my-feature-2026-12-31.md");
    expect(result.prompt).toContain("DOMAIN: my-feature");
  });

  it("uses session_date override when provided", () => {
    const result = fillTemplate("explore", "knowledge/intent-foo-2026-07-06.md", {
      session_date: "2026-08-15",
      workspaceRoot: TMP_DIR,
    });
    expect(result.prompt).toContain("knowledge/exploration-foo-2026-08-15.md");
  });

  it("handles multi-dash names correctly", () => {
    const result = fillTemplate("explore", "knowledge/intent-dispatch-gate-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });
    expect(result.prompt).toContain("DOMAIN: dispatch-gate");
    expect(result.prompt).toContain("knowledge/exploration-dispatch-gate-2026-07-06.md");
  });

  it("handles absolute paths", () => {
    const absolutePath = path.join(TMP_DIR, "knowledge", "intent-auth-2026-07-07.md");
    const result = fillTemplate("explore", absolutePath, {
      workspaceRoot: TMP_DIR,
    });
    expect(result.target_agent).toBe("explorer");
    expect(result.prompt).toContain("DOMAIN: auth");
  });
});

// ---------------------------------------------------------------------------
// Tests: Glob resolution
// ---------------------------------------------------------------------------

describe("fillTemplate — glob pattern resolution", () => {
  it("resolves {{glob:knowledge/*-{{date}}-*.md}} to matching files", () => {
    const result = fillTemplate("extract", "knowledge/intent-auth-2026-07-07.md", {
      workspaceRoot: TMP_DIR,
    });
    // Should find the 5 auth KDs for this session date
    const prompt = result.prompt;
    expect(prompt).toContain("knowledge/intent-auth-2026-07-07.md");
    expect(prompt).toContain("knowledge/exploration-auth-2026-07-07.md");
    expect(prompt).toContain("knowledge/analysis-auth-2026-07-07.md");
    expect(prompt).toContain("knowledge/spec-auth-2026-07-07.md");
    expect(prompt).toContain("knowledge/plan-auth-2026-07-07.md");
    // Should NOT include KDs from other dates
    expect(prompt).not.toContain("intent-other-2026-07-06.md");
  });

  it("evolve mode uses glob for all session KDs", () => {
    const result = fillTemplate("evolve", "knowledge/intent-auth-2026-07-07.md", {
      workspaceRoot: TMP_DIR,
    });
    const prompt = result.prompt;
    expect(prompt).toContain("knowledge/intent-auth-2026-07-07.md");
    expect(prompt).toContain("knowledge/exploration-auth-2026-07-07.md");
    expect(prompt).toContain("knowledge/analysis-auth-2026-07-07.md");
  });

  it("report mode uses glob and is self-executing", () => {
    const result = fillTemplate("report", "knowledge/intent-auth-2026-07-07.md", {
      workspaceRoot: TMP_DIR,
    });
    expect(result.self_execute).toBe(true);
    expect(result.target_agent).toBe("overseer");
    expect(result.prompt).toContain("knowledge/intent-auth-2026-07-07.md");
  });
});

// ---------------------------------------------------------------------------
// Tests: Scope parameter
// ---------------------------------------------------------------------------

describe("fillTemplate — scope parameter", () => {
  it("uses name as the default scope/domain value", () => {
    const result = fillTemplate("swarm", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });
    expect(result.prompt).toContain("SCOPE: foo");
  });
});

// ---------------------------------------------------------------------------
// Tests: dispatch_fields output
// ---------------------------------------------------------------------------

describe("fillTemplate — dispatch_fields output", () => {
  it("returns structured dispatch_fields object", () => {
    const result = fillTemplate("explore", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });
    expect(result.dispatch_fields).toBeDefined();
    expect(result.dispatch_fields["DISPATCH TO"]).toBe("explorer");
    expect(result.dispatch_fields["ACTION"]).toBe("Create");
    expect(result.dispatch_fields["ARTIFACT"]).toBe("exploration KD");
    expect(result.dispatch_fields["DOMAIN"]).toBe("foo");
    expect(result.dispatch_fields["RETURN"]).toContain("exploration-foo-2026-07-06.md");
    expect(result.dispatch_fields.kds).toBeInstanceOf(Array);
  });

  it("returns correct SCOPE field for decompose mode", () => {
    const result = fillTemplate("decompose", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });
    expect(result.dispatch_fields["SCOPE"]).toBe("foo");
  });

  it("returns correct MODE field for checkpoint mode", () => {
    const result = fillTemplate("checkpoint", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });
    expect(result.dispatch_fields["MODE"]).toBe("CHECKPOINT");
  });
});

// ---------------------------------------------------------------------------
// Tests: Error handling
// ---------------------------------------------------------------------------

describe("fillTemplate — error handling", () => {
  it("throws on missing mode", () => {
    expect(() => fillTemplate()).toThrow("TEMPLATE_ERROR");
  });

  it("throws on missing intent_kd", () => {
    expect(() => fillTemplate("explore")).toThrow("TEMPLATE_ERROR");
  });

  it("throws on unknown mode", () => {
    expect(() =>
      fillTemplate("bogus-mode", "knowledge/intent-foo-2026-07-06.md", {
        workspaceRoot: TMP_DIR,
      })
    ).toThrow("TEMPLATE_ERROR");
  });

  it("throws on invalid intent_kd path pattern", () => {
    expect(() =>
      fillTemplate("explore", "knowledge/foo.md", {
        workspaceRoot: TMP_DIR,
      })
    ).toThrow("TEMPLATE_ERROR");
  });

  it("throws on totally invalid path", () => {
    expect(() =>
      fillTemplate("explore", "not-even-a-kd-path", {
        workspaceRoot: TMP_DIR,
      })
    ).toThrow("TEMPLATE_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Tests: No KD content reading
// ---------------------------------------------------------------------------

describe("fillTemplate — no KD content reading", () => {
  it("succeeds even when the referenced KD file does not exist on disk", () => {
    // The template engine should NOT read the file — only use the path
    const result = fillTemplate("explore", "knowledge/intent-nonexistent-2099-01-01.md", {
      workspaceRoot: TMP_DIR,
    });
    expect(result.target_agent).toBe("explorer");
    expect(result.prompt).toContain("knowledge/intent-nonexistent-2099-01-01.md");
    expect(result.prompt).toContain("knowledge/exploration-nonexistent-2099-01-01.md");
  });
});

// ---------------------------------------------------------------------------
// Tests: KDS entries are KD path strings
// ---------------------------------------------------------------------------

describe("fillTemplate — KDS entries are paths, not content", () => {
  it("kds array contains only path strings", () => {
    const result = fillTemplate("investigate", "knowledge/intent-foo-2026-07-06.md", {
      workspaceRoot: TMP_DIR,
    });
    for (const kd of result.dispatch_fields.kds) {
      expect(kd).toMatch(/^knowledge\//);
      expect(kd).toMatch(/\.md$/);
    }
  });
});
