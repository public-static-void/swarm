import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";

// The plugin reads its data dirs from KNOWLEDGE_GATE_MEMORY_DIR /
// KNOWLEDGE_GATE_ISSUES_DIR env overrides (test seam in the plugin). We point
// them at real temp dirs — no vi.mock("fs") needed. The previous approach
// mocked the fs module process-wide, which leaked into sibling suites under
// bun's test runner and made every protocol-gate disk check fail.

let tempRoot;
let MEMORY_DIR;
let ISSUES_DIR;
let pluginModule;
let hooks;

// Helper to populate the real temp memory/issues dirs
function writeEntries(dir, entries) {
  for (const { fileName, content } of entries) {
    writeFileSync(join(dir, fileName), content);
  }
}

// Helper to add a memory entry to the temp dir
function addMemoryEntry(id, overrides = {}) {
  const defaultEntry = {
    id: `MEM-${String(id).padStart(3, "0")}`,
    type: "fact",
    source_kd: `knowledge/composed-test-${id}.md`,
    tags: ["test", "mock", "sample"],
    topic: `Test topic ${id}`,
    insight: `This is test insight ${id} for verification purposes.`,
    created: `2026-07-2${id}T00:00:00.000Z`,
    session: `ses_test_${id}`,
    version: "1.0.0",
    ...overrides
  };
  const fileName = `entry-${String(id).padStart(3, "0")}.json`;
  return { fileName, content: JSON.stringify(defaultEntry) };
}

