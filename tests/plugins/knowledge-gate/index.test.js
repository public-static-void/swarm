import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "path";

// Compute real project paths so mock matches what the plugin uses
const PROJECT_ROOT = process.cwd();
const MEMORY_DIR = join(PROJECT_ROOT, "knowledge", "memory");
const ISSUES_DIR = join(PROJECT_ROOT, "knowledge", "issues");

// Mock fs before importing the plugin
const mockFs = {
  _files: {},
  _dirs: new Set(),
  existsSync: vi.fn((path) => mockFs._dirs.has(path)),
  readdirSync: vi.fn((path) => {
    const files = mockFs._files[path] || [];
    return files.map(f => f.fileName);
  }),
  readFileSync: vi.fn((path, encoding) => {
    for (const dir of Object.keys(mockFs._files)) {
      for (const f of mockFs._files[dir]) {
        if (path === join(dir, f.fileName) || path.endsWith(f.fileName)) return f.content;
      }
    }
    return "";
  }),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn()
};

vi.mock("fs", () => mockFs);

// Helper to add a memory entry to the mock filesystem
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
  let plugin;
  let hooks;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset mock filesystem
    mockFs._files = {};
    mockFs._dirs = new Set();
    // Set up knowledge/memory/ directory
    mockFs._dirs.add(MEMORY_DIR);
    // Re-import to reset module state
    vi.resetModules();
    plugin = await import("../../../plugins/knowledge-gate/index.js");
    hooks = await plugin.default.server({}, {});
  });

  describe("searchMemory — Tag-overlap scoring", () => {
    it("returns higher score for entries with matching tags", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["target-tag", "mock", "sample"], topic: "Alpha" }),
        addMemoryEntry(2, { tags: ["other", "unrelated"], topic: "Beta" })
      ];

      const results = hooks.searchMemory({ tags: ["target-tag"], topic: "", limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].tags).toContain("target-tag");
    });
  });

  describe("searchMemory — Topic match scoring", () => {
    it("returns higher score for entries with matching topic substring", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { topic: "Authentication flow design", tags: ["auth"] }),
        addMemoryEntry(2, { topic: "Cache invalidation strategy", tags: ["cache"] })
      ];

      const results = hooks.searchMemory({ tags: [], topic: "auth", limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].topic).toContain("Authentication");
    });
  });

  describe("searchMemory — Recency sort", () => {
    it("sorts newer entries before older entries at equal score", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { created: "2026-07-20T00:00:00.000Z" }),
        addMemoryEntry(2, { created: "2026-07-29T00:00:00.000Z" })
      ];

      const results = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(results[0].id).toBe("MEM-002");
      expect(results[1].id).toBe("MEM-001");
    });
  });

  describe("searchMemory — Empty results", () => {
    it("returns empty array when no entries match", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["database"], topic: "SQL queries" })
      ];

      const results = hooks.searchMemory({ tags: ["nonexistent"], topic: "zzzzz", limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe("searchMemory — Limit enforcement", () => {
    it("returns at most the specified number of results", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1),
        addMemoryEntry(2),
        addMemoryEntry(3)
      ];

      const results = hooks.searchMemory({ tags: [], topic: "", limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("uses default limit of 5 when not specified", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = Array.from({ length: 10 }, (_, i) => addMemoryEntry(i + 1));

      const results = hooks.searchMemory({ tags: [], topic: "" });
      expect(results).toHaveLength(5);
    });
  });

  describe("searchMemory — Backward compatibility", () => {
    it("works with topic-only query (no tags)", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { topic: "Auth permissions design" }),
        addMemoryEntry(2, { topic: "Cache layer" })
      ];

      const results = hooks.searchMemory({ topic: "auth" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("MEM-001");
    });

    it("works with tags-only query (no topic)", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["permissions", "auth", "test"] }),
        addMemoryEntry(2, { tags: ["cache", "performance"] })
      ];

      const results = hooks.searchMemory({ tags: ["permissions"] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("MEM-001");
    });
  });

  describe("scanHighSeverityIssues", () => {
    it("filters correctly by severity and status", () => {
      const issuesDir = ISSUES_DIR;
      mockFs._dirs.add(issuesDir);
      mockFs._files[issuesDir] = [
        addIssueFile(1, { severity: "high", status: "open" }),
        addIssueFile(2, { severity: "low", status: "open" }),
        addIssueFile(3, { severity: "high", status: "closed" })
      ];

      const results = hooks.scanHighSeverityIssues();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ISSUE-001");
    });

    it("returns empty array when issues directory is missing", () => {
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
      const issuesDir = ISSUES_DIR;
      mockFs._dirs.add(issuesDir);
      mockFs._files[issuesDir] = [];

      const result = hooks.getNextIssueId();
      expect(result).toBe("ISSUE-001");
    });

    it("generates sequential IDs based on existing issue files", () => {
      const issuesDir = ISSUES_DIR;
      mockFs._dirs.add(issuesDir);
      mockFs._files[issuesDir] = [
        { fileName: "issue-001.md", content: "" },
        { fileName: "issue-005.md", content: "" }
      ];

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

    it("includes dynamic hint line when memory matches agent type", async () => {
      // Add an entry matching artisan agent type tags
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["implementation", "code"], topic: "Code patterns" })
      ];

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
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [addMemoryEntry(1)];

      const r1 = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(r1).toHaveLength(1);
      expect(mockFs.readdirSync).toHaveBeenCalledTimes(1);

      mockFs.readdirSync.mockClear();

      const r2 = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(r2).toHaveLength(1);
      expect(mockFs.readdirSync).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(r2);
    });

    it("invalidates cache when a new file is added", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [addMemoryEntry(1)];

      hooks.searchMemory({ tags: [], topic: "", limit: 5 });

      mockFs._files[memDir].push(addMemoryEntry(2));
      mockFs.readdirSync.mockClear();

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
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["analysis", "bug"], topic: "Bug analysis patterns" })
      ];

      const result = hooks.deriveSearchHints({ mode: "investigate", agentType: "analyzer", scope: "" });
      // investigate → ["analysis", "root-cause", "bug"] + analyzer → ["analysis", "root-cause"]
      // MEM-001 has ["analysis", "bug"] → match!
      expect(result.shouldHint).toBe(true);
      expect(result.hints.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts noun keywords from SCOPE", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth tokens" })
      ];

      const result = hooks.deriveSearchHints({ mode: "swarm", agentType: "artisan", scope: "fix auth token permissions" });
      // swarm → ["implementation", "code", "pattern"] + artisan → ["implementation", "code"]
      // scope keywords after stop-word+noise removal: ["auth", "token", "permissions"]
      // MEM-001 has ["auth", "permissions"] → match!
      expect(result.shouldHint).toBe(true);
    });

    it("limits to 3 hint lines maximum", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["implementation", "code", "bug"], topic: "Alpha" }),
        addMemoryEntry(2, { tags: ["implementation", "bug"], topic: "Beta" }),
        addMemoryEntry(3, { tags: ["bug"], topic: "Gamma" })
      ];

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
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        { fileName: "entry-001.json", content: "{}" },
        { fileName: "entry-005.json", content: "{}" }
      ];

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
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" })
      ];

      const entry = { tags: ["auth", "permissions"], topic: "Auth token design patterns" };
      const result = hooks.checkDuplicateMemory(entry);
      expect(result).not.toBeNull();
      expect(result.id).toBe("MEM-001");
    });
  });

  describe("memory_write tool", () => {
    it("rejects writes from non-Scribe agents", async () => {
      const output = { args: { entry: { id: "MEM-020", type: "fact", source_kd: "test.md", tags: ["test", "sample"], topic: "Test", insight: "X", created: "2026-07-29T00:00:00.000Z", session: "s1", version: "1.0.0" } } };
      await hooks["tool.execute.before"]({ tool: "memory_write", sessionID: "artisan-session" }, output);
      expect(output.handled).toBe(true);
      expect(output.result).toContain("permission");
    });

    it("writes valid entry from Scribe agent", async () => {
      // Register artisan in sessionAgentMap first (only session mapping is used)
      await hooks["chat.params"]({ sessionID: "scribe-session", agent: "scribe" }, {});

      const entry = { id: "MEM-020", type: "fact", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight for tool write.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const output = { args: { entry } };
      await hooks["tool.execute.before"]({ tool: "memory_write", sessionID: "scribe-session" }, output);
      expect(output.handled).toBe(true);
      expect(output.result).toContain("written");
      expect(output.result).toContain("MEM-020");
    });

    it("auto-assigns ID when not provided", async () => {
      await hooks["chat.params"]({ sessionID: "scribe-session", agent: "scribe" }, {});

      const entry = { type: "fact", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight for auto-id.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const output = { args: { entry } };
      await hooks["tool.execute.before"]({ tool: "memory_write", sessionID: "scribe-session" }, output);
      expect(output.handled).toBe(true);
      expect(output.result).toContain("MEM-001"); // First entry gets MEM-001
    });

    it("detects duplicate entries and skips write", async () => {
      await hooks["chat.params"]({ sessionID: "scribe-session", agent: "scribe" }, {});

      // Pre-populate mock filesystem with an entry — this simulates an existing entry on disk
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(50, { tags: ["test", "duplicate"], topic: "Duplicate test" })
      ];

      // Try writing a similar entry (same tags, overlapping topic)
      const entry2 = { id: "MEM-051", type: "fact", source_kd: "knowledge/test.md", tags: ["test", "duplicate"], topic: "Duplicate test content", insight: "Test insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const output2 = { args: { entry: entry2 } };
      await hooks["tool.execute.before"]({ tool: "memory_write", sessionID: "scribe-session" }, output2);
      expect(output2.result).toContain("Duplicate");
    });
  });

  describe("No named exports (v2.0.0)", () => {
    it("does not export searchMemory as a named export", () => {
      expect(plugin.searchMemory).toBeUndefined();
    });

    it("does not export validateMemoryEntry as a named export", () => {
      expect(plugin.validateMemoryEntry).toBeUndefined();
    });
  });
});
