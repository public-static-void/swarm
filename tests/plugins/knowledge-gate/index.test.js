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
      // Add 2 entries: one with matching tags, one without
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [
        addMemoryEntry(1, { tags: ["target-tag", "mock", "sample"], topic: "Alpha" }),
        addMemoryEntry(2, { tags: ["other", "unrelated"], topic: "Beta" })
      ];

      const results = hooks.searchMemory({ tags: ["target-tag"], topic: "", limit: 5 });
      // Only entries with matching tags get score > 0 and pass the filter
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
      // Both match (no filter) — newer should come first
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
      // Directory exists but is empty
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

    it("injects scribe-specific write instructions for scribe agent", async () => {
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "scribe" },
        output
      );
      // Scribe gets the base instruction + memory write instruction
      const writeInstr = output.system.find(s => s.includes("COMPOSED KD"));
      expect(writeInstr).toBeTruthy();
    });
  });

  describe("validateMemoryEntry", () => {
    it("accepts a valid memory entry", () => {
      const valid = {
        id: "MEM-001",
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

    it("rejects entry with wrong id format", () => {
      const invalid = {
        id: "entry-001",
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
      source_kd: "knowledge/composed-test.md",
      tags: ["test", "sample"],
      topic: "Test topic",
      insight: "This is a test insight.",
      created: "2026-07-29T00:00:00.000Z",
      session: "ses_test",
      version: "1.0.0"
    };

    it("produces markdown format", () => {
      const result = hooks.formatMemoryEntry(entry, "markdown");
      expect(result).toContain("MEM-001");
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

      // First call — cache miss, reads from disk
      const r1 = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(r1).toHaveLength(1);
      expect(mockFs.readdirSync).toHaveBeenCalledTimes(1);

      // Clear call count for second assertion
      mockFs.readdirSync.mockClear();

      // Second call — should be cache hit (entries from cache, not re-parsed from disk)
      const r2 = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(r2).toHaveLength(1);
      // readdirSync was called once for file-count check in isCacheValid (not for full reload)
      expect(mockFs.readdirSync).toHaveBeenCalledTimes(1);
      // The entries should be the same object reference (from cache)
      expect(r1).toEqual(r2);
    });

    it("invalidates cache when a new file is added", () => {
      const memDir = MEMORY_DIR;
      mockFs._files[memDir] = [addMemoryEntry(1)];

      // First call populates cache
      hooks.searchMemory({ tags: [], topic: "", limit: 5 });

      // Add a new file (simulating new entry written by Scribe)
      mockFs._files[memDir].push(addMemoryEntry(2));
      mockFs.readdirSync.mockClear();

      // Second call — should detect file count change and reload
      const r2 = hooks.searchMemory({ tags: [], topic: "", limit: 5 });
      expect(r2).toHaveLength(2);
    });
  });

  describe("Named exports", () => {
    it("exports searchMemory, validateMemoryEntry, and formatMemoryEntry as named exports", () => {
      expect(typeof plugin.searchMemory).toBe("function");
      expect(typeof plugin.validateMemoryEntry).toBe("function");
      expect(typeof plugin.formatMemoryEntry).toBe("function");
      expect(typeof plugin.scanHighSeverityIssues).toBe("function");
    });
  });
});