function addIssueFile(id, overrides = {}) {
  const defaultIssue = {
    id: `ISSUE-${String(id).padStart(3, "0")}`,
    title: `Test Issue ${id}`,
    severity: "high",
    status: "open",
    created: "2026-07-29",
    session: `ses_test_${id}`,
    assigned_to: "habit-builder",
    tags: "[test, mock]"
  };
  const frontmatter = Object.entries({ ...defaultIssue, ...overrides })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${frontmatter}\n---\n\nIssue body for ${id}.`;
  return { fileName: `issue-${String(id).padStart(3, "0")}.md`, content };
}

describe("Knowledge-Gate Plugin", () => {
  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "kg-test-"));
    MEMORY_DIR = join(tempRoot, "memory");
    ISSUES_DIR = join(tempRoot, "issues");
    process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
    process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
    // Single static import — no query-string module-identity hack. Each
    // server() call owns a fresh memory cache (the cache lives in the server
    // closure), so per-test module re-imports are unnecessary.
    pluginModule = await import("../../../plugins/knowledge-gate/index.js");
  });

  beforeEach(async () => {
    // Reset the temp dirs so each test starts from empty state
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    rmSync(ISSUES_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    mkdirSync(ISSUES_DIR, { recursive: true });
    // A fresh server instance carries a fresh in-server memory cache
    hooks = await pluginModule.default.server({}, {});
  });

  afterAll(() => {
    delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
    delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("searchMemory — Tag-overlap scoring", () => {
    it("returns higher score for entries with matching tags", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["target-tag", "mock", "sample"], topic: "Alpha" }),
        addMemoryEntry(2, { tags: ["other", "unrelated"], topic: "Beta" })
      ]);

      const results = hooks.searchMemory({ tags: ["target-tag"], topic: "", limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].tags).toContain("target-tag");
    });
  });

  describe("searchMemory — Topic match scoring", () => {
    it("returns higher score for entries with matching topic substring", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { topic: "Authentication flow design", tags: ["auth"] }),
        addMemoryEntry(2, { topic: "Cache invalidation strategy", tags: ["cache"] })
      ]);

      const results = hooks.searchMemory({ tags: [], topic: "auth", limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].topic).toContain("Authentication");
    });
  });

  describe("searchMemory — Recency sort", () => {
    it("sorts newer entries before older entries at equal score", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { created: "2026-07-20T00:00:00.000Z" }),
        addMemoryEntry(2, { created: "2026-07-29T00:00:00.000Z" })
      ]);

      const results = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(results[0].id).toBe("MEM-002");
      expect(results[1].id).toBe("MEM-001");
    });
  });

  describe("searchMemory — Empty results", () => {
    it("returns empty array when no entries match", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["database"], topic: "SQL queries" })
      ]);

      const results = hooks.searchMemory({ tags: ["nonexistent"], topic: "zzzzz", limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe("searchMemory — Limit enforcement", () => {
    it("returns at most the specified number of results", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1),
        addMemoryEntry(2),
        addMemoryEntry(3)
      ]);

      const results = hooks.searchMemory({ tags: [], topic: "", limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("uses default limit of 5 when not specified", () => {
      writeEntries(MEMORY_DIR, Array.from({ length: 10 }, (_, i) => addMemoryEntry(i + 1)));

      const results = hooks.searchMemory({ tags: [], topic: "" });
      expect(results).toHaveLength(5);
    });
  });

  describe("searchMemory — Backward compatibility", () => {
    it("works with topic-only query (no tags)", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { topic: "Auth permissions design" }),
        addMemoryEntry(2, { topic: "Cache layer" })
      ]);

      const results = hooks.searchMemory({ topic: "auth" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("MEM-001");
    });

    it("works with tags-only query (no topic)", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["permissions", "auth", "test"] }),
        addMemoryEntry(2, { tags: ["cache", "performance"] })
      ]);

      const results = hooks.searchMemory({ tags: ["permissions"] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("MEM-001");
    });
  });

  describe("searchMemory — Superseded exclusion", () => {
    it("excludes superseded entries (truthy superseded_by) before scoring", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design", superseded_by: "MEM-002" }),
        addMemoryEntry(2, { tags: ["auth", "permissions"], topic: "Auth token design v2" })
      ]);

      const results = hooks.searchMemory({ tags: ["auth"], topic: "", limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("MEM-002");
    });
  });

  describe("scanHighSeverityIssues", () => {
    it("filters correctly by severity and status", () => {
      writeEntries(ISSUES_DIR, [
        addIssueFile(1, { severity: "high", status: "open" }),
        addIssueFile(2, { severity: "low", status: "open" }),
        addIssueFile(3, { severity: "high", status: "closed" })
      ]);

      const results = hooks.scanHighSeverityIssues();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ISSUE-001");
    });

    it("returns empty array when issues directory is missing", () => {
      rmSync(ISSUES_DIR, { recursive: true, force: true });
      const results = hooks.scanHighSeverityIssues();
      expect(results).toEqual([]);
    });
  });

  describe("parseIssueFile", () => {
    it("parses YAML frontmatter including array values", () => {
      const content = `---
id: ISSUE-001
title: Test issue
severity: high
status: open
tags: [auth, permission]
---
Body text`;
      const result = hooks.parseIssueFile(content, "issue-001.md");
      expect(result).toBeTruthy();
      expect(result.id).toBe("ISSUE-001");
      expect(result.title).toBe("Test issue");
      expect(result.severity).toBe("high");
      expect(result.tags).toEqual(["auth", "permission"]);
    });

    it("returns null for content without frontmatter", () => {
      const result = hooks.parseIssueFile("No frontmatter here", "issue-001.md");
      expect(result).toBeNull();
    });
  });

  describe("getNextIssueId", () => {
    it("generates ISSUE-001 when no issues exist", () => {
      const result = hooks.getNextIssueId();
      expect(result).toBe("ISSUE-001");
    });

    it("generates sequential IDs based on existing issue files", () => {
      writeEntries(ISSUES_DIR, [
        { fileName: "issue-001.md", content: "" },
        { fileName: "issue-005.md", content: "" }
      ]);

      const result = hooks.getNextIssueId();
      expect(result).toBe("ISSUE-006");
    });
  });

  describe("systemTransform", () => {
    it("injects memory_search instructions for all agents", async () => {
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "artisan" },
        output
      );
      expect(output.system.length).toBeGreaterThanOrEqual(1);
      expect(output.system[0]).toContain("memory_search");
    });

    it("injects scribe-specific write instructions via memory_write tool", async () => {
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "scribe" },
        output
      );
      const writeInstr = output.system.find(s => s.includes("memory_write tool"));
      expect(writeInstr).toBeTruthy();
    });

    it("injects no memory-write instruction for habit-builder (Scribe-only division, AC010)", async () => {
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "habit-builder" },
        output
      );
      // Structural assertion of the division: only the scribe branch of
      // systemTransform may carry the WRITE instruction. The habit-builder's
      // legitimate memory_search READ hint stays untouched by this assertion.
      const writeInstrs = output.system.filter(s => /memory_write tool|write distilled insights/.test(s));
      expect(writeInstrs).toHaveLength(0);
    });

    it("includes dynamic hint line when memory matches agent type", async () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["implementation", "code"], topic: "Code patterns" })
      ]);

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "artisan" },
        output
      );
      // systemTransform runs deriveSearchHints which searches memory
      // Artisan → AGENT_TAG_MAP has ["implementation", "code"] — entry has those tags
      const hintLine = output.system.find(s => s.includes("Memory:"));
      expect(hintLine).toBeTruthy();
      expect(hintLine).toMatch(/Memory: \d+ entries match/);
    });

    it("does not add hint when no memory entries exist", async () => {
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "artisan" },
        output
      );
      // Only the memory_search availability line should be present
      const hintLines = output.system.filter(s => s.includes("Memory:"));
      expect(hintLines).toHaveLength(0);
    });

    it("surfaces open issues and prompts the Close Issues step for habit-builder", async () => {
      writeEntries(ISSUES_DIR, [
        addIssueFile(1, { severity: "medium", title: "Open issue A" }),
        addIssueFile(2, { status: "resolved", severity: "high", title: "Closed issue B" })
      ]);

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "habit-builder" },
        output
      );

      // Issue creation hint (existing behavior) is preserved
      const createHint = output.system.find(s => s.includes("create issue files directly"));
      expect(createHint).toBeTruthy();

      // Open issues are surfaced; resolved issues are not
      const closeHint = output.system.find(s => s.includes("Open issues detected"));
      expect(closeHint).toBeTruthy();
      expect(closeHint).toContain("ISSUE-001");
      expect(closeHint).toContain("Open issue A");
      expect(closeHint).not.toContain("Closed issue B");

      // The Close Issues step is prompted with the evidence requirement
      expect(closeHint).toContain("Close Issues");
      expect(closeHint).toContain("Resolution");
      expect(closeHint).toContain("evidence");
    });
  });

  describe("validateMemoryEntry — with type field", () => {
    it("accepts a valid memory entry with type field", () => {
      const valid = {
        id: "MEM-001",
        type: "fact",
        source_kd: "knowledge/composed-test.md",
        tags: ["test", "sample"],
        topic: "Test topic",
        insight: "This is a test insight for validation.",
        created: "2026-07-29T00:00:00.000Z",
        session: "ses_test",
        version: "1.0.0"
      };
      expect(hooks.validateMemoryEntry(valid)).toEqual({ valid: true });
    });

    it("rejects entry without type field", () => {
      const invalid = {
        id: "MEM-001",
        source_kd: "knowledge/composed-test.md",
        tags: ["test", "sample"],
        topic: "Test topic",
        insight: "Test insight.",
        created: "2026-07-29T00:00:00.000Z",
        session: "ses_test",
        version: "1.0.0"
      };
      const result = hooks.validateMemoryEntry(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("type");
    });

    it("rejects entry with invalid type value", () => {
      const invalid = {
        id: "MEM-001",
        type: "invalid-type",
        source_kd: "knowledge/composed-test.md",
        tags: ["test", "sample"],
        topic: "Test topic",
        insight: "Test insight.",
        created: "2026-07-29T00:00:00.000Z",
        session: "ses_test",
        version: "1.0.0"
      };
      const result = hooks.validateMemoryEntry(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("type");
    });

    it("accepts all valid type values", () => {
      const base = {
        id: "MEM-001",
        source_kd: "knowledge/composed-test.md",
        tags: ["test", "sample"],
        topic: "Test topic",
        insight: "Test insight.",
        created: "2026-07-29T00:00:00.000Z",
        session: "ses_test",
        version: "1.0.0"
      };
      for (const type of ["fact", "decision", "pattern", "warning", "context"]) {
        expect(hooks.validateMemoryEntry({ ...base, type })).toEqual({ valid: true });
      }
    });

    it("rejects entry with wrong id format", () => {
      const invalid = {
        id: "entry-001",
        type: "fact",
        source_kd: "knowledge/composed-test.md",
        tags: ["test", "sample"],
        topic: "Test topic",
        insight: "Test insight.",
        created: "2026-07-29T00:00:00.000Z",
        session: "ses_test",
        version: "1.0.0"
      };
      const result = hooks.validateMemoryEntry(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("id");
    });

    it("rejects entry with wrong version type", () => {
      const invalid = {
        id: "MEM-001",
        type: "fact",
        source_kd: "knowledge/composed-test.md",
        tags: ["test", "sample"],
        topic: "Test topic",
        insight: "Test insight.",
        created: "2026-07-29T00:00:00.000Z",
        session: "ses_test",
        version: 1
      };
      const result = hooks.validateMemoryEntry(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("version");
    });

    it("rejects entry with date-only created field", () => {
      const invalid = {
        id: "MEM-001",
        type: "fact",
        source_kd: "knowledge/composed-test.md",
        tags: ["test", "sample"],
        topic: "Test topic",
        insight: "Test insight.",
        created: "2026-07-29",
        session: "ses_test",
        version: "1.0.0"
      };
      const result = hooks.validateMemoryEntry(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("created");
    });
  });

  describe("formatMemoryEntry", () => {
    const entry = {
      id: "MEM-001",
      type: "pattern",
      source_kd: "knowledge/composed-test.md",
      tags: ["test", "sample"],
      topic: "Test topic",
      insight: "This is a test insight.",
      created: "2026-07-29T00:00:00.000Z",
      session: "ses_test",
      version: "1.0.0"
    };

    it("produces markdown format including type", () => {
      const result = hooks.formatMemoryEntry(entry, "markdown");
      expect(result).toContain("MEM-001");
      expect(result).toContain("(pattern)");
      expect(result).toContain("Test topic");
      expect(result).toContain("source: knowledge/composed-test.md");
    });

    it("returns raw object for json format", () => {
      const result = hooks.formatMemoryEntry(entry, "json");
      expect(result).toBe(entry);
    });
  });

  describe("Cache behavior", () => {
    it("uses cached entries on second call without disk read", () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { topic: "Original content" })]);

      const r1 = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(r1).toHaveLength(1);

      // Rewrite the same file with different content (file count unchanged —
      // the cache's only invalidation signal). A cached second call must
      // return the stale first-read content; a disk read would return the new.
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { topic: "Changed content" })]);

      const r2 = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(r2).toHaveLength(1);
      expect(r1).toEqual(r2);
    });

    it("invalidates cache when a new file is added", () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(1)]);

      hooks.searchMemory({ tags: [], topic: "", limit: 5 });

      writeEntries(MEMORY_DIR, [addMemoryEntry(1), addMemoryEntry(2)]);

      const r2 = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(r2).toHaveLength(2);
    });
  });

  describe("deriveSearchHints — Hint derivation engine", () => {
    it("returns empty for mechanical modes (preflight, checkpoint, cleanup)", () => {
      for (const mode of ["preflight", "checkpoint", "cleanup"]) {
        const result = hooks.deriveSearchHints({ mode, agentType: "artisan", scope: "test" });
        expect(result.shouldHint).toBe(false);
        expect(result.hints).toHaveLength(0);
      }
    });

    it("derives tags from MODE for analytical modes", () => {
      const result = hooks.deriveSearchHints({ mode: "explore", agentType: "", scope: "" });
      // explore maps to ["exploration", "architecture", "investigation"]
      expect(result.shouldHint).toBe(false); // No memory entries exist, so no hint
    });

    it("adds agent-type-specific tags", () => {
      const result = hooks.deriveSearchHints({ mode: "swarm", agentType: "analyzer", scope: "" });
      // swarm → ["implementation", "code", "pattern"] + analyzer → ["analysis", "root-cause"]
      // No memory entries, so shouldHint is false but tags are derived
      expect(result.shouldHint).toBe(false);
    });

    it("returns hint when memory matches", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["analysis", "bug"], topic: "Bug analysis patterns" })
      ]);

      const result = hooks.deriveSearchHints({ mode: "investigate", agentType: "analyzer", scope: "" });
      // investigate → ["analysis", "root-cause", "bug"] + analyzer → ["analysis", "root-cause"]
      // MEM-001 has ["analysis", "bug"] → match!
      expect(result.shouldHint).toBe(true);
      expect(result.hints.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts noun keywords from SCOPE", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth tokens" })
      ]);

      const result = hooks.deriveSearchHints({ mode: "swarm", agentType: "artisan", scope: "fix auth token permissions" });
      // swarm → ["implementation", "code", "pattern"] + artisan → ["implementation", "code"]
      // scope keywords after stop-word+noise removal: ["auth", "token", "permissions"]
      // MEM-001 has ["auth", "permissions"] → match!
      expect(result.shouldHint).toBe(true);
    });

    it("limits to 3 hint lines maximum", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["implementation", "code", "bug"], topic: "Alpha" }),
        addMemoryEntry(2, { tags: ["implementation", "bug"], topic: "Beta" }),
        addMemoryEntry(3, { tags: ["bug"], topic: "Gamma" })
      ]);

      const result = hooks.deriveSearchHints({ mode: "swarm", agentType: "artisan", scope: "" });
      expect(result.shouldHint).toBe(true);
      expect(result.hints.length).toBeLessThanOrEqual(3);
    });
  });

  describe("generateHintLines — Hint format", () => {
    it("produces hint in the correct format regex", () => {
      const results = [
        { id: "MEM-001", tags: ["bug", "analysis"], topic: "Bug fix", insight: "Fix" },
        { id: "MEM-002", tags: ["bug"], topic: "Another bug", insight: "Another" }
      ];
      const hints = hooks.generateHintLines(results, ["bug"]);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toMatch(/^\[Memory: \d+ entries match "[^"]+"\. Use memory_search\("[^"]+"\) to retrieve\.\]$/);
    });

    it("groups results by primary tag", () => {
      const results = [
        { id: "MEM-001", tags: ["bug", "caching"], topic: "Bug fix", insight: "Fix" },
        { id: "MEM-002", tags: ["bug"], topic: "Another bug", insight: "Another" },
        { id: "MEM-003", tags: ["caching"], topic: "Cache strategy", insight: "Cache" }
      ];
      const hints = hooks.generateHintLines(results, ["caching", "bug"]);
      expect(hints).toHaveLength(2);
      expect(hints[0]).toContain("caching");
      expect(hints[1]).toContain("bug");
    });

    it("produces generic fallback when no tag-grouping works", () => {
      const results = [
        { id: "MEM-001", tags: ["unrelated"], topic: "Something", insight: "Else" }
      ];
      const hints = hooks.generateHintLines(results, ["nonexistent"]);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("current context");
    });

    it("returns empty array for empty results", () => {
      const hints = hooks.generateHintLines([], ["bug"]);
      expect(hints).toHaveLength(0);
    });
  });

  describe("getNextMemoryId", () => {
    it("generates MEM-001 when no entries exist", () => {
      const result = hooks.getNextMemoryId();
      expect(result).toBe("MEM-001");
    });

    it("generates sequential IDs based on existing entry files", () => {
      writeEntries(MEMORY_DIR, [
        { fileName: "entry-001.json", content: "{}" },
        { fileName: "entry-005.json", content: "{}" }
      ]);

      const result = hooks.getNextMemoryId();
      expect(result).toBe("MEM-006");
    });
  });

  describe("checkDuplicateMemory", () => {
    it("returns null when no matching entries exist", () => {
      const entry = { tags: ["unique"], topic: "Completely new topic" };
      const result = hooks.checkDuplicateMemory(entry);
      expect(result).toBeNull();
    });

    it("returns existing entry when high-similarity match found", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" })
      ]);

      const entry = { tags: ["auth", "permissions"], topic: "Auth token design patterns" };
      const result = hooks.checkDuplicateMemory(entry);
      expect(result).not.toBeNull();
      expect(result.id).toBe("MEM-001");
    });

    it("does not dedup-skip a write with 3 shared tags but unrelated topics (issue-20)", async () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["permissions", "testing", "cache"], topic: "Permission glob patterns" })
      ]);

      // Direct checkDuplicateMemory call: tag-only overlap (score 3) must NOT declare a duplicate
      const dup = hooks.checkDuplicateMemory({ tags: ["permissions", "testing", "cache"], topic: "Cache invalidation strategy" });
      expect(dup).toBeNull();

      // memory_write writes the new file instead of skipping
      const result = await hooks.tool.memory_write.execute(
        { entry: { id: "MEM-002", type: "fact", source_kd: "knowledge/test.md", tags: ["permissions", "testing", "cache"], topic: "Cache invalidation strategy", insight: "Test insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("written");
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(2);
    });

    it("still dedups a genuine duplicate (1 shared tag + overlapping topic)", () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["permissions"], topic: "Permission glob patterns" })
      ]);

      const entry = { tags: ["permissions", "auth"], topic: "Permission glob patterns — cross-workspace" };
      const result = hooks.checkDuplicateMemory(entry);
      expect(result).not.toBeNull();
      expect(result.id).toBe("MEM-001");
    });
  });

  describe("tool registration surface", () => {
    it("exposes memory_search with description, args, and execute", () => {
      expect(hooks.tool.memory_search).toBeTruthy();
      expect(typeof hooks.tool.memory_search.description).toBe("string");
      expect(hooks.tool.memory_search.args).toBeTruthy();
      expect(typeof hooks.tool.memory_search.execute).toBe("function");
    });

    it("exposes memory_write with description, args, and execute", () => {
      expect(hooks.tool.memory_write).toBeTruthy();
      expect(typeof hooks.tool.memory_write.description).toBe("string");
      expect(hooks.tool.memory_write.args).toBeTruthy();
      expect(typeof hooks.tool.memory_write.execute).toBe("function");
    });

    it("exposes memory_update with description, args, and execute", () => {
      expect(hooks.tool.memory_update).toBeTruthy();
      expect(typeof hooks.tool.memory_update.description).toBe("string");
      expect(hooks.tool.memory_update.args).toBeTruthy();
      expect(typeof hooks.tool.memory_update.execute).toBe("function");
    });

    it("exposes memory_delete with description, args, and execute", () => {
      expect(hooks.tool.memory_delete).toBeTruthy();
      expect(typeof hooks.tool.memory_delete.description).toBe("string");
      expect(hooks.tool.memory_delete.args).toBeTruthy();
      expect(typeof hooks.tool.memory_delete.execute).toBe("function");
    });
  });

  describe("memory_write tool (registered execute)", () => {
    it("rejects writes from non-Scribe agents with no file written", async () => {
      const entry = { id: "MEM-020", type: "fact", source_kd: "test.md", tags: ["test", "sample"], topic: "Test", insight: "X", created: "2026-07-29T00:00:00.000Z", session: "s1", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry }, { agent: "artisan", sessionID: "artisan-session" });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("permission");
      expect(readdirSync(MEMORY_DIR)).toHaveLength(0);
    });

    it("writes exactly one file and returns { message, id } from Scribe agent", async () => {
      const entry = { id: "MEM-020", type: "fact", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight for tool write.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry }, { agent: "scribe", sessionID: "scribe-session" });
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("written");
      expect(parsed.id).toBe("MEM-020");
      const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe("entry-020.json");
    });

    it("auto-assigns ID when not provided", async () => {
      const entry = { type: "fact", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight for auto-id.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry }, { agent: "scribe", sessionID: "scribe-session" });
      const parsed = JSON.parse(result);
      expect(parsed.id).toBe("MEM-001"); // First entry gets MEM-001
    });

    it("detects duplicate entries and skips write", async () => {
      // Pre-populate the temp dir with an entry — simulates an existing entry on disk
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(50, { tags: ["test", "duplicate"], topic: "Duplicate test" })
      ]);

      // Try writing a similar entry (same tags, overlapping topic)
      const entry2 = { id: "MEM-051", type: "fact", source_kd: "knowledge/test.md", tags: ["test", "duplicate"], topic: "Duplicate test content", insight: "Test insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry: entry2 }, { agent: "scribe", sessionID: "scribe-session" });
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("Duplicate");
      // No second file written
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(1);
    });

    it("rejects invalid schema entry with no write", async () => {
      const entry = { id: "MEM-020", type: "not-a-valid-type", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry }, { agent: "scribe", sessionID: "scribe-session" });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeTruthy();
      expect(readdirSync(MEMORY_DIR)).toHaveLength(0);
    });

    it("detects duplicates against existing seeded entries on disk (readability + dedup)", async () => {
      // Simulates a seeded MEM-* file already present in knowledge/memory/
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(33, { tags: ["permissions", "glob"], topic: "Permission glob patterns" })
      ]);

      // Registered search still reads the seeded entry
      const search = await hooks.tool.memory_search.execute({ tags: ["permissions"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(search)).toHaveLength(1);

      // And dedup still detects a duplicate against it
      const entry = { id: "MEM-034", type: "fact", source_kd: "knowledge/test.md", tags: ["permissions", "glob"], topic: "Permission glob patterns — cross-workspace", insight: "Test insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry }, { agent: "scribe", sessionID: "scribe-session" });
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("Duplicate");
    });
  });

  describe("memory_update tool (registered execute)", () => {
    it("rejects updates from non-Scribe agents with no file modified", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(7, { topic: "Original topic" })]);
      const result = await hooks.tool.memory_update.execute(
        { id: "MEM-007", entry: { topic: "Changed topic" } },
        { agent: "artisan", sessionID: "artisan-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("permission");
      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-007.json"), "utf8"));
      expect(onDisk.topic).toBe("Original topic");
    });

    it("persists a partial patch while preserving id/created/session/version and the same file", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(7, { created: "2026-07-27T00:00:00.000Z", session: "ses_test_7" })]);
      const result = await hooks.tool.memory_update.execute(
        { id: "MEM-007", entry: { topic: "Updated topic", insight: "Updated insight.", tags: ["test", "mock", "cache"] } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("updated");
      expect(parsed.id).toBe("MEM-007");

      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-007.json"), "utf8"));
      expect(onDisk.topic).toBe("Updated topic");
      expect(onDisk.insight).toBe("Updated insight.");
      expect(onDisk.tags).toEqual(["test", "mock", "cache"]);
      expect(onDisk.id).toBe("MEM-007");
      expect(onDisk.created).toBe("2026-07-27T00:00:00.000Z");
      expect(onDisk.session).toBe("ses_test_7");
      expect(onDisk.version).toBe("1.0.0");
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(1);
    });

    it("returns not found for an unknown ID and writes nothing", async () => {
      const result = await hooks.tool.memory_update.execute(
        { id: "MEM-999", entry: { topic: "New topic" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("not found");
      expect(readdirSync(MEMORY_DIR)).toHaveLength(0);
    });

    it("rejects an invalid merged entry (tags length 1) with no write", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(7)]);
      const result = await hooks.tool.memory_update.execute(
        { id: "MEM-007", entry: { tags: ["onlyone"] } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("tags");
      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-007.json"), "utf8"));
      expect(onDisk.tags).toHaveLength(3);
    });

    it("returns Nothing to update for an empty patch", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(7)]);
      const result = await hooks.tool.memory_update.execute(
        { id: "MEM-007", entry: {} },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("Nothing to update");
    });

    it("persists a superseded_by tombstone; search excludes it and write does not dedup-skip", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" })]);
      const result = await hooks.tool.memory_update.execute(
        { id: "MEM-001", entry: { superseded_by: "MEM-002" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      expect(JSON.parse(result).message).toContain("updated");

      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-001.json"), "utf8"));
      expect(onDisk.superseded_by).toBe("MEM-002");

      // Superseded entry is excluded from search
      const search = await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(search)).toEqual([]);

      // A similar write is no longer dedup-skipped against the tombstoned entry
      const write = await hooks.tool.memory_write.execute(
        { entry: { id: "MEM-003", type: "fact", source_kd: "knowledge/test.md", tags: ["auth", "permissions"], topic: "Auth token design", insight: "Fresh insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsedWrite = JSON.parse(write);
      expect(parsedWrite.message).toContain("written");
      expect(parsedWrite.id).toBe("MEM-003");
    });
  });

  describe("memory_delete tool (registered execute)", () => {
    it("rejects deletes from non-Scribe agents with no change", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(9)]);
      const result = await hooks.tool.memory_delete.execute(
        { id: "MEM-009" },
        { agent: "artisan", sessionID: "artisan-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("permission");
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(1);
    });

    it("removes the file and the entry disappears from search", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(9, { tags: ["auth", "permissions"], topic: "Auth token design" })]);
      const result = await hooks.tool.memory_delete.execute(
        { id: "MEM-009" },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("deleted");
      expect(parsed.id).toBe("MEM-009");
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(0);

      const search = await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(search)).toEqual([]);
    });

    it("returns not found for an unknown ID with no change", async () => {
      const result = await hooks.tool.memory_delete.execute(
        { id: "MEM-999" },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("not found");
      expect(readdirSync(MEMORY_DIR)).toHaveLength(0);
    });
  });

  describe("memory_search tool (registered execute)", () => {
    it("returns matching entries for a known tag", async () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["target-tag", "mock", "sample"], topic: "Alpha" }),
        addMemoryEntry(2, { tags: ["other", "unrelated"], topic: "Beta" })
      ]);

      const result = await hooks.tool.memory_search.execute({ tags: ["target-tag"] }, { agent: "artisan", sessionID: "s" });
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe("MEM-001");
      expect(parsed[0].tags).toContain("target-tag");
    });

    it("returns matching entries for a topic substring", async () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { topic: "Authentication flow design", tags: ["auth"] }),
        addMemoryEntry(2, { topic: "Cache invalidation strategy", tags: ["cache"] })
      ]);

      const result = await hooks.tool.memory_search.execute({ topic: "auth" }, { agent: "artisan", sessionID: "s" });
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].topic).toContain("Authentication");
    });

    it("returns empty array when nothing matches", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { tags: ["database"], topic: "SQL queries" })]);

      const result = await hooks.tool.memory_search.execute({ tags: ["nonexistent"], topic: "zzzzz" }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(result)).toEqual([]);
    });
  });

  describe("No named exports (v2.0.0)", () => {
    it("does not export searchMemory as a named export", () => {
      expect(pluginModule.searchMemory).toBeUndefined();
    });

    it("does not export validateMemoryEntry as a named export", () => {
      expect(pluginModule.validateMemoryEntry).toBeUndefined();
    });
  });
});
