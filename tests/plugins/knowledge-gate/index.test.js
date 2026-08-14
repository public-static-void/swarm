import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";

// The plugin reads its data dirs from KNOWLEDGE_GATE_MEMORY_DIR /
// KNOWLEDGE_GATE_ISSUES_DIR / KNOWLEDGE_GATE_SHORT_TERM_DIR env overrides
// (test seam in the plugin). We point them at real temp dirs — no
// vi.mock("fs") needed. The previous approach mocked the fs module
// process-wide, which leaked into sibling suites under bun's test runner and
// made every protocol-gate disk check fail.

let tempRoot;
let MEMORY_DIR;
let ISSUES_DIR;
let SHORT_TERM_DIR;
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
    SHORT_TERM_DIR = join(tempRoot, "short-term");
    process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
    process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
    process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = SHORT_TERM_DIR;
    // Single static import — no query-string module-identity hack. Each
    // server() call owns a fresh memory cache (the cache lives in the server
    // closure), so per-test module re-imports are unnecessary.
    pluginModule = await import("../../../plugins/knowledge-gate/index.js");
  });

  beforeEach(async () => {
    // Reset the temp dirs so each test starts from empty state
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    rmSync(ISSUES_DIR, { recursive: true, force: true });
    rmSync(SHORT_TERM_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    mkdirSync(ISSUES_DIR, { recursive: true });
    mkdirSync(SHORT_TERM_DIR, { recursive: true });
    // Env overrides are read at transform call time — reset them
    // per test so no cap/audience leaks between tests. The dir overrides set
    // in beforeAll are deliberately left untouched.
    delete process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES;
    delete process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE;
    // A fresh server instance carries a fresh in-server memory cache
    hooks = await pluginModule.default.server({}, {});
  });

  afterAll(() => {
    delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
    delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
    delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
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

    it("returns issues in stable severity/id order regardless of write order", () => {
      // Write order permuted against the ids so a filesystem-order read
      // cannot satisfy the expectation (scanHighSeverityIssues derives from
      // the shared sorted scan, not from readdir order).
      writeEntries(ISSUES_DIR, [
        addIssueFile(3, { severity: "high", title: "High C" }),
        addIssueFile(1, { severity: "high", title: "High A" }),
        addIssueFile(2, { severity: "high", title: "High B" })
      ]);

      const results = hooks.scanHighSeverityIssues();
      expect(results.map(i => i.id)).toEqual(["ISSUE-001", "ISSUE-002", "ISSUE-003"]);
    });

    it("ignores non-issue files and subdirectories in the registry dir", () => {
      // Naming-trap guard: only issue-*.md files are scanned. Any derived
      // artifact with another name (or in a subdirectory) stays invisible to
      // both scans.
      writeEntries(ISSUES_DIR, [
        addIssueFile(1, { severity: "high", title: "Real issue" }),
        addIssueFile(2, { severity: "low", title: "Low issue" }),
        { fileName: "README.md", content: "not an issue" }
      ]);
      mkdirSync(join(ISSUES_DIR, "search-index"), { recursive: true });
      writeFileSync(join(ISSUES_DIR, "search-index", "index.json"), "{}");

      expect(hooks.scanHighSeverityIssues()).toHaveLength(1);
      expect(hooks.scanOpenIssues()).toHaveLength(2);
    });
  });

  describe("Vestigial hook removal", () => {
    it("does not register the tool.execute.before hook", () => {
      expect(hooks["tool.execute.before"]).toBeUndefined();
    });

    it("keeps scanHighSeverityIssues exported and functional", () => {
      expect(typeof hooks.scanHighSeverityIssues).toBe("function");
      writeEntries(ISSUES_DIR, [
        addIssueFile(1, { severity: "high", status: "open" }),
        addIssueFile(2, { severity: "low", status: "open" }),
        addIssueFile(3, { severity: "high", status: "resolved" })
      ]);

      const results = hooks.scanHighSeverityIssues();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ISSUE-001");
    });
  });

  describe("scanOpenIssues — cap", () => {
    // 12 open issues: 4 high, 4 medium, 4 low — ids permuted against severity
    // so a filesystem-order read cannot satisfy the stable order expectation.
    function writeTwelveOpen() {
      writeEntries(ISSUES_DIR, [
        addIssueFile(12, { severity: "low", title: "Low L" }),
        addIssueFile(1, { severity: "high", title: "High A" }),
        addIssueFile(11, { severity: "low", title: "Low K" }),
        addIssueFile(2, { severity: "high", title: "High B" }),
        addIssueFile(10, { severity: "low", title: "Low J" }),
        addIssueFile(3, { severity: "high", title: "High C" }),
        addIssueFile(9, { severity: "low", title: "Low I" }),
        addIssueFile(4, { severity: "high", title: "High D" }),
        addIssueFile(8, { severity: "medium", title: "Medium H" }),
        addIssueFile(5, { severity: "medium", title: "Medium E" }),
        addIssueFile(7, { severity: "medium", title: "Medium G" }),
        addIssueFile(6, { severity: "medium", title: "Medium F" })
      ]);
    }

    it("caps after the stable sort, highest severity first, ascending id", () => {
      writeTwelveOpen();
      const capped = hooks.scanOpenIssues({ cap: 10 });
      expect(capped).toHaveLength(10);
      expect(capped.map(i => i.id)).toEqual([
        "ISSUE-001", "ISSUE-002", "ISSUE-003", "ISSUE-004",
        "ISSUE-005", "ISSUE-006", "ISSUE-007", "ISSUE-008",
        "ISSUE-009", "ISSUE-010"
      ]);
      expect(capped.slice(0, 4).every(i => i.severity === "high")).toBe(true);
      expect(capped.slice(4, 8).every(i => i.severity === "medium")).toBe(true);
      expect(capped.slice(8).every(i => i.severity === "low")).toBe(true);
    });

    it("returns the full sorted list when cap is undefined or 0", () => {
      writeTwelveOpen();
      expect(hooks.scanOpenIssues()).toHaveLength(12);
      expect(hooks.scanOpenIssues({ cap: 0 })).toHaveLength(12);
      // Un-capped order still respects the stable sort
      const full = hooks.scanOpenIssues();
      expect(full[0].severity).toBe("high");
      expect(full[11].severity).toBe("low");
    });

    it("ignores invalid cap values (negative, non-integer, non-number)", () => {
      writeTwelveOpen();
      expect(hooks.scanOpenIssues({ cap: -3 })).toHaveLength(12);
      expect(hooks.scanOpenIssues({ cap: 2.5 })).toHaveLength(12);
      expect(hooks.scanOpenIssues({ cap: "10" })).toHaveLength(12);
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

    it("parses a quoted title with escaped embedded quotes", () => {
      const content = `---
id: ISSUE-001
title: "He said \\"hi\\" today"
severity: high
status: open
---
Body`;
      const result = hooks.parseIssueFile(content, "issue-001.md");
      expect(result).toBeTruthy();
      expect(result.title).toBe('He said "hi" today');
    });

    it("parses a multiline quoted title with the newline preserved", () => {
      const content = `---
id: ISSUE-001
title: "Line one
line two"
severity: high
status: open
---
Body`;
      const result = hooks.parseIssueFile(content, "issue-001.md");
      expect(result).toBeTruthy();
      expect(result.title).toBe("Line one\nline two");
    });

    it("parses a quoted title with unescaped embedded quotes via quote-pair strip", () => {
      const content = `---
id: ISSUE-001
title: "He said "hi" today"
severity: high
status: open
---
Body`;
      const result = hooks.parseIssueFile(content, "issue-001.md");
      expect(result).toBeTruthy();
      expect(result.title).toBe('He said "hi" today');
    });

    it("keeps array and plain values intact alongside quoted values", () => {
      const content = `---
id: ISSUE-001
title: "Quoted title"
severity: high
status: open
tags: [auth, permission]
assigned_to: inspector
---
Body`;
      const result = hooks.parseIssueFile(content, "issue-001.md");
      expect(result.title).toBe("Quoted title");
      expect(result.tags).toEqual(["auth", "permission"]);
      expect(result.assigned_to).toBe("inspector");
    });
  });

  describe("parseIssueFile — real registry regression", () => {
    // Legacy parser capture — mirrors the earlier line-anchored value regex so
    // the oracle asserts "unchanged values" on the real registry.
    function legacyParseIssueFile(content, filename) {
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const frontmatter = match[1];
      const result = { filename };
      for (const line of frontmatter.split("\n")) {
        const kv = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
        if (kv) result[kv[1]] = kv[2];
        const arrMatch = line.match(/^(\w+):\s*\[(.*)\]\s*$/);
        if (arrMatch) result[arrMatch[1]] = arrMatch[2].split(",").map(s => s.trim());
      }
      return result;
    }

    it("parses every real registry issue file with unchanged values (guarded)", () => {
      const registryDir = join(process.cwd(), "knowledge", "issues");
      let files;
      try {
        files = readdirSync(registryDir).filter(f => f.startsWith("issue-") && f.endsWith(".md")).sort();
      } catch {
        return; // knowledge/ is gitignored — skip cleanly when absent
      }

      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = readFileSync(join(registryDir, file), "utf8");
        const current = hooks.parseIssueFile(content, file);
        const legacy = legacyParseIssueFile(content, file);

        expect(current, file).not.toBeNull();
        expect(current.filename).toBe(file);
        for (const key of Object.keys(legacy)) {
          expect(current[key], `${file} ${key}`).toEqual(legacy[key]);
        }
        expect(current.id, file).toBeTruthy();
        expect(current.title, file).toBeTruthy();
        expect(current.severity, file).toBeTruthy();
        expect(current.status, file).toBeTruthy();
      }
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

    it("injects no memory-write instruction for habit-builder (Scribe-only division)", async () => {
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

    it("injects a ≤300-byte short-term resume hint when notes exist", async () => {
      await hooks.tool.memory_note.execute(
        { topic: "pending step", content: "M3 promotion work" },
        { agent: "artisan", sessionID: "test-session" }
      );

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "artisan" },
        output
      );
      const hint = output.system.find(s => s.includes("short-term memory note"));
      expect(hint).toBeTruthy();
      expect(hint).toContain("memory_note_read");
      expect(hint).toContain("1 short-term memory note(s)");
      expect(Buffer.byteLength(hint, "utf8")).toBeLessThanOrEqual(300);
    });

    it("injects no short-term resume hint when zero notes exist", async () => {
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "artisan" },
        output
      );
      const hints = output.system.filter(s => s.includes("short-term memory note"));
      expect(hints).toHaveLength(0);
    });

    it("counts all of the agent's notes in the hint", async () => {
      for (let i = 0; i < 3; i++) {
        await hooks.tool.memory_note.execute(
          { topic: `note ${i}`, content: `content ${i}` },
          { agent: "artisan", sessionID: "test-session" }
        );
      }
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "artisan" },
        output
      );
      const hint = output.system.find(s => s.includes("short-term memory note"));
      expect(hint).toContain("3 short-term memory note(s)");
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

    describe("overseer INTENT issue injection", () => {
      const intentHint = output =>
        output.system.find(s => s.includes("Open issues from prior sessions detected"));

      it("injects open issues in the stable line format for the overseer", async () => {
        writeEntries(ISSUES_DIR, [
          addIssueFile(2, { severity: "medium", title: "Format check issue", assigned_to: "inspector" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint).toContain("- [ISSUE-002] (medium) Format check issue — assigned to inspector");
        expect(hint).toContain("Triage Notes");
      });

      it("excludes resolved and closed issues from overseer injection", async () => {
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { status: "open", title: "Open item" }),
          addIssueFile(2, { status: "resolved", title: "Resolved item" }),
          addIssueFile(3, { status: "closed", title: "Closed item" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint).toContain("Open item");
        expect(hint).not.toContain("Resolved item");
        expect(hint).not.toContain("Closed item");
      });

      it("skips a malformed-frontmatter issue file without blocking valid injection", async () => {
        writeEntries(ISSUES_DIR, [
          { fileName: "issue-001.md", content: "no frontmatter at all" },
          addIssueFile(2, { severity: "low", title: "Well-formed issue" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint).toContain("Well-formed issue");
      });

      it("injects no issue block and does not crash when zero open issues exist", async () => {
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { status: "resolved", title: "Only closed item" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        expect(intentHint(output)).toBeUndefined();
      });

      it("falls back to unassigned when an open issue has no assigned_to", async () => {
        const frontmatter = [
          "id: ISSUE-004",
          "title: Ownerless issue",
          "severity: low",
          "status: open",
          "created: 2026-07-29",
          "session: ses_test_4",
          "tags: [test]"
        ].join("\n");
        writeEntries(ISSUES_DIR, [
          { fileName: "issue-004.md", content: `---\n${frontmatter}\n---\n\nBody.` }
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint).toContain("— assigned to unassigned");
      });

      it("injects issues ordered by severity rank and ascending numeric id", async () => {
        // Severity is deliberately permuted against the numeric id order so a
        // filesystem-order (readdirSync) read cannot satisfy the expectation.
        writeEntries(ISSUES_DIR, [
          addIssueFile(4, { severity: "high", title: "High B" }),
          addIssueFile(2, { severity: "high", title: "High A" }),
          addIssueFile(5, { severity: "low", title: "Low E" }),
          addIssueFile(1, { severity: "low", title: "Low D" }),
          addIssueFile(3, { severity: "medium", title: "Medium C" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        const issueLines = hint.split("\n").filter(l => l.startsWith("- [ISSUE-"));
        expect(issueLines).toEqual([
          "- [ISSUE-002] (high) High A — assigned to habit-builder",
          "- [ISSUE-004] (high) High B — assigned to habit-builder",
          "- [ISSUE-003] (medium) Medium C — assigned to habit-builder",
          "- [ISSUE-001] (low) Low D — assigned to habit-builder",
          "- [ISSUE-005] (low) Low E — assigned to habit-builder"
        ]);
      });
    });

    describe("overseer INTENT cap env", () => {
      const intentHint = output =>
        output.system.find(s => s.includes("Open issues from prior sessions detected"));

      function writeTwelveOpen() {
        writeEntries(ISSUES_DIR, [
          addIssueFile(12, { severity: "low", title: "Low L" }),
          addIssueFile(1, { severity: "high", title: "High A" }),
          addIssueFile(11, { severity: "low", title: "Low K" }),
          addIssueFile(2, { severity: "high", title: "High B" }),
          addIssueFile(10, { severity: "low", title: "Low J" }),
          addIssueFile(3, { severity: "high", title: "High C" }),
          addIssueFile(9, { severity: "low", title: "Low I" }),
          addIssueFile(4, { severity: "high", title: "High D" }),
          addIssueFile(8, { severity: "medium", title: "Medium H" }),
          addIssueFile(5, { severity: "medium", title: "Medium E" }),
          addIssueFile(7, { severity: "medium", title: "Medium G" }),
          addIssueFile(6, { severity: "medium", title: "Medium F" })
        ]);
      }

      function issueLines(hint) {
        return hint.split("\n").filter(l => l.startsWith("- [ISSUE-"));
      }

      it("injects exactly 10 issue lines under the default cap, high severity first", async () => {
        writeTwelveOpen();
        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );
        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        const lines = issueLines(hint);
        expect(lines).toHaveLength(10);
        expect(lines[0]).toContain("(high) High A");
        expect(lines[1]).toContain("(high) High B");
        expect(lines[2]).toContain("(high) High C");
        expect(lines[3]).toContain("(high) High D");
      });

      it("treats KNOWLEDGE_GATE_MAX_OPEN_ISSUES=0 as unbounded", async () => {
        process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES = "0";
        writeTwelveOpen();
        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );
        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(issueLines(hint)).toHaveLength(12);
      });

      it("falls back to the default cap 10 for an invalid env value", async () => {
        process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES = "abc";
        writeTwelveOpen();
        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );
        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(issueLines(hint)).toHaveLength(10);
      });

      it("injects no block and does not crash with zero open issues", async () => {
        writeEntries(ISSUES_DIR, [addIssueFile(1, { status: "resolved" })]);
        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );
        expect(intentHint(output)).toBeUndefined();
      });
    });

    describe("overseer INTENT audience routing", () => {
      const intentHint = output =>
        output.system.find(s => s.includes("Open issues from prior sessions detected"));

      it("injects only audience-matched and unassigned issues", async () => {
        process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE = "inspector";
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { assigned_to: "inspector", title: "Inspector item" }),
          addIssueFile(2, { assigned_to: "permission", title: "Permission item" }),
          addIssueFile(3, { assigned_to: "test-harness", title: "Harness item" }),
          addIssueFile(4, { assigned_to: "", title: "Ownerless item" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        const lines = hint.split("\n").filter(l => l.startsWith("- [ISSUE-"));
        expect(lines).toHaveLength(2);
        expect(hint).toContain("Inspector item");
        expect(hint).toContain("Ownerless item");
        expect(hint).toContain("— assigned to unassigned");
        expect(hint).not.toContain("Permission item");
        expect(hint).not.toContain("Harness item");
      });

      it("injects all open issues when the audience env is unset or empty", async () => {
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { assigned_to: "inspector", title: "Inspector item" }),
          addIssueFile(2, { assigned_to: "permission", title: "Permission item" }),
          addIssueFile(3, { assigned_to: "", title: "Ownerless item" })
        ]);

        // unset (deleted in beforeEach)
        let output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );
        let hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint.split("\n").filter(l => l.startsWith("- [ISSUE-"))).toHaveLength(3);

        // empty string
        process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE = "";
        output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );
        hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint.split("\n").filter(l => l.startsWith("- [ISSUE-"))).toHaveLength(3);
      });

      it("matches the audience case-insensitively as a substring", async () => {
        process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE = "INSPECTOR";
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { assigned_to: "inspector", title: "Inspector item" }),
          addIssueFile(2, { assigned_to: "habit-builder", title: "Habit item" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint).toContain("Inspector item");
        expect(hint).not.toContain("Habit item");
      });

      it("applies the audience filter before the cap (filter then cap)", async () => {
        process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE = "inspector";
        process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES = "1";
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { assigned_to: "inspector", title: "Inspector item" }),
          addIssueFile(2, { assigned_to: "inspector", title: "Inspector item 2" }),
          addIssueFile(3, { assigned_to: "permission", title: "Permission item" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        const lines = hint.split("\n").filter(l => l.startsWith("- [ISSUE-"));
        // Filter yields 2 inspector issues; cap 1 → 1 line, and it must be an
        // inspector issue (a cap-then-filter order could never produce this).
        expect(lines).toHaveLength(1);
        expect(hint).toContain("Inspector item");
        expect(hint).not.toContain("Permission item");
      });

      it("keeps the habit-builder EVOLVE branch unfiltered and uncapped", async () => {
        process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE = "inspector";
        process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES = "1";
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { assigned_to: "habit-builder", title: "Habit item" }),
          addIssueFile(2, { assigned_to: "inspector", title: "Inspector item" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "habit-builder" },
          output
        );

        const closeHint = output.system.find(s => s.includes("Open issues detected"));
        expect(closeHint).toBeTruthy();
        expect(closeHint).toContain("Habit item");
        expect(closeHint).toContain("Inspector item");
      });
    });

    describe("overseer INTENT marker line", () => {
      const intentHint = output =>
        output.system.find(s => s.includes("Open issues from prior sessions detected"));

      function issueLines(hint) {
        return hint.split("\n").filter(l => l.startsWith("- [ISSUE-"));
      }

      it("starts the injected block with the marker line, count = injected lines", async () => {
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { severity: "high", title: "High A" }),
          addIssueFile(2, { severity: "medium", title: "Medium B" }),
          addIssueFile(3, { severity: "low", title: "Low C" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        const lines = hint.split("\n");
        expect(lines[0]).toBe("[Knowledge Gate] Open issues from prior sessions detected:");
        expect(lines[1]).toBe("<!-- issues-snapshot v1: 3 open, stable order -->");
        expect(issueLines(hint)).toHaveLength(3);
      });

      it("reports the post-cap count in the marker", async () => {
        // 12 open issues under the default cap 10 → the marker says 10 and
        // exactly 10 issue lines follow (the marker measures the injected set).
        writeEntries(ISSUES_DIR, [
          addIssueFile(12, { severity: "low", title: "Low L" }),
          addIssueFile(1, { severity: "high", title: "High A" }),
          addIssueFile(11, { severity: "low", title: "Low K" }),
          addIssueFile(2, { severity: "high", title: "High B" }),
          addIssueFile(10, { severity: "low", title: "Low J" }),
          addIssueFile(3, { severity: "high", title: "High C" }),
          addIssueFile(9, { severity: "low", title: "Low I" }),
          addIssueFile(4, { severity: "high", title: "High D" }),
          addIssueFile(8, { severity: "medium", title: "Medium H" }),
          addIssueFile(5, { severity: "medium", title: "Medium E" }),
          addIssueFile(7, { severity: "medium", title: "Medium G" }),
          addIssueFile(6, { severity: "medium", title: "Medium F" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint).toContain("<!-- issues-snapshot v1: 10 open, stable order -->");
        expect(issueLines(hint)).toHaveLength(10);
      });

      it("reports the post-audience count in the marker", async () => {
        process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE = "inspector";
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { assigned_to: "inspector", title: "Inspector item" }),
          addIssueFile(2, { assigned_to: "inspector", title: "Inspector item 2" }),
          addIssueFile(3, { assigned_to: "permission", title: "Permission item" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );

        const hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint).toContain("<!-- issues-snapshot v1: 2 open, stable order -->");
        expect(issueLines(hint)).toHaveLength(2);
        expect(hint).not.toContain("Permission item");
      });

      it("keeps the EVOLVE close-loop intact, format unchanged and marker-free", async () => {
        writeEntries(ISSUES_DIR, [
          addIssueFile(1, { severity: "medium", title: "Open issue A", assigned_to: "habit-builder" }),
          addIssueFile(2, { status: "resolved", severity: "high", title: "Closed issue B" })
        ]);

        const output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "habit-builder" },
          output
        );

        const closeHint = output.system.find(s => s.includes("Open issues detected"));
        expect(closeHint).toBeTruthy();
        // Unchanged line format, Close Issues step intact, resolved excluded
        expect(closeHint).toContain("- [ISSUE-001] (medium) Open issue A — assigned to habit-builder");
        expect(closeHint).toContain("Close Issues");
        expect(closeHint).not.toContain("Closed issue B");
        // The marker line is overseer-only — never in the EVOLVE block
        expect(closeHint).not.toContain("issues-snapshot");
      });
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

    it("does not dedup-skip a write with 3 shared tags but unrelated topics", async () => {
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

    it("clears a superseded_by tombstone via empty string; entry reappears in search", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" })]);
      await hooks.tool.memory_update.execute(
        { id: "MEM-001", entry: { superseded_by: "MEM-002" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );

      const cleared = await hooks.tool.memory_update.execute(
        { id: "MEM-001", entry: { superseded_by: "" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      expect(JSON.parse(cleared).message).toContain("updated");

      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-001.json"), "utf8"));
      expect(onDisk.superseded_by).toBe("");

      // Un-superseded entry is searchable again
      const search = await hooks.tool.memory_search.execute({ tags: ["auth"], limit: 5 }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(search).map(e => e.id)).toContain("MEM-001");
    });

    it("clears a superseded_by tombstone via null at the code level", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(2, { tags: ["auth", "permissions"], topic: "Auth token design" })]);
      await hooks.tool.memory_update.execute(
        { id: "MEM-002", entry: { superseded_by: "MEM-003" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );

      const cleared = await hooks.tool.memory_update.execute(
        { id: "MEM-002", entry: { superseded_by: null } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      expect(JSON.parse(cleared).message).toContain("updated");

      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-002.json"), "utf8"));
      expect(onDisk.superseded_by).toBeNull();
    });

    it("is idempotent when clearing an entry that has no tombstone", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(3, { tags: ["auth", "permissions"], topic: "Auth token design" })]);
      const result = await hooks.tool.memory_update.execute(
        { id: "MEM-003", entry: { superseded_by: "" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      expect(JSON.parse(result).message).toContain("updated");

      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-003.json"), "utf8"));
      expect(onDisk.superseded_by).toBe("");

      const search = await hooks.tool.memory_search.execute({ tags: ["auth"], limit: 5 }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(search).map(e => e.id)).toContain("MEM-003");
    });

    it("treats a patch containing only superseded_by \"\" as a clear, not an empty patch", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(4, { tags: ["auth", "permissions"], topic: "Auth token design" })]);
      await hooks.tool.memory_update.execute(
        { id: "MEM-004", entry: { superseded_by: "MEM-005" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );

      const result = await hooks.tool.memory_update.execute(
        { id: "MEM-004", entry: { superseded_by: "" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.message).toContain("updated");
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

  describe("memory search index (R001 derived index)", () => {
    // The index (memory-search-index.jsonl) is a derived, rebuildable
    // projection of the entry files — never the source of truth. Its name
    // must NOT end in ".json" and must NOT start with "entry-" so every
    // existing filter/count assertion stays intact (R001.2). All file
    // expectations are verified from disk under the temp MEMORY_DIR seam.

    it("creates a compliant index on memory_write and leaves the entry unmodified", async () => {
      const entry = { id: "MEM-020", type: "fact", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight for index write.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry }, { agent: "scribe", sessionID: "scribe-session" });
      expect(JSON.parse(result).message).toContain("written");

      // Write-through produced the index with a naming-compliant filename
      expect(existsSync(join(MEMORY_DIR, "memory-search-index.jsonl"))).toBe(true);
      expect("memory-search-index.jsonl".endsWith(".json")).toBe(false);
      expect("memory-search-index.jsonl".startsWith("entry-")).toBe(false);
      // The .json count filters still see exactly the one entry file
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toEqual(["entry-020.json"]);
      // Atomic write leaves no tmp file behind
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".tmp"))).toEqual([]);

      // The entry written by the same call is unmodified (source of truth)
      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-020.json"), "utf8"));
      expect(onDisk.topic).toBe("Test topic");
      expect(onDisk.insight).toBe("Test insight for index write.");
    });

    it("index has schema v1 with the searchable projection and tombstone field", async () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design", source_kd: "knowledge/composed-a.md" })
      ]);
      // Cold cache + no index → first search backfills the index
      await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });

      const doc = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(doc.version).toBe(1);
      expect(doc.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(Number.isInteger(doc.entryCount)).toBe(true);
      expect(doc.entryCount).toBe(1);
      expect(doc.entries).toHaveLength(1);
      expect(doc.entries[0]).toEqual({
        id: "MEM-001",
        source_kd: "knowledge/composed-a.md",
        tags: ["auth", "permissions"],
        topic: "Auth token design",
        insight: "This is test insight 1 for verification purposes.",
        type: "fact",
        created: "2026-07-21T00:00:00.000Z",
        session: "ses_test_1",
        version: "1.0.0",
        superseded_by: null
      });
    });

    it("reflects a superseded_by tombstone in the index and excludes the entry from search", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" })]);
      await hooks.tool.memory_update.execute(
        { id: "MEM-001", entry: { superseded_by: "MEM-002" } },
        { agent: "scribe", sessionID: "scribe-session" }
      );

      // Write-through on update preserves the tombstone in the index
      const doc = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(doc.entries[0].superseded_by).toBe("MEM-002");
      expect(doc.entries[0].id).toBe("MEM-001");

      // The unchanged !superseded_by search filter still excludes it
      const search = await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(search)).toEqual([]);
    });

    it("drops a deleted entry from the index and decreases entryCount", async () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" }),
        addMemoryEntry(2, { tags: ["cache", "testing"], topic: "Cache invalidation" })
      ]);
      await hooks.tool.memory_search.execute({ tags: [] }, { agent: "artisan", sessionID: "s" });

      let doc = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(doc.entryCount).toBe(2);

      await hooks.tool.memory_delete.execute({ id: "MEM-001" }, { agent: "scribe", sessionID: "scribe-session" });

      doc = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(doc.entryCount).toBe(1);
      expect(doc.entries.map(e => e.id)).toEqual(["MEM-002"]);

      const search = await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(search)).toEqual([]);
    });

    it("reflects promoted notes in the index with the composed KD as source_kd", async () => {
      await hooks.tool.memory_note.execute(
        { topic: "Session insight", content: "A distilled insight worth keeping.", tags: ["auth", "testing"] },
        { agent: "artisan", sessionID: "promo-session" }
      );

      const result = hooks.promoteShortTermNotes("promo-session", "knowledge/composed-promo-ses_abc.md");
      expect(result.promoted).toHaveLength(1);

      // Write-through runs once after the promotion loop (≥1 entry promoted)
      const doc = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(doc.entryCount).toBe(1);
      expect(doc.entries[0].source_kd).toBe("knowledge/composed-promo-ses_abc.md");
      expect(doc.entries[0].topic).toBe("Session insight");
    });

    it("rebuilds a missing index on cache miss and serves correct results", async () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["target-tag", "mock", "sample"], topic: "Alpha" }),
        addMemoryEntry(2, { tags: ["other", "unrelated"], topic: "Beta" })
      ]);

      // Cold cache + no index → cache miss rebuilds (backfill) before serving
      const result = await hooks.tool.memory_search.execute({ tags: ["target-tag"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(result)).toHaveLength(1);
      expect(JSON.parse(result)[0].id).toBe("MEM-001");
      expect(existsSync(join(MEMORY_DIR, "memory-search-index.jsonl"))).toBe(true);

      // Delete the index and force a cache miss via an external file change —
      // the next search rebuilds it again
      rmSync(join(MEMORY_DIR, "memory-search-index.jsonl"));
      writeEntries(MEMORY_DIR, [addMemoryEntry(3, { tags: ["target-tag"], topic: "Gamma" })]);

      const again = await hooks.tool.memory_search.execute({ tags: ["target-tag"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(again).map(r => r.id)).toEqual(["MEM-003", "MEM-001"]);
      expect(existsSync(join(MEMORY_DIR, "memory-search-index.jsonl"))).toBe(true);
      const rebuilt = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(rebuilt.entryCount).toBe(3);
    });

    it("rebuilds a corrupt index on cache miss", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" })]);
      writeFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "{ not valid json", "utf8");

      const result = await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(result).map(e => e.id)).toEqual(["MEM-001"]);

      // The corrupt file was replaced by a valid rebuild
      const doc = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(doc.version).toBe(1);
      expect(doc.entryCount).toBe(1);
    });

    it("rebuilds a version- or count-mismatched index on cache miss (validity gate)", async () => {
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" })]);

      // Version mismatch (version: 2) → invalid per R001.4 → rebuild
      writeFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), JSON.stringify({ version: 2, updated: new Date().toISOString(), entryCount: 1, entries: [] }), "utf8");
      const r1 = await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(r1).map(e => e.id)).toEqual(["MEM-001"]);

      // Count mismatch (entryCount 5 but 1 entry on disk) + external change
      // forces a cache miss → invalid per R001.4 → rebuild
      writeFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), JSON.stringify({ version: 1, updated: new Date().toISOString(), entryCount: 5, entries: [] }), "utf8");
      writeEntries(MEMORY_DIR, [addMemoryEntry(2, { tags: ["auth", "testing"], topic: "Auth refresh tokens" })]);
      const r2 = await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(r2).map(e => e.id)).toEqual(["MEM-002", "MEM-001"]);

      const doc = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(doc.version).toBe(1);
      expect(doc.entryCount).toBe(2);
    });

    it("serves the same result set and order as the scan path (search parity)", async () => {
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["auth", "permissions"], topic: "Auth token design" }),
        addMemoryEntry(2, { tags: ["cache", "testing"], topic: "Cache invalidation strategy" }),
        addMemoryEntry(3, { tags: ["auth", "testing"], topic: "Auth refresh tokens" })
      ]);

      // Query auth: MEM-003 (1 tag overlap) and MEM-001 (1 tag overlap) score
      // equally, so recency breaks the tie (MEM-003 newest first). MEM-002
      // scores 0 and drops out. Scoring/order are identical whether entries
      // come from the scan or the index.
      const result = await hooks.tool.memory_search.execute({ tags: ["auth"], limit: 5 }, { agent: "artisan", sessionID: "s" });
      const parsed = JSON.parse(result);
      expect(parsed.map(r => r.id)).toEqual(["MEM-003", "MEM-001"]);
      expect(parsed[0]).toEqual({ id: "MEM-003", source_kd: "knowledge/composed-test-3.md", tags: ["auth", "testing"], topic: "Auth refresh tokens", insight: "This is test insight 3 for verification purposes." });

      // The projected index entries are field-for-field the on-disk sources
      const doc = JSON.parse(readFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), "utf8"));
      expect(doc.entries).toHaveLength(3);
      expect(doc.entries.map(e => e.id).sort()).toEqual(["MEM-001", "MEM-002", "MEM-003"]);
      expect(doc.entries[0]).toEqual({
        id: "MEM-001",
        source_kd: "knowledge/composed-test-1.md",
        tags: ["auth", "permissions"],
        topic: "Auth token design",
        insight: "This is test insight 1 for verification purposes.",
        type: "fact",
        created: "2026-07-21T00:00:00.000Z",
        session: "ses_test_1",
        version: "1.0.0",
        superseded_by: null
      });
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

  describe("short-term memory tools (memory_note family)", () => {
    // Exercised through the registered executes with an explicit agent
    // context — matching the memory_write/memory_delete suite pattern. All
    // file expectations are verified from disk under the temp short-term root
    // (no fs mocking).

    it("exposes the four short-term tools with description, args, and execute", () => {
      for (const name of ["memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete"]) {
        expect(hooks.tool[name]).toBeTruthy();
        expect(typeof hooks.tool[name].description).toBe("string");
        expect(hooks.tool[name].args).toBeTruthy();
        expect(typeof hooks.tool[name].execute).toBe("function");
      }
    });

    it("memory_note writes note-001.json with the R002 schema into the caller's namespace", async () => {
      const result = await hooks.tool.memory_note.execute(
        { topic: "In-flight step", content: "Phase SWARM, pending P005, todo list open", tags: ["state"] },
        { agent: "artisan", sessionID: "note-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("written");
      expect(parsed.id).toBe("ST-note-session-artisan-001");

      const note = JSON.parse(readFileSync(join(SHORT_TERM_DIR, "note-session", "artisan", "note-001.json"), "utf8"));
      expect(note.id).toBe("ST-note-session-artisan-001");
      expect(note.agent).toBe("artisan");
      expect(note.session).toBe("note-session");
      expect(note.topic).toBe("In-flight step");
      expect(note.content).toBe("Phase SWARM, pending P005, todo list open");
      expect(note.tags).toEqual(["state"]);
      expect(note.version).toBe("1.0.0");
      expect(note.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("sequentially numbers notes per agent namespace", async () => {
      await hooks.tool.memory_note.execute({ topic: "One", content: "first" }, { agent: "artisan", sessionID: "seq-session" });
      const second = await hooks.tool.memory_note.execute({ topic: "Two", content: "second" }, { agent: "artisan", sessionID: "seq-session" });
      const parsed = JSON.parse(second);
      expect(parsed.id).toBe("ST-seq-session-artisan-002");
      expect(readdirSync(join(SHORT_TERM_DIR, "seq-session", "artisan")).filter(f => f.endsWith(".json"))).toHaveLength(2);
    });

    it("rejects oversized topic/content and invalid tags with nothing persisted", async () => {
      const longTopic = "x".repeat(101);
      const r1 = await hooks.tool.memory_note.execute({ topic: longTopic, content: "ok" }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(r1).error).toContain("topic");

      const longContent = "x".repeat(2001);
      const r2 = await hooks.tool.memory_note.execute({ topic: "ok", content: longContent }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(r2).error).toContain("content");

      const r3 = await hooks.tool.memory_note.execute({ topic: "ok", content: "ok", tags: ["a", "b", "c", "d", "e", "f"] }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(r3).error).toContain("tags");

      // Nothing persisted for any rejection
      expect(readdirSync(SHORT_TERM_DIR)).toHaveLength(0);
    });

    it("writes only into the caller's namespace (structural cross-agent write boundary)", async () => {
      // memory_note takes no agent/session args — the namespace is derived
      // from caller identity, so a write can never target another agent's
      // namespace (R003 boundary is structural).
      await hooks.tool.memory_note.execute({ topic: "mine", content: "only" }, { agent: "artisan", sessionID: "note-session" });
      expect(readdirSync(join(SHORT_TERM_DIR, "note-session"))).toEqual(["artisan"]);
      expect(existsSync(join(SHORT_TERM_DIR, "note-session", "scribe"))).toBe(false);
      expect(existsSync(join(SHORT_TERM_DIR, "other-session"))).toBe(false);
    });

    it("rejects traversal-shaped session/agent tokens before any path join", async () => {
      const r1 = await hooks.tool.memory_note.execute({ topic: "x", content: "y" }, { agent: "../evil", sessionID: "note-session" });
      expect(JSON.parse(r1).error).toContain("Invalid");
      // Nothing was written outside the short-term root
      expect(readdirSync(SHORT_TERM_DIR)).toHaveLength(0);

      const r2 = await hooks.tool.memory_note.execute({ topic: "x", content: "y" }, { agent: "artisan", sessionID: "../escape" });
      expect(JSON.parse(r2).error).toContain("Invalid");
      expect(readdirSync(SHORT_TERM_DIR)).toHaveLength(0);
    });

    it("lets the owner read its own note by id", async () => {
      const w = await hooks.tool.memory_note.execute({ topic: "own", content: "readable" }, { agent: "artisan", sessionID: "note-session" });
      const id = JSON.parse(w).id;
      const r = await hooks.tool.memory_note_read.execute({ id }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(r).id).toBe(id);
    });

    it("rejects cross-agent reads by id for non-Scribe callers", async () => {
      await hooks.tool.memory_note.execute({ topic: "scribe note", content: "private" }, { agent: "scribe", sessionID: "note-session" });
      const r = await hooks.tool.memory_note_read.execute({ id: "ST-note-session-scribe-001" }, { agent: "artisan", sessionID: "note-session" });
      const parsed = JSON.parse(r);
      expect(parsed.error).toContain("Permission denied");
      expect(parsed.error).toContain("artisan");
    });

    it("lets Scribe read any agent's note by id (promotion path)", async () => {
      await hooks.tool.memory_note.execute({ topic: "artisan note", content: "for promotion" }, { agent: "artisan", sessionID: "note-session" });
      const r = await hooks.tool.memory_note_read.execute({ id: "ST-note-session-artisan-001" }, { agent: "scribe", sessionID: "note-session" });
      expect(JSON.parse(r).id).toBe("ST-note-session-artisan-001");
    });

    it("allows namespace reads only for Scribe", async () => {
      await hooks.tool.memory_note.execute({ topic: "t", content: "c" }, { agent: "artisan", sessionID: "note-session" });
      const denied = await hooks.tool.memory_note_read.execute({ agent: "artisan" }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(denied).error).toContain("Permission denied");

      const allowed = await hooks.tool.memory_note_read.execute({ agent: "artisan", session: "note-session" }, { agent: "scribe", sessionID: "note-session" });
      expect(JSON.parse(allowed)).toHaveLength(1);
    });

    it("memory_notes_list: owner sees only its own notes; Scribe sees all agents", async () => {
      await hooks.tool.memory_note.execute({ topic: "a1", content: "c" }, { agent: "artisan", sessionID: "note-session" });
      await hooks.tool.memory_note.execute({ topic: "s1", content: "c" }, { agent: "scribe", sessionID: "note-session" });

      const ownerList = await hooks.tool.memory_notes_list.execute({}, { agent: "artisan", sessionID: "note-session" });
      const ownerParsed = JSON.parse(ownerList);
      expect(ownerParsed).toHaveLength(1);
      expect(ownerParsed[0].agent).toBe("artisan");

      const scribeList = await hooks.tool.memory_notes_list.execute({}, { agent: "scribe", sessionID: "note-session" });
      expect(JSON.parse(scribeList)).toHaveLength(2);
    });

    it("memory_notes_list: Scribe can list every agent's notes in a session (promotion scan)", async () => {
      await hooks.tool.memory_note.execute({ topic: "a1", content: "c" }, { agent: "artisan", sessionID: "note-session" });
      await hooks.tool.memory_note.execute({ topic: "s1", content: "c" }, { agent: "scribe", sessionID: "note-session" });
      const all = await hooks.tool.memory_notes_list.execute({ session: "note-session" }, { agent: "scribe", sessionID: "note-session" });
      const parsed = JSON.parse(all);
      expect(parsed).toHaveLength(2);
      expect(parsed.map(n => n.topic).sort()).toEqual(["a1", "s1"]);
    });

    it("memory_notes_list: owner cannot list another agent's notes", async () => {
      await hooks.tool.memory_note.execute({ topic: "s1", content: "c" }, { agent: "scribe", sessionID: "note-session" });
      const r = await hooks.tool.memory_notes_list.execute({ agent: "scribe" }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(r).error).toContain("Permission denied");
    });

    it("memory_note_delete: owner deletes own note; cross-agent delete rejected", async () => {
      const w = await hooks.tool.memory_note.execute({ topic: "doomed", content: "gone" }, { agent: "artisan", sessionID: "note-session" });
      const id = JSON.parse(w).id;
      const r = await hooks.tool.memory_note_delete.execute({ id }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(r).message).toContain("deleted");
      expect(readdirSync(join(SHORT_TERM_DIR, "note-session", "artisan"))).toHaveLength(0);

      await hooks.tool.memory_note.execute({ topic: "scribe's", content: "protected" }, { agent: "scribe", sessionID: "note-session" });
      const denied = await hooks.tool.memory_note_delete.execute({ id: "ST-note-session-scribe-001" }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(denied).error).toContain("Permission denied");
      expect(existsSync(join(SHORT_TERM_DIR, "note-session", "scribe", "note-001.json"))).toBe(true);
    });

    it("memory_note_delete: Scribe may delete any agent's note", async () => {
      await hooks.tool.memory_note.execute({ topic: "t", content: "c" }, { agent: "artisan", sessionID: "note-session" });
      const r = await hooks.tool.memory_note_delete.execute({ id: "ST-note-session-artisan-001" }, { agent: "scribe", sessionID: "note-session" });
      expect(JSON.parse(r).message).toContain("deleted");
      expect(existsSync(join(SHORT_TERM_DIR, "note-session", "artisan", "note-001.json"))).toBe(false);
    });

    it("100-note cap: the 101st write evicts the oldest note", async () => {
      const ctx = { agent: "artisan", sessionID: "cap-session" };
      for (let i = 1; i <= 101; i++) {
        const r = await hooks.tool.memory_note.execute({ topic: `note ${i}`, content: `content ${i}` }, ctx);
        // The 101st write must still succeed — eviction happens before the write
        expect(JSON.parse(r).id).toBe(`ST-cap-session-artisan-${String(i).padStart(3, "0")}`);
      }
      const files = readdirSync(join(SHORT_TERM_DIR, "cap-session", "artisan")).filter(f => f.endsWith(".json"));
      expect(files).toHaveLength(100);
      // Oldest evicted, newest present
      expect(files).not.toContain("note-001.json");
      expect(files).toContain("note-101.json");
    });

    it("short-term notes never appear in memory_search and never reuse MEM-* IDs", async () => {
      await hooks.tool.memory_note.execute({ topic: "resume state", content: "pending step" }, { agent: "artisan", sessionID: "note-session" });
      // Long-term search reads MEMORY_DIR only — structurally excludes the
      // short-term store (R001: notes never surface in memory_search).
      const search = await hooks.tool.memory_search.execute({ tags: [], topic: "resume", limit: 20 }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(search)).toEqual([]);

      // Note files live under the ST- namespace, disjoint from MEM-* files
      const noteFiles = readdirSync(join(SHORT_TERM_DIR, "note-session", "artisan"));
      expect(noteFiles[0]).toMatch(/^note-\d{3}\.json$/);

      // A seeded long-term entry keeps its MEM-* id — no id collision
      writeEntries(MEMORY_DIR, [addMemoryEntry(1, { topic: "resume" })]);
      const results = JSON.parse(await hooks.tool.memory_search.execute({ tags: [], topic: "resume", limit: 20 }, { agent: "artisan", sessionID: "s" }));
      expect(results.map(r => r.id)).toEqual(["MEM-001"]);
    });

    it("skips malformed note JSON when listing (mirror loadEntriesFromDisk)", async () => {
      const dir = join(SHORT_TERM_DIR, "note-session", "artisan");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "note-001.json"), "{ not valid json", "utf8");
      writeFileSync(join(dir, "note-002.json"), JSON.stringify({ id: "ST-note-session-artisan-002", agent: "artisan", session: "note-session", created: "2026-08-11T00:00:00.000Z", topic: "good", content: "ok", version: "1.0.0" }), "utf8");
      const list = await hooks.tool.memory_notes_list.execute({}, { agent: "artisan", sessionID: "note-session" });
      const parsed = JSON.parse(list);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].topic).toBe("good");
    });

    it("returns not found for unknown note ids on read and delete", async () => {
      const r = await hooks.tool.memory_note_read.execute({ id: "ST-note-session-artisan-999" }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(r).error).toContain("not found");

      const d = await hooks.tool.memory_note_delete.execute({ id: "ST-note-session-artisan-999" }, { agent: "artisan", sessionID: "note-session" });
      expect(JSON.parse(d).error).toContain("not found");
    });
  });

  describe("short-term promotion (promoteShortTermNotes)", () => {
    it("promotes notes into long-term memory with the COMPOSED KD as source_kd, then clears the session store", async () => {
      await hooks.tool.memory_note.execute({ topic: "Session insight one", content: "A distilled insight worth keeping for later sessions.", tags: ["auth"] }, { agent: "artisan", sessionID: "promo-session" });
      await hooks.tool.memory_note.execute({ topic: "Session insight two", content: "Another important finding for the memory store." }, { agent: "scribe", sessionID: "promo-session" });

      const result = hooks.promoteShortTermNotes("promo-session", "knowledge/composed-promo-ses_abc.md");

      expect(result.promoted).toHaveLength(2);
      expect(result.skipped).toHaveLength(0);
      expect(result.cleared).toBe(true);

      // Long-term entries exist with the COMPOSED KD as source_kd (copy-then-clear)
      const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"));
      expect(files).toHaveLength(2);
      for (const f of files) {
        const entry = JSON.parse(readFileSync(join(MEMORY_DIR, f), "utf8"));
        expect(entry.source_kd).toBe("knowledge/composed-promo-ses_abc.md");
        expect(entry.session).toBe("promo-session");
      }

      // The short-term session store is cleared after the copies land (OQ-3)
      expect(existsSync(join(SHORT_TERM_DIR, "promo-session"))).toBe(false);
    });

    it("skips duplicate promotions without error and keeps one long-term entry", async () => {
      await hooks.tool.memory_note.execute({ topic: "Duplicate insight", content: "Same insight content as the seeded entry.", tags: ["auth", "testing"] }, { agent: "artisan", sessionID: "promo-session" });
      // Seed a long-term entry that the promoted note duplicates (shared tags + overlapping topic)
      writeEntries(MEMORY_DIR, [
        addMemoryEntry(1, { tags: ["auth", "testing"], topic: "Duplicate insight", source_kd: "knowledge/composed-promo-ses_abc.md" })
      ]);

      const result = hooks.promoteShortTermNotes("promo-session", "knowledge/composed-promo-ses_abc.md");

      expect(result.promoted).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain("duplicate");
      // Only the seeded entry remains — no duplicate long-term entry
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(1);
      // Copy-then-clear still holds: the store is cleared
      expect(existsSync(join(SHORT_TERM_DIR, "promo-session"))).toBe(false);
    });

    it("promotes only notes selected by the select predicate", async () => {
      await hooks.tool.memory_note.execute({ topic: "Keep me", content: "Important insight." }, { agent: "artisan", sessionID: "promo-session" });
      await hooks.tool.memory_note.execute({ topic: "Drop me", content: "Transient detail." }, { agent: "artisan", sessionID: "promo-session" });

      const result = hooks.promoteShortTermNotes("promo-session", "knowledge/composed-promo-ses_abc.md", {
        select: note => note.topic === "Keep me"
      });

      expect(result.promoted).toHaveLength(1);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe("not selected");
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(1);
      expect(existsSync(join(SHORT_TERM_DIR, "promo-session"))).toBe(false);
    });

    it("truncates long note content to the 500-char insight bound", async () => {
      await hooks.tool.memory_note.execute({ topic: "Long insight", content: "x".repeat(600), tags: ["auth", "testing"] }, { agent: "artisan", sessionID: "promo-session" });

      const result = hooks.promoteShortTermNotes("promo-session", "knowledge/composed-promo-ses_abc.md");
      expect(result.promoted).toHaveLength(1);
      const file = readdirSync(MEMORY_DIR).find(f => f.endsWith(".json"));
      const entry = JSON.parse(readFileSync(join(MEMORY_DIR, file), "utf8"));
      expect(entry.insight.length).toBeLessThanOrEqual(500);
      expect(entry.insight.endsWith("...")).toBe(true);
    });

    it("rejects traversal-shaped session tokens without writing or clearing", async () => {
      const result = hooks.promoteShortTermNotes("../escape", "knowledge/composed-promo-ses_abc.md");
      expect(result.error).toBe("Invalid session token");
      expect(result.cleared).toBe(false);
      expect(readdirSync(MEMORY_DIR)).toHaveLength(0);
    });

    it("injects the Scribe promotion instruction via systemTransform", async () => {
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "scribe" },
        output
      );
      const promo = output.system.find(s => s.includes("promote important short-term notes"));
      expect(promo).toBeTruthy();
      expect(promo).toContain("memory_notes_list");
      expect(promo).toContain("memory_note_read");
      expect(promo).toContain("memory_write");
      expect(promo).toContain("COMPOSED KD");
      expect(promo).toContain("memory_note_delete");
      expect(promo).toContain("After the copies land");
    });
  });
});
