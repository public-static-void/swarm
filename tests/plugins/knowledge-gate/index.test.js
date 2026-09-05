import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { basename, join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

// Plugin debug channel destination (KNOWLEDGE_GATE_DEBUG=1 appends here).
// Used by the memory-index hygiene tests to assert on emitted diagnostics.
const KG_LOG_FILE = fileURLToPath(new URL("../../../plugins/logs/knowledge-gate.log", import.meta.url));

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
    it("filters correctly by severity and status across all stores", () => {
      writeEntries(ISSUES_DIR, [
        addIssueFile(1, { severity: "high", status: "open" }),
        addIssueFile(2, { severity: "low", status: "open" }),
        addIssueFile(3, { severity: "high", status: "closed" })
      ]);

      const results = hooks.scanHighSeverityIssues();
      // Triple-store seam: the single high/open issue is surfaced once per
      // store scope; low severity and closed status are excluded everywhere.
      expect(results).toHaveLength(3);
      expect(results.every(i => i.id === "ISSUE-001")).toBe(true);
      expect(new Set(results.map(i => i.scope))).toEqual(new Set(["swarm", "project", "generic"]));
    });

    it("returns empty array when issues directory is missing", () => {
      rmSync(ISSUES_DIR, { recursive: true, force: true });
      const results = hooks.scanHighSeverityIssues();
      expect(results).toEqual([]);
    });

    it("returns issues in stable severity/id order regardless of write order", () => {
      // Write order permuted against the ids so a filesystem-order read
      // cannot satisfy the expectation (scanHighSeverityIssues derives from
      // the shared sorted scan, not from readdir order). Triple-store seam:
      // each issue appears once per scope, interleaved within each id group.
      writeEntries(ISSUES_DIR, [
        addIssueFile(3, { severity: "high", title: "High C" }),
        addIssueFile(1, { severity: "high", title: "High A" }),
        addIssueFile(2, { severity: "high", title: "High B" })
      ]);

      const results = hooks.scanHighSeverityIssues();
      expect(results.map(i => `${i.id}:${i.scope}`)).toEqual([
        "ISSUE-001:swarm", "ISSUE-001:project", "ISSUE-001:generic",
        "ISSUE-002:swarm", "ISSUE-002:project", "ISSUE-002:generic",
        "ISSUE-003:swarm", "ISSUE-003:project", "ISSUE-003:generic"
      ]);
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

      expect(hooks.scanHighSeverityIssues()).toHaveLength(3);
      expect(hooks.scanOpenIssues()).toHaveLength(2);
    });

    it("surfaces high-severity issues from every store so any store can trigger transitions", () => {
      // A high-severity issue must reach the backward-transition trigger no
      // matter which store holds it — the scan reads all three stores and
      // tags each hit with its scope.
      writeEntries(ISSUES_DIR, [
        addIssueFile(7, { severity: "high", title: "Blocking regression" })
      ]);

      const results = hooks.scanHighSeverityIssues();
      const scopes = results.map(i => i.scope).sort();
      expect(scopes).toEqual(["generic", "project", "swarm"]);
      expect(results.every(i => i.severity === "high")).toBe(true);
      expect(results.every(i => i.status === "open")).toBe(true);
    });
  });

  describe("scanOpenIssuesMerged", () => {
    it("includes open issues from all three stores with scope tags", () => {
      // Triple-store seam: one file is visible to every store pass, so a
      // single open issue yields one tagged result per store — proving the
      // merged scan covers swarm, project, and generic.
      writeEntries(ISSUES_DIR, [
        addIssueFile(4, { severity: "medium", title: "Cross-store issue" })
      ]);

      const results = hooks.scanOpenIssuesMerged();
      expect(results).toHaveLength(3);
      expect(new Set(results.map(i => i.scope))).toEqual(new Set(["swarm", "project", "generic"]));
      expect(results.every(i => i.id === "ISSUE-004")).toBe(true);
    });

    it("excludes resolved issues from the merged scan", () => {
      writeEntries(ISSUES_DIR, [
        addIssueFile(1, { status: "open", title: "Still open" }),
        addIssueFile(2, { status: "resolved", title: "Done" })
      ]);

      const results = hooks.scanOpenIssuesMerged();
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(i => i.id === "ISSUE-001")).toBe(true);
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
      // Triple-store seam: one high/open issue surfaced once per store scope
      expect(results).toHaveLength(3);
      expect(results.every(i => i.id === "ISSUE-001")).toBe(true);
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
      const createHint = output.system.find(s => s.includes("create issue files via"));
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

    it("enumerates the three scopes in the habit-builder issue-creation hint", async () => {
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"](
        { sessionID: "test-session", agent: "habit-builder" },
        output
      );

      const createHint = output.system.find(s => s.includes("create issue files via"));
      expect(createHint).toBeTruthy();
      // The scope enum must be spelled out to match validateIssue — an
      // unenumerated "copied from frontmatter" phrasing is how the doc/gate
      // drift class crept in (Issue 66).
      expect(createHint).toContain("project|generic|swarm");
      expect(createHint).not.toContain("scope copied from");
    });

    describe("overseer INTENT issue injection", () => {
      const intentHint = output =>
        output.system.find(s => s.includes("Open issues from all stores detected"));

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
        expect(hint).toContain("- [swarm/ISSUE-002] (medium) Format check issue — assigned to inspector");
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
        // Unbounded cap: 5 issues × 2 stores (swarm+generic, config dir) = 10,
        // within default cap 10. Set explicit unbounded to test ordering.
        process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES = "0";
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
        const issueLines = hint.split("\n").filter(l => l.startsWith("- ["));
        // Workspace-aware: config dir scans swarm+generic only (2 stores),
        // so each issue appears twice, interleaved within each severity group.
        expect(issueLines).toEqual([
          "- [swarm/ISSUE-002] (high) High A — assigned to habit-builder",
          "- [generic/ISSUE-002] (high) High A — assigned to habit-builder",
          "- [swarm/ISSUE-004] (high) High B — assigned to habit-builder",
          "- [generic/ISSUE-004] (high) High B — assigned to habit-builder",
          "- [swarm/ISSUE-003] (medium) Medium C — assigned to habit-builder",
          "- [generic/ISSUE-003] (medium) Medium C — assigned to habit-builder",
          "- [swarm/ISSUE-001] (low) Low D — assigned to habit-builder",
          "- [generic/ISSUE-001] (low) Low D — assigned to habit-builder",
          "- [swarm/ISSUE-005] (low) Low E — assigned to habit-builder",
          "- [generic/ISSUE-005] (low) Low E — assigned to habit-builder"
        ]);
      });
    });

    describe("overseer INTENT cap env", () => {
      const intentHint = output =>
        output.system.find(s => s.includes("Open issues from all stores detected"));

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
        return hint.split("\n").filter(l => l.startsWith("- ["));
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
        // Workspace-aware: config dir scans swarm+generic only (2 stores).
        // 12 issues → 24 total; cap 10 takes the 10 highest-severity entries.
        // 4 high issues × 2 stores = 8, cap remaining = 2 → first medium × 2.
        expect(lines[0]).toContain("High A");
        expect(lines[1]).toContain("High A");
        expect(lines[2]).toContain("High B");
        expect(lines[3]).toContain("High B");
        expect(lines[4]).toContain("High C");
        expect(lines[5]).toContain("High C");
        expect(lines[6]).toContain("High D");
        expect(lines[7]).toContain("High D");
        expect(lines[8]).toContain("Medium E");
        expect(lines[9]).toContain("Medium E");
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
        // Workspace-aware: config dir scans swarm+generic only (2 stores),
        // so 12 unique issues × 2 = 24
        expect(issueLines(hint)).toHaveLength(24);
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
        output.system.find(s => s.includes("Open issues from all stores detected"));

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
        const lines = hint.split("\n").filter(l => l.startsWith("- ["));
        // Workspace-aware: config dir scans swarm+generic only (2 stores),
        // so 2 audience-matched × 2 = 4
        expect(lines).toHaveLength(4);
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
        // Workspace-aware: config dir scans swarm+generic (2 stores), 3 issues × 2 = 6
        expect(hint.split("\n").filter(l => l.startsWith("- ["))).toHaveLength(6);

        // empty string
        process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE = "";
        output = { system: [] };
        await hooks["experimental.chat.system.transform"](
          { sessionID: "test-session", agent: "overseer" },
          output
        );
        hint = intentHint(output);
        expect(hint).toBeTruthy();
        expect(hint.split("\n").filter(l => l.startsWith("- ["))).toHaveLength(6);
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
        const lines = hint.split("\n").filter(l => l.startsWith("- ["));
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
        output.system.find(s => s.includes("Open issues from all stores detected"));

      function issueLines(hint) {
        return hint.split("\n").filter(l => l.startsWith("- ["));
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
        expect(lines[0]).toBe("[Knowledge Gate] Open issues from all stores detected:");
        // Workspace-aware: config dir scans swarm+generic only (2 stores),
        // so 3 issue files × 2 = 6
        expect(lines[1]).toBe("<!-- issues-snapshot v1: 6 open, stable order -->");
        expect(issueLines(hint)).toHaveLength(6);
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
        // Workspace-aware: config dir scans swarm+generic (2 stores),
        // 2 audience-matched issues × 2 = 4
        expect(hint).toContain("<!-- issues-snapshot v1: 4 open, stable order -->");
        expect(issueLines(hint)).toHaveLength(4);
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
        // [scope/id] line format, Close Issues step intact, resolved excluded
        expect(closeHint).toContain("- [swarm/ISSUE-001] (medium) Open issue A — assigned to habit-builder");
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

    it("accepts every valid scope value and rejects an unknown one", () => {
      const base = {
        id: "MEM-001",
        type: "fact",
        source_kd: "knowledge/composed-test.md",
        tags: ["test", "sample"],
        topic: "Test topic",
        insight: "Test insight.",
        created: "2026-07-29T00:00:00.000Z",
        session: "ses_test",
        version: "1.0.0"
      };
      for (const scope of ["project", "generic", "swarm"]) {
        expect(hooks.validateMemoryEntry({ ...base, scope })).toEqual({ valid: true });
      }
      // Absent scope stays legal — pre-isolation entries on disk lack the field
      expect(hooks.validateMemoryEntry(base)).toEqual({ valid: true });
      const bad = hooks.validateMemoryEntry({ ...base, scope: "everything" });
      expect(bad.valid).toBe(false);
      expect(bad.error).toContain("scope");
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
        { entry: { id: "MEM-002", type: "fact", source_kd: "knowledge/test.md", tags: ["permissions", "testing", "cache"], topic: "Cache invalidation strategy", insight: "Test insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" }, scope: "swarm" },
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

    it("exposes issue_write with description, args, and execute", () => {
      expect(hooks.tool.issue_write).toBeTruthy();
      expect(typeof hooks.tool.issue_write.description).toBe("string");
      expect(hooks.tool.issue_write.args).toBeTruthy();
      expect(typeof hooks.tool.issue_write.execute).toBe("function");
    });

    it("exposes issue_update with description, args, and execute", () => {
      expect(hooks.tool.issue_update).toBeTruthy();
      expect(typeof hooks.tool.issue_update.description).toBe("string");
      expect(hooks.tool.issue_update.args).toBeTruthy();
      expect(typeof hooks.tool.issue_update.execute).toBe("function");
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
      const result = await hooks.tool.memory_write.execute({ entry, scope: "swarm" }, { agent: "scribe", sessionID: "scribe-session" });
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("written");
      expect(parsed.id).toBe("MEM-020");
      const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe("entry-020.json");
    });

    it("auto-assigns ID when not provided", async () => {
      const entry = { type: "fact", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight for auto-id.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry, scope: "swarm" }, { agent: "scribe", sessionID: "scribe-session" });
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
      const result = await hooks.tool.memory_write.execute({ entry: entry2, scope: "swarm" }, { agent: "scribe", sessionID: "scribe-session" });
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("Duplicate");
      // No second file written
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(1);
    });

    it("rejects invalid schema entry with no write", async () => {
      const entry = { id: "MEM-020", type: "not-a-valid-type", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry, scope: "swarm" }, { agent: "scribe", sessionID: "scribe-session" });
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
      const result = await hooks.tool.memory_write.execute({ entry, scope: "swarm" }, { agent: "scribe", sessionID: "scribe-session" });
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("Duplicate");
    });

    it("rejects explicit id collision — second write with same id errors and preserves first file", async () => {
      // First write: explicit id MEM-020 succeeds
      const first = { id: "MEM-020", type: "fact", source_kd: "knowledge/first.md", tags: ["test", "sample"], topic: "First entry", insight: "Original content.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const r1 = JSON.parse(await hooks.tool.memory_write.execute({ entry: first, scope: "swarm" }, { agent: "scribe", sessionID: "scribe-session" }));
      expect(r1.message).toContain("written");
      expect(r1.id).toBe("MEM-020");

      // Second write: different entry, same explicit id — must error
      const second = { id: "MEM-020", type: "fact", source_kd: "knowledge/second.md", tags: ["test", "sample"], topic: "Second entry", insight: "Overwrite attempt.", created: "2026-07-30T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const r2 = JSON.parse(await hooks.tool.memory_write.execute({ entry: second, scope: "swarm" }, { agent: "scribe", sessionID: "scribe-session" }));
      expect(r2.error).toContain("already exists");

      // First file is preserved unchanged
      const onDisk = JSON.parse(readFileSync(join(MEMORY_DIR, "entry-020.json"), "utf8"));
      expect(onDisk.topic).toBe("First entry");
      expect(onDisk.insight).toBe("Original content.");
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
        { entry: { id: "MEM-003", type: "fact", source_kd: "knowledge/test.md", tags: ["auth", "permissions"], topic: "Auth token design", insight: "Fresh insight.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" }, scope: "swarm" },
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

  describe("issue_write tool (registered execute)", () => {
    // NOTE: the suite-level KNOWLEDGE_GATE_ISSUES_DIR seam collapses both
    // stores onto one temp dir, so these tests exercise gate, scope
    // classification, schema validation, ID assignment, and frontmatter
    // persistence. True physical per-store separation (two dirs, independent
    // counters) is covered by the fresh-module describe at the end.
    function issueFor(overrides = {}) {
      return {
        title: "Test issue",
        severity: "high",
        created: "2026-08-16",
        session: "ses_test",
        scope: "swarm",
        ...overrides
      };
    }

    it("rejects writes from non-habit-builder agents with no file written", async () => {
      const result = await hooks.tool.issue_write.execute(
        { issue: issueFor() },
        { agent: "artisan", sessionID: "artisan-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("permission");
      expect(readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-"))).toHaveLength(0);
    });

    it("rejects a write with missing scope (no inference)", async () => {
      const issue = issueFor();
      delete issue.scope;
      const result = await hooks.tool.issue_write.execute(
        { issue },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("scope");
      expect(readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-"))).toHaveLength(0);
    });

    it("rejects an invalid scope with an error listing the valid values", async () => {
      const result = await hooks.tool.issue_write.execute(
        { issue: issueFor({ scope: "other" }) },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("project");
      expect(parsed.error).toContain("swarm");
      expect(readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-"))).toHaveLength(0);
    });

    it("rejects invalid schema (bad severity) with no write", async () => {
      const result = await hooks.tool.issue_write.execute(
        { issue: issueFor({ severity: "critical" }) },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("severity");
      expect(readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-"))).toHaveLength(0);
    });

    it("rejects a non-open status at creation", async () => {
      const result = await hooks.tool.issue_write.execute(
        { issue: issueFor({ status: "resolved" }) },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("status");
      expect(readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-"))).toHaveLength(0);
    });

    it("writes exactly one file and returns { message, id, scope, path } from habit-builder", async () => {
      const result = await hooks.tool.issue_write.execute(
        { issue: issueFor() },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("written");
      expect(parsed.id).toBe(1);
      expect(parsed.scope).toBe("swarm");
      expect(parsed.path).toContain("issue-1.md");
      const files = readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-"));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe("issue-1.md");
    });

    it("persists the full frontmatter schema including scope and the body sections", async () => {
      const result = await hooks.tool.issue_write.execute(
        {
          issue: issueFor({
            title: "Persist test",
            severity: "medium",
            assigned_to: "inspector",
            tags: ["test", "mock"],
            description: "The description.",
            source_kd_reference: "knowledge/spec-test.md",
            recommended_fix: "Do the fix.",
            acceptance_criteria: "Tests pass."
          })
        },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      expect(JSON.parse(result).id).toBe(1);
      const raw = readFileSync(join(ISSUES_DIR, "issue-1.md"), "utf8");
      const parsed = hooks.parseIssueFile(raw, "issue-1.md");
      expect(parsed.id).toBe("1");
      expect(parsed.title).toBe("Persist test");
      expect(parsed.severity).toBe("medium");
      expect(parsed.status).toBe("open");
      expect(parsed.created).toBe("2026-08-16");
      expect(parsed.session).toBe("ses_test");
      expect(parsed.assigned_to).toBe("inspector");
      expect(parsed.tags).toEqual(["test", "mock"]);
      expect(parsed.scope).toBe("swarm");
      expect(raw).toContain("# Issue 1: Persist test");
      expect(raw).toContain("## Description");
      expect(raw).toContain("## Source KD Reference");
      expect(raw).toContain("## Recommended Fix");
      expect(raw).toContain("## Acceptance Criteria");
    });

    it("auto-assigns sequential numeric IDs", async () => {
      const r1 = JSON.parse(await hooks.tool.issue_write.execute(
        { issue: issueFor({ title: "One" }) },
        { agent: "habit-builder", sessionID: "hb-session" }
      ));
      const r2 = JSON.parse(await hooks.tool.issue_write.execute(
        { issue: issueFor({ title: "Two" }) },
        { agent: "habit-builder", sessionID: "hb-session" }
      ));
      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
    });

    it("honors an explicit id", async () => {
      const result = JSON.parse(await hooks.tool.issue_write.execute(
        { issue: issueFor({ id: 7, title: "Explicit" }) },
        { agent: "habit-builder", sessionID: "hb-session" }
      ));
      expect(result.id).toBe(7);
      expect(existsSync(join(ISSUES_DIR, "issue-7.md"))).toBe(true);
    });
  });

  describe("issue_update tool (registered execute)", () => {
    async function seedIssue(id = 1, overrides = {}) {
      await hooks.tool.issue_write.execute(
        {
          issue: {
            id,
            title: `Seed ${id}`,
            severity: "medium",
            created: "2026-08-16",
            session: "ses_test",
            assigned_to: "inspector",
            tags: ["test", "mock"],
            scope: "swarm",
            ...overrides
          }
        },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
    }

    it("rejects updates from non-habit-builder agents with no file modified", async () => {
      await seedIssue(1);
      const before = readFileSync(join(ISSUES_DIR, "issue-1.md"), "utf8");
      const result = await hooks.tool.issue_update.execute(
        { id: 1, scope: "swarm", changes: { status: "resolved" } },
        { agent: "artisan", sessionID: "artisan-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("permission");
      expect(readFileSync(join(ISSUES_DIR, "issue-1.md"), "utf8")).toBe(before);
    });

    it("flips status to resolved and appends a Resolution section for an issue in the named store", async () => {
      await seedIssue(1);
      const result = await hooks.tool.issue_update.execute(
        { id: 1, scope: "swarm", changes: { status: "resolved", resolution: "Fixed in impl KD." } },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("updated");
      expect(parsed.id).toBe(1);
      expect(parsed.path).toContain("issue-1.md");
      const raw = readFileSync(join(ISSUES_DIR, "issue-1.md"), "utf8");
      expect(raw).toMatch(/status: resolved/);
      expect(raw).toMatch(/## Resolution \(\d{4}-\d{2}-\d{2}\)/);
      expect(raw).toContain("Fixed in impl KD.");
    });

    it("closes via resolution alone (status implied) and preserves the issue schema", async () => {
      await seedIssue(1);
      const result = await hooks.tool.issue_update.execute(
        { id: 1, scope: "swarm", changes: { resolution: "Done in review KD." } },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      expect(JSON.parse(result).message).toContain("updated");
      const raw = readFileSync(join(ISSUES_DIR, "issue-1.md"), "utf8");
      const parsed = hooks.parseIssueFile(raw, "issue-1.md");
      expect(parsed.status).toBe("resolved");
      expect(parsed.id).toBe("1");
      expect(parsed.title).toBe("Seed 1");
      expect(parsed.severity).toBe("medium");
      expect(parsed.created).toBe("2026-08-16");
      expect(parsed.session).toBe("ses_test");
      expect(parsed.assigned_to).toBe("inspector");
      expect(parsed.tags).toEqual(["test", "mock"]);
      expect(parsed.scope).toBe("swarm");
    });

    it("requires scope parameter — rejects when scope is omitted", async () => {
      await seedIssue(3);
      const result = await hooks.tool.issue_update.execute(
        { id: 3, changes: { resolution: "Cross-store close." } },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("scope parameter is required");
    });

    it("requires scope parameter — rejects when scope is omitted for missing id", async () => {
      const result = await hooks.tool.issue_update.execute(
        { id: 99, changes: { status: "resolved" } },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("scope parameter is required");
    });

    it("returns an error naming the store for a missing id when scope is provided", async () => {
      const result = await hooks.tool.issue_update.execute(
        { id: 99, scope: "swarm", changes: { status: "resolved" } },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("not found");
      expect(parsed.error).toContain("swarm");
    });

    it("rejects invalid changes values with no file modified", async () => {
      await seedIssue(1);
      const before = readFileSync(join(ISSUES_DIR, "issue-1.md"), "utf8");
      const result = await hooks.tool.issue_update.execute(
        { id: 1, scope: "swarm", changes: { status: "bogus" } },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("status");
      expect(readFileSync(join(ISSUES_DIR, "issue-1.md"), "utf8")).toBe(before);
    });

    it("rejects an empty changes object", async () => {
      await seedIssue(1);
      const result = await hooks.tool.issue_update.execute(
        { id: 1, scope: "swarm", changes: {} },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      expect(JSON.parse(result).error).toContain("Nothing to update");
    });

    it("rejects an invalid scope", async () => {
      const result = await hooks.tool.issue_update.execute(
        { id: 1, scope: "other", changes: { status: "resolved" } },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      expect(JSON.parse(result).error).toContain("scope");
    });

    it("updates assigned_to", async () => {
      await seedIssue(1);
      await hooks.tool.issue_update.execute(
        { id: 1, scope: "swarm", changes: { assigned_to: "pathfinder" } },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const raw = readFileSync(join(ISSUES_DIR, "issue-1.md"), "utf8");
      expect(raw).toContain("pathfinder");
    });
  });

  describe("issue_move tool (registered execute)", () => {
    async function seedIssue(id = 1, overrides = {}) {
      await hooks.tool.issue_write.execute(
        {
          issue: {
            id,
            title: `Seed ${id}`,
            severity: "medium",
            created: "2026-08-16",
            session: "ses_test",
            assigned_to: "inspector",
            tags: ["test", "mock"],
            scope: "swarm",
            ...overrides
          }
        },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
    }

    it("exposes issue_move with description, args, and execute", () => {
      expect(hooks.tool.issue_move).toBeTruthy();
      expect(typeof hooks.tool.issue_move.description).toBe("string");
      expect(hooks.tool.issue_move.args).toBeTruthy();
      expect(typeof hooks.tool.issue_move.execute).toBe("function");
    });

    it("moves an issue from swarm to project store", async () => {
      await seedIssue(1);
      const result = await hooks.tool.issue_move.execute(
        { id: 1, from_scope: "swarm", to_scope: "project" },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.message).toContain("moved");
      expect(parsed.from_scope).toBe("swarm");
      expect(parsed.to_scope).toBe("project");
      // Issue should no longer exist in swarm store
      expect(existsSync(join(ISSUES_DIR, "issue-1.md"))).toBe(false);
    });

    it("rejects moves by non-authorized agents", async () => {
      await seedIssue(1);
      const result = await hooks.tool.issue_move.execute(
        { id: 1, from_scope: "swarm", to_scope: "project" },
        { agent: "artisan", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("permission");
    });

    it("rejects Overseer attempting to move issues", async () => {
      await seedIssue(2);
      const result = await hooks.tool.issue_move.execute(
        { id: 2, from_scope: "swarm", to_scope: "generic" },
        { agent: "overseer", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("permission");
    });

    it("rejects move to same scope", async () => {
      await seedIssue(3);
      const result = await hooks.tool.issue_move.execute(
        { id: 3, from_scope: "swarm", to_scope: "swarm" },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("same scope");
    });

    it("rejects move of non-existent issue", async () => {
      const result = await hooks.tool.issue_move.execute(
        { id: 999, from_scope: "swarm", to_scope: "project" },
        { agent: "habit-builder", sessionID: "hb-session" }
      );
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("not found");
    });

    // F-001 collision safety: per-store independent ID spaces make same-ID
    // collisions the expected case when bubbling low-numbered project IDs up
    // to the swarm store. A move must never overwrite an existing target file
    // — it reassigns a fresh target-store ID and records provenance
    // in frontmatter instead. Fresh module instance without seams so swarm
    // and project stores are physically distinct dirs.
    describe("issue_move collision safety (fresh module instance)", () => {
      let moveHooks;
      let configRoot;
      let projectRoot;

      beforeAll(async () => {
        configRoot = mkdtempSync(join(tmpdir(), "kg-move-config-"));
        projectRoot = mkdtempSync(join(tmpdir(), "kg-move-project-"));
        delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
        process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
        process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRoot;
        const fresh = await import("../../../plugins/knowledge-gate/index.js?move-collision");
        moveHooks = await fresh.default.server({}, {});
      });

      afterAll(() => {
        process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
        delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
        delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
        rmSync(configRoot, { recursive: true, force: true });
        rmSync(projectRoot, { recursive: true, force: true });
      });

      async function seedIssueIn(scope, title, id) {
        const issue = { title, severity: "medium", created: "2026-08-21", session: "ses_move", scope };
        if (id !== undefined) issue.id = id;
        return JSON.parse(await moveHooks.tool.issue_write.execute(
          { issue },
          { agent: "habit-builder", sessionID: "hb" }
        ));
      }

      it("reassigns a fresh target-store ID instead of overwriting an existing same-ID issue", async () => {
        // Both stores legitimately hold their own first issue (per-store counters)
        const swarmSeeded = await seedIssueIn("swarm", "Swarm bubble-up candidate");
        const projectSeeded = await seedIssueIn("project", "Existing project issue one");
        expect(swarmSeeded.id).toBe(1);
        expect(projectSeeded.id).toBe(1);
        const projectOneBefore = readFileSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "issues", "issue-1.md"), "utf8");

        const result = JSON.parse(await moveHooks.tool.issue_move.execute(
          { id: 1, from_scope: "swarm", to_scope: "project", reason: "swarm defect found while working in a project" },
          { agent: "habit-builder", sessionID: "hb" }
        ));

        expect(result.error).toBeUndefined();
        expect(result.id).toBe(2);
        expect(result.source_id).toBe(1);
        // Existing project issue file preserved byte-for-byte — no data loss
        expect(readFileSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "issues", "issue-1.md"), "utf8")).toBe(projectOneBefore);
        // Moved issue landed under the fresh ID with updated frontmatter
        const movedRaw = readFileSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "issues", "issue-2.md"), "utf8");
        expect(movedRaw).toContain("Swarm bubble-up candidate");
        expect(movedRaw).toMatch(/^id: 2$/m);
        expect(movedRaw).toMatch(/^scope: project$/m);
        expect(movedRaw).toMatch(/^moved_from: swarm\/issue-1$/m);
        // Source removed from the swarm store
        expect(existsSync(join(configRoot, "knowledge", "issues", "issue-1.md"))).toBe(false);
      });

      it("keeps the source ID and omits moved_from when the target store has no collision", async () => {
        await seedIssueIn("swarm", "No collision candidate", 3);

        const result = JSON.parse(await moveHooks.tool.issue_move.execute(
          { id: 3, from_scope: "swarm", to_scope: "project" },
          { agent: "habit-builder", sessionID: "hb" }
        ));

        expect(result.error).toBeUndefined();
        expect(result.id).toBe(3);
        const movedRaw = readFileSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "issues", "issue-3.md"), "utf8");
        expect(movedRaw).toContain("No collision candidate");
        expect(movedRaw).toMatch(/^scope: project$/m);
        expect(movedRaw).not.toMatch(/^moved_from:/m);
      });
    });
  });

  // Per-store physical separation — the one deliberate exception to this
  // file's single-import convention. Store roots (CONFIG_STORE_ROOT) and the
  // legacy per-dir seams (SEAM_DIR_OVERRIDES) are module-load constants the
  // main import already captured, and the suite-level ISSUES_DIR seam
  // collapses both stores onto one temp dir. To ground-truth that
  // `issue_write`/`issue_update` route to physically distinct store dirs
  // with independent per-store ID counters, re-import the plugin fresh —
  // without the seams — and point each store root at its own temp dir.
  describe("issue tools — per-store physical separation (fresh module instance)", () => {
    let storeHooks;
    let configRoot;
    let projectRoot;

    beforeAll(async () => {
      configRoot = mkdtempSync(join(tmpdir(), "kg-config-"));
      projectRoot = mkdtempSync(join(tmpdir(), "kg-project-"));
      delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
      process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
      process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRoot;
      const fresh = await import("../../../plugins/knowledge-gate/index.js?per-store");
      storeHooks = await fresh.default.server({}, {});
    });

    afterAll(() => {
      process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      rmSync(configRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    });

    it("writes scope:swarm to the config store and scope:project to the project store, each with its own issue file", async () => {
      const base = { title: "Sep", severity: "high", created: "2026-08-16", session: "ses_sep" };
      const swarm = JSON.parse(await storeHooks.tool.issue_write.execute(
        { issue: { ...base, scope: "swarm" } },
        { agent: "habit-builder", sessionID: "hb" }
      ));
      const project = JSON.parse(await storeHooks.tool.issue_write.execute(
        { issue: { ...base, scope: "project" } },
        { agent: "habit-builder", sessionID: "hb" }
      ));
      expect(swarm.id).toBe(1);
      expect(project.id).toBe(1);
      expect(existsSync(join(configRoot, "knowledge", "issues", "issue-1.md"))).toBe(true);
      expect(existsSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "issues", "issue-1.md"))).toBe(true);
      const swarmRaw = readFileSync(join(configRoot, "knowledge", "issues", "issue-1.md"), "utf8");
      const projectRaw = readFileSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "issues", "issue-1.md"), "utf8");
      expect(swarmRaw).toContain("scope: swarm");
      expect(projectRaw).toContain("scope: project");
    });

    it("assigns IDs per store — each store's counter advances independently", async () => {
      const swarm2 = JSON.parse(await storeHooks.tool.issue_write.execute(
        { issue: { title: "Swarm 2", severity: "low", created: "2026-08-16", session: "s", scope: "swarm" } },
        { agent: "habit-builder", sessionID: "hb" }
      ));
      const project2 = JSON.parse(await storeHooks.tool.issue_write.execute(
        { issue: { title: "Project 2", severity: "low", created: "2026-08-16", session: "s", scope: "project" } },
        { agent: "habit-builder", sessionID: "hb" }
      ));
      expect(swarm2.id).toBe(2);
      expect(project2.id).toBe(2);
      expect(existsSync(join(configRoot, "knowledge", "issues", "issue-2.md"))).toBe(true);
      expect(existsSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "issues", "issue-2.md"))).toBe(true);
    });

    it("closes an issue in the project store by scope without touching the swarm copy", async () => {
      const result = JSON.parse(await storeHooks.tool.issue_update.execute(
        { id: 1, scope: "project", changes: { resolution: "Closed from the config workspace." } },
        { agent: "habit-builder", sessionID: "hb" }
      ));
      expect(result.message).toContain("updated");
      const projectRaw = readFileSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "issues", "issue-1.md"), "utf8");
      expect(projectRaw).toMatch(/status: resolved/);
      expect(projectRaw).toContain("Closed from the config workspace.");
      const swarmRaw = readFileSync(join(configRoot, "knowledge", "issues", "issue-1.md"), "utf8");
      expect(swarmRaw).toMatch(/status: open/);
    });
  });

  // Config-dir collision separation: when opencode runs from the config dir
  // itself, PROJECT_STORE_ROOT === CONFIG_STORE_ROOT and project-scope writes
  // must redirect into knowledge/projects/{name}/ so the three tiers stay
  // physically distinct. Fresh module instance without seams (PF-001).
  describe("store routing — config-dir collision redirects project scope (fresh module instance)", () => {
    let collideHooks;
    let collideFresh;
    let tempRoot;
    let configRoot;
    let otherProject;

    const memEntry = topic => ({
      source_kd: "knowledge/composed-collide.md",
      tags: ["testing", "scope"],
      topic,
      insight: "isolation probe entry",
      type: "fact",
      created: "2026-08-21T00:00:00.000Z",
      session: "ses_collide",
      version: "1.0.0"
    });

    beforeAll(async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "kg-collide-"));
      configRoot = join(tempRoot, "config");
      otherProject = join(tempRoot, "myapp");
      mkdirSync(configRoot, { recursive: true });
      mkdirSync(otherProject, { recursive: true });
      delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
      delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
      delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
      delete process.env.KNOWLEDGE_GATE_PROJECT_NAME;
      // Workspace == config root is simulated via the env seam: the
      // module-scope short-term resolver falls back to process.cwd(), which
      // under vitest is the real config dir, not this suite's temp root.
      process.env.KNOWLEDGE_GATE_PROJECT_ROOT = configRoot;
      process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
      collideFresh = await import("../../../plugins/knowledge-gate/index.js?config-collision");
      // Simulates opencode started from the config dir: workspace == config root
      collideHooks = await collideFresh.default.server({ directory: configRoot }, {});
    });

    afterAll(() => {
      process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
      process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
      process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = SHORT_TERM_DIR;
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_NAME;
      rmSync(tempRoot, { recursive: true, force: true });
    });

    it("writes project-scoped memory under knowledge/projects/{name}/memory, apart from swarm and generic", async () => {
      const r = JSON.parse(await collideHooks.tool.memory_write.execute(
        { entry: memEntry("Project tier"), scope: "project" },
        { agent: "scribe", sessionID: "s" }
      ));
      expect(r.error).toBeUndefined();
      expect(r.scope).toBe("project");
      expect(existsSync(join(configRoot, "knowledge", "projects", "config", "memory", "entry-001.json"))).toBe(true);
      // Neither canonical store received the project write
      expect(existsSync(join(configRoot, "knowledge", "memory"))).toBe(false);
      expect(existsSync(join(configRoot, "knowledge", "generic"))).toBe(false);
    });

    it("keeps swarm and generic memory in their canonical dirs alongside the projects tree", async () => {
      await collideHooks.tool.memory_write.execute(
        { entry: memEntry("Swarm tier"), scope: "swarm" },
        { agent: "scribe", sessionID: "s" }
      );
      await collideHooks.tool.memory_write.execute(
        { entry: memEntry("Generic tier"), scope: "generic" },
        { agent: "scribe", sessionID: "s" }
      );
      expect(existsSync(join(configRoot, "knowledge", "memory", "entry-001.json"))).toBe(true);
      expect(existsSync(join(configRoot, "knowledge", "generic", "memory", "entry-001.json"))).toBe(true);
      expect(existsSync(join(configRoot, "knowledge", "projects", "config", "memory", "entry-001.json"))).toBe(true);
    });

    it("routes issue writes to three distinct issues dirs with independent per-store IDs", async () => {
      const base = { title: "Collide", severity: "high", created: "2026-08-21", session: "ses_collide" };
      for (const scope of ["project", "swarm", "generic"]) {
        const r = JSON.parse(await collideHooks.tool.issue_write.execute(
          { issue: { ...base, scope } },
          { agent: "habit-builder", sessionID: "hb" }
        ));
        expect(r.id).toBe(1);
      }
      const projRaw = readFileSync(join(configRoot, "knowledge", "projects", "config", "issues", "issue-1.md"), "utf8");
      const swarmRaw = readFileSync(join(configRoot, "knowledge", "issues", "issue-1.md"), "utf8");
      const genericRaw = readFileSync(join(configRoot, "knowledge", "generic", "issues", "issue-1.md"), "utf8");
      expect(projRaw).toContain("scope: project");
      expect(swarmRaw).toContain("scope: swarm");
      expect(genericRaw).toContain("scope: generic");
    });

    it("surfaces open issues from all three physical stores with scope tags", async () => {
      const merged = collideHooks.scanOpenIssuesMerged();
      const scopes = merged.map(i => i.scope).sort();
      expect(scopes).toEqual(["generic", "project", "swarm"]);
    });

    it("routes short-term notes to per-store short-term directories", async () => {
      const note = { topic: "Scratch", content: "collision probe note" };
      for (const scope of ["project", "swarm", "generic"]) {
        const r = JSON.parse(await collideHooks.tool.memory_note.execute(
          { ...note, scope },
          { agent: "artisan", sessionID: "ses_collide" }
        ));
        expect(r.error).toBeUndefined();
      }
      expect(existsSync(join(configRoot, "knowledge", "projects", "config", "short-term", "ses_collide", "artisan"))).toBe(true);
      expect(existsSync(join(configRoot, "knowledge", "short-term", "ses_collide", "artisan"))).toBe(true);
      expect(existsSync(join(configRoot, "knowledge", "generic", "short-term", "ses_collide", "artisan"))).toBe(true);
    });

    it("keeps project data in a non-config workspace when the directory differs from the config root", async () => {
      // Env seam would override input.directory — remove it so this server
      // resolves its workspace from the directory argument alone.
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      const otherHooks = await collideFresh.default.server({ directory: otherProject }, {});
      const r = JSON.parse(await otherHooks.tool.memory_write.execute(
        { entry: memEntry("Other project tier"), scope: "project" },
        { agent: "scribe", sessionID: "s" }
      ));
      expect(r.error).toBeUndefined();
      // Project data centralizes under the config root regardless of workspace
      expect(existsSync(join(configRoot, "knowledge", "projects", "myapp", "memory", "entry-001.json"))).toBe(true);
      // The workspace tree itself stays free of knowledge data
      expect(existsSync(join(otherProject, "knowledge"))).toBe(false);
    });

    it("honors KNOWLEDGE_GATE_PROJECT_NAME for the collision namespace", async () => {
      process.env.KNOWLEDGE_GATE_PROJECT_NAME = "swarm-workbench";
      const namedHooks = await collideFresh.default.server({ directory: configRoot }, {});
      const r = JSON.parse(await namedHooks.tool.memory_write.execute(
        { entry: memEntry("Named project tier"), scope: "project" },
        { agent: "scribe", sessionID: "s" }
      ));
      expect(r.error).toBeUndefined();
      expect(existsSync(join(configRoot, "knowledge", "projects", "swarm-workbench", "memory"))).toBe(true);
      delete process.env.KNOWLEDGE_GATE_PROJECT_NAME;
    });
  });

  // project_name override — memory_write and issue_move accept an
  // explicit project subfolder name that overrides the workspace basename.
  // Fresh module instance without seams so the centralized project store
  // path is observable on disk.
  describe("project_name override — centralized project stores (fresh module instance)", () => {
    let nameHooks;
    let configRoot;
    let projectRoot;

    beforeAll(async () => {
      configRoot = mkdtempSync(join(tmpdir(), "kg-name-config-"));
      projectRoot = mkdtempSync(join(tmpdir(), "kg-name-project-"));
      delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
      delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
      delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
      delete process.env.KNOWLEDGE_GATE_PROJECT_NAME;
      process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
      process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRoot;
      const fresh = await import("../../../plugins/knowledge-gate/index.js?project-name");
      nameHooks = await fresh.default.server({ directory: projectRoot }, {});
    });

    afterAll(() => {
      process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
      process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
      process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = SHORT_TERM_DIR;
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_NAME;
      rmSync(configRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    });

    it("memory_write routes project-scope entries under the project_name subfolder", async () => {
      const result = JSON.parse(await nameHooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-name.md",
          tags: ["testing", "scope"],
          topic: "Named project entry",
          insight: "Lands under the explicit project name",
          type: "fact",
          created: "2026-08-24T00:00:00.000Z",
          session: "ses_name",
          version: "1.0.0"
        },
        scope: "project",
        project_name: "rt-lstm"
      }, { agent: "scribe", sessionID: "s" }));

      expect(result.error).toBeUndefined();
      expect(result.scope).toBe("project");
      expect(existsSync(join(configRoot, "knowledge", "projects", "rt-lstm", "memory", "entry-001.json"))).toBe(true);
      // The workspace basename namespace was NOT used
      expect(existsSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "memory"))).toBe(false);
    });

    it("issue_move routes the target copy under the project_name subfolder", async () => {
      const seeded = JSON.parse(await nameHooks.tool.issue_write.execute(
        { issue: { title: "Move me", severity: "medium", created: "2026-08-24", session: "ses_name", scope: "swarm" } },
        { agent: "habit-builder", sessionID: "hb" }
      ));
      expect(seeded.id).toBe(1);

      const result = JSON.parse(await nameHooks.tool.issue_move.execute(
        { id: 1, from_scope: "swarm", to_scope: "project", project_name: "rt-lstm", reason: "belongs to rt-lstm" },
        { agent: "habit-builder", sessionID: "hb" }
      ));

      expect(result.error).toBeUndefined();
      expect(result.id).toBe(1);
      const movedRaw = readFileSync(join(configRoot, "knowledge", "projects", "rt-lstm", "issues", "issue-1.md"), "utf8");
      expect(movedRaw).toContain("Move me");
      expect(movedRaw).toMatch(/^scope: project$/m);
      // Source removed from the swarm store
      expect(existsSync(join(configRoot, "knowledge", "issues", "issue-1.md"))).toBe(false);
    });

    it("rejects an invalid project_name with a path-separator error", async () => {
      const result = JSON.parse(await nameHooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-name.md",
          tags: ["testing", "scope"],
          topic: "Bad name",
          insight: "Rejected before any write",
          type: "fact",
          created: "2026-08-24T00:00:00.000Z",
          session: "ses_name",
          version: "1.0.0"
        },
        scope: "project",
        project_name: "../escape"
      }, { agent: "scribe", sessionID: "s" }));

      expect(result.error).toContain("project_name must be a non-empty string without path separators");
      expect(existsSync(join(configRoot, "knowledge", "projects", "escape", "memory"))).toBe(false);
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

  describe("memory search index (derived, rebuildable)", () => {
    // The index (memory-search-index.jsonl) is a derived, rebuildable
    // projection of the entry files — never the source of truth. Its name
    // must NOT end in ".json" and must NOT start with "entry-" so every
    // existing filter/count assertion stays intact. All file
    // expectations are verified from disk under the temp MEMORY_DIR seam.

    it("creates a compliant index on memory_write and leaves the entry unmodified", async () => {
      const entry = { id: "MEM-020", type: "fact", source_kd: "knowledge/test.md", tags: ["test", "sample"], topic: "Test topic", insight: "Test insight for index write.", created: "2026-07-29T00:00:00.000Z", session: "ses_test", version: "1.0.0" };
      const result = await hooks.tool.memory_write.execute({ entry, scope: "swarm" }, { agent: "scribe", sessionID: "scribe-session" });
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

      // Version mismatch (version: 2) → invalid → rebuild
      writeFileSync(join(MEMORY_DIR, "memory-search-index.jsonl"), JSON.stringify({ version: 2, updated: new Date().toISOString(), entryCount: 1, entries: [] }), "utf8");
      const r1 = await hooks.tool.memory_search.execute({ tags: ["auth"] }, { agent: "artisan", sessionID: "s" });
      expect(JSON.parse(r1).map(e => e.id)).toEqual(["MEM-001"]);

      // Count mismatch (entryCount 5 but 1 entry on disk) + external change
      // forces a cache miss → invalid → rebuild
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
      expect(parsed[0]).toEqual({ id: "MEM-003", source_kd: "knowledge/composed-test-3.md", tags: ["auth", "testing"], topic: "Auth refresh tokens", insight: "This is test insight 3 for verification purposes.", store: "swarm" });

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
      // namespace — the boundary is structural.
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
      // short-term store (notes never surface in memory_search).
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

  // F-002: promoted IDs must follow the TARGET store's sequence. The old
  // code assigned via module-scope getNextMemoryId(), which scans only the
  // swarm MEMORY_DIR — non-swarm promotions diverged from the target
  // sequence and could silently overwrite an existing target entry when
  // swarm-max+1 ≤ target-max. Fresh module instance without seams
  // for physically distinct per-store dirs.
  describe("promotion ID assignment — per-store sequence (fresh module instance)", () => {
    let promoHooks;
    let tempRoot;
    let configRoot;
    let projectRoot;
    let swarmMemoryDir;
    let projectMemoryDir;

    function seedEntry(dir, num, topic) {
      writeFileSync(join(dir, `entry-${String(num).padStart(3, "0")}.json`), JSON.stringify({
        id: `MEM-${String(num).padStart(3, "0")}`,
        type: "fact",
        source_kd: "knowledge/composed-seed.md",
        tags: ["testing", "scope"],
        topic,
        insight: `Seed insight ${num}.`,
        created: "2026-08-21T00:00:00.000Z",
        session: "ses_seed",
        version: "1.0.0",
        scope: "project"
      }), "utf8");
    }

    function maxEntryNum(dir) {
      return readdirSync(dir)
        .map(f => f.match(/^entry-(\d+)\.json$/))
        .filter(Boolean)
        .reduce((max, m) => Math.max(max, parseInt(m[1], 10)), 0);
    }

    beforeAll(async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "kg-promo-ids-"));
      configRoot = join(tempRoot, "config");
      projectRoot = join(tempRoot, "app");
      mkdirSync(configRoot, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
      delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
      delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
      process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
      process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRoot;
      const fresh = await import("../../../plugins/knowledge-gate/index.js?promo-ids");
      promoHooks = await fresh.default.server({ directory: projectRoot }, {});
      swarmMemoryDir = join(configRoot, "knowledge", "memory");
      projectMemoryDir = join(configRoot, "knowledge", "projects", basename(projectRoot), "memory");
    });

    afterAll(() => {
      process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
      process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
      process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = SHORT_TERM_DIR;
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      rmSync(tempRoot, { recursive: true, force: true });
    });

    it("assigns promoted IDs from the target store's sequence, not the swarm store's", async () => {
      // Swarm store holds entries 1-5; project store is empty.
      mkdirSync(swarmMemoryDir, { recursive: true });
      for (let n = 1; n <= 5; n++) seedEntry(swarmMemoryDir, n, `Swarm seed ${n}`);
      await promoHooks.tool.memory_note.execute(
        { topic: "Project insight", content: "A project-specific insight worth keeping.", scope: "project" },
        { agent: "artisan", sessionID: "promo-ids" }
      );

      const result = promoHooks.promoteShortTermNotes("promo-ids", "knowledge/composed-promo.md", { scope: "project" });

      expect(result.promoted).toHaveLength(1);
      // Buggy behavior assigned MEM-006 (swarm-max+1); correct is MEM-001
      expect(result.promoted[0].entryId).toBe("MEM-001");
      const entry = JSON.parse(readFileSync(join(projectMemoryDir, "entry-001.json"), "utf8"));
      expect(entry.topic).toBe("Project insight");
      expect(entry.scope).toBe("project");
    });

    it("never overwrites an existing target-store entry when sequences overlap", async () => {
      // Project holds entries 1-3 while swarm holds only entry 1 — the buggy
      // swarm-scan would assign MEM-002 and clobber project entry-002.
      mkdirSync(swarmMemoryDir, { recursive: true });
      mkdirSync(projectMemoryDir, { recursive: true });
      seedEntry(swarmMemoryDir, 1, "Lone swarm seed");
      seedEntry(projectMemoryDir, 1, "Project seed one");
      seedEntry(projectMemoryDir, 2, "Project seed two");
      seedEntry(projectMemoryDir, 3, "Project seed three");
      const twoBefore = readFileSync(join(projectMemoryDir, "entry-002.json"), "utf8");
      await promoHooks.tool.memory_note.execute(
        { topic: "Overlapping insight", content: "Insight promoted into an overlapping store.", scope: "project" },
        { agent: "artisan", sessionID: "promo-overlap" }
      );

      const result = promoHooks.promoteShortTermNotes("promo-overlap", "knowledge/composed-promo.md", { scope: "project" });

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0].entryId).toBe("MEM-004");
      expect(readFileSync(join(projectMemoryDir, "entry-002.json"), "utf8")).toBe(twoBefore);
      expect(JSON.parse(readFileSync(join(projectMemoryDir, "entry-004.json"), "utf8")).topic).toBe("Overlapping insight");
    });

    it("assigns distinct sequential IDs when promoting multiple notes in one run", async () => {
      mkdirSync(projectMemoryDir, { recursive: true });
      const base = maxEntryNum(projectMemoryDir);
      await promoHooks.tool.memory_note.execute({ topic: "First keep", content: "Keep one.", scope: "project" }, { agent: "artisan", sessionID: "promo-multi" });
      await promoHooks.tool.memory_note.execute({ topic: "Second keep", content: "Keep two.", scope: "project" }, { agent: "scribe", sessionID: "promo-multi" });

      const result = promoHooks.promoteShortTermNotes("promo-multi", "knowledge/composed-promo.md", { scope: "project" });

      const pad = n => `MEM-${String(n).padStart(3, "0")}`;
      expect(result.promoted.map(p => p.entryId)).toEqual([pad(base + 1), pad(base + 2)]);
      expect(maxEntryNum(projectMemoryDir)).toBe(base + 2);
    });
  });

  // --- Memory scope support + per-store index ---
  describe("Memory scope support", () => {
    // These tests use the existing seam setup. The legacy memory seam overrides
    // both stores to the same dir, so we test scope routing via return values
    // and the store field on search results — the physical dual-store
    // routing evidence lives in the disjoint-root suites below
    // ("dual-instance physical isolation", "store dir resolution").

    it("memory_write returns scope in the result", async () => {
      const result = JSON.parse(await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-test.md",
          tags: ["test", "scope"],
          topic: "Scope result test",
          insight: "Returns scope in result",
          type: "fact",
          created: "2026-08-16T00:00:00.000Z",
          session: "ses_m3_scope",
          version: "1.0.0"
        },
        scope: "project"
      }, { agent: "scribe", sessionID: "s" }));

      expect(result.error).toBeUndefined();
      expect(result.scope).toBe("project");
      expect(result.id).toMatch(/^MEM-\d{3}$/);
    });

    it("memory_write returns scope: swarm for explicit swarm scope", async () => {
      const result = JSON.parse(await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-test.md",
          tags: ["test", "scope"],
          topic: "Swarm scope result",
          insight: "Returns swarm scope",
          type: "fact",
          created: "2026-08-16T00:00:00.000Z",
          session: "ses_m3_scope",
          version: "1.0.0"
        },
        scope: "swarm"
      }, { agent: "scribe", sessionID: "s" }));

      expect(result.error).toBeUndefined();
      expect(result.scope).toBe("swarm");
    });

    it("rejects memory_write when scope is omitted — Scribe must classify explicitly", async () => {
      const result = JSON.parse(await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-test.md",
          tags: ["test", "required"],
          topic: "Required scope",
          insight: "Scope is required",
          type: "fact",
          created: "2026-08-16T00:00:00.000Z",
          session: "ses_m3_required",
          version: "1.0.0"
        }
      }, { agent: "scribe", sessionID: "s" }));

      expect(result.error).toContain("scope is required");
      expect(readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"))).toHaveLength(0);
    });

    it("memory_update returns scope in the result", async () => {
      // Write an entry first
      const writeResult = JSON.parse(await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-test.md",
          tags: ["test", "update"],
          topic: "Update scope test",
          insight: "Original",
          type: "fact",
          created: "2026-08-16T00:00:00.000Z",
          session: "ses_m3_update",
          version: "1.0.0"
        },
        scope: "swarm"
      }, { agent: "scribe", sessionID: "s" }));

      // Update without scope — should find it and return scope
      const updateResult = JSON.parse(await hooks.tool.memory_update.execute({
        id: writeResult.id,
        entry: { insight: "Updated" }
      }, { agent: "scribe", sessionID: "s" }));

      expect(updateResult.error).toBeUndefined();
      expect(updateResult.scope).toBeDefined();
      expect(["project", "swarm"]).toContain(updateResult.scope);
    });

    it("memory_delete returns scope in the result", async () => {
      const writeResult = JSON.parse(await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-test.md",
          tags: ["test", "delete"],
          topic: "Delete scope test",
          insight: "To delete",
          type: "fact",
          created: "2026-08-16T00:00:00.000Z",
          session: "ses_m3_delete",
          version: "1.0.0"
        },
        scope: "swarm"
      }, { agent: "scribe", sessionID: "s" }));

      const deleteResult = JSON.parse(await hooks.tool.memory_delete.execute({
        id: writeResult.id
      }, { agent: "scribe", sessionID: "s" }));

      expect(deleteResult.error).toBeUndefined();
      expect(deleteResult.scope).toBeDefined();
      expect(["project", "swarm"]).toContain(deleteResult.scope);
    });

    it("resolveMemoryScope returns explicit scope when provided", () => {
      expect(hooks.resolveMemoryScope("project")).toBe("project");
      expect(hooks.resolveMemoryScope("generic")).toBe("generic");
      expect(hooks.resolveMemoryScope("swarm")).toBe("swarm");
    });

    it("resolveMemoryScope returns null when no explicit scope is provided", () => {
      expect(hooks.resolveMemoryScope(undefined)).toBeNull();
      expect(hooks.resolveMemoryScope(null)).toBeNull();
      expect(hooks.resolveMemoryScope("")).toBeNull();
      expect(hooks.resolveMemoryScope("other")).toBeNull();
    });

    it("resolveMemoryScope ignores source-KD frontmatter scope — no inference", async () => {
      // A source KD carrying scope: project must NOT influence resolution
      const sourceKd = join(MEMORY_DIR, "..", "composed-scope-test.md");
      writeFileSync(sourceKd, "---\nscope: project\ntitle: Test\n---\nBody\n", "utf8");
      expect(hooks.resolveMemoryScope(undefined, sourceKd)).toBeNull();
      expect(hooks.resolveMemoryScope("swarm", sourceKd)).toBe("swarm");
      rmSync(sourceKd, { force: true });
    });
  });

  describe("Per-store memory index", () => {
    it("memory_search results carry store field", async () => {
      // Write entries to both stores (under the seam, both go to the same dir)
      await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-1.md",
          tags: ["test", "storefield"],
          topic: "Store field A",
          insight: "Entry A",
          type: "fact",
          created: "2026-08-16T00:00:00.000Z",
          session: "ses_m3_field",
          version: "1.0.0"
        },
        scope: "swarm"
      }, { agent: "scribe", sessionID: "s" });

      await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-2.md",
          tags: ["test", "storefield"],
          topic: "Store field B",
          insight: "Entry B",
          type: "fact",
          created: "2026-08-16T01:00:00.000Z",
          session: "ses_m3_field",
          version: "1.0.0"
        },
        scope: "project"
      }, { agent: "scribe", sessionID: "s" });

      const results = hooks.searchMemory({ tags: ["test", "storefield"], limit: 10 });
      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const r of results) {
        expect(r.store).toBeDefined();
        expect(["project", "generic", "swarm"]).toContain(r.store);
      }
    });

    it("memory_search store filter restricts to one store", async () => {
      await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-1.md",
          tags: ["test", "filter"],
          topic: "Filter swarm",
          insight: "Swarm only",
          type: "fact",
          created: "2026-08-16T00:00:00.000Z",
          session: "ses_m3_filter",
          version: "1.0.0"
        },
        scope: "swarm"
      }, { agent: "scribe", sessionID: "s" });

      await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-2.md",
          tags: ["test", "filter"],
          topic: "Filter project",
          insight: "Project only",
          type: "fact",
          created: "2026-08-16T01:00:00.000Z",
          session: "ses_m3_filter",
          version: "1.0.0"
        },
        scope: "project"
      }, { agent: "scribe", sessionID: "s" });

      // Search only project store — dedup means we get the project-tagged entry
      const projectResults = hooks.searchMemory({ tags: ["test", "filter"], limit: 10, store: "project" });
      expect(projectResults.length).toBeGreaterThanOrEqual(1);
      expect(projectResults.every(r => r.store === "project")).toBe(true);

      // Search only swarm store
      const swarmResults = hooks.searchMemory({ tags: ["test", "filter"], limit: 10, store: "swarm" });
      expect(swarmResults.length).toBeGreaterThanOrEqual(1);
      expect(swarmResults.every(r => r.store === "swarm")).toBe(true);
    });

    it("memory_search store filter accepts the generic store", async () => {
      await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-generic.md",
          tags: ["test", "genericfilter"],
          topic: "Generic filter target",
          insight: "Generic only",
          type: "fact",
          created: "2026-08-16T02:00:00.000Z",
          session: "ses_m4_generic",
          version: "1.0.0"
        },
        scope: "generic"
      }, { agent: "scribe", sessionID: "s" });

      const genericResults = hooks.searchMemory({ tags: ["test", "genericfilter"], limit: 10, store: "generic" });
      expect(genericResults.length).toBeGreaterThanOrEqual(1);
      expect(genericResults.every(r => r.store === "generic")).toBe(true);
    });

    it("memory_search merges all stores by default with store field", async () => {
      await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-1.md",
          tags: ["test", "merge"],
          topic: "Merge swarm entry",
          insight: "Swarm merge",
          type: "fact",
          created: "2026-08-16T00:00:00.000Z",
          session: "ses_m3_merge",
          version: "1.0.0"
        },
        scope: "swarm"
      }, { agent: "scribe", sessionID: "s" });

      await hooks.tool.memory_write.execute({
        entry: {
          source_kd: "knowledge/composed-2.md",
          tags: ["test", "merge"],
          topic: "Merge project entry",
          insight: "Project merge",
          type: "fact",
          created: "2026-08-16T01:00:00.000Z",
          session: "ses_m3_merge",
          version: "1.0.0"
        },
        scope: "project"
      }, { agent: "scribe", sessionID: "s" });

      // Default search merges all stores
      const results = hooks.searchMemory({ tags: ["test", "merge"], limit: 10 });
      expect(results.length).toBeGreaterThanOrEqual(2);
      // Every result has a store field
      for (const r of results) {
        expect(["project", "generic", "swarm"]).toContain(r.store);
      }
    });

    it("per-store caches are isolated objects", () => {
      const caches = hooks.perStoreCaches;
      expect(caches).toBeDefined();
      expect(caches.swarm).toBeDefined();
      expect(caches.project).toBeDefined();
      expect(caches.swarm).not.toBe(caches.project);
    });

    it("generic store has its own isolated cache", () => {
      const caches = hooks.perStoreCaches;
      // Without a dedicated generic cache, generic searches would share (and
      // thrash) the swarm cache — the fallback in getCacheForScope.
      expect(caches.generic).toBeDefined();
      expect(caches.generic).not.toBe(caches.swarm);
      expect(caches.generic).not.toBe(caches.project);
    });

    it("memoryDirForScope resolves to correct paths", () => {
      const swarmDir = hooks.memoryDirForScope("swarm");
      const projectDir = hooks.memoryDirForScope("project");
      expect(swarmDir).toBeDefined();
      expect(projectDir).toBeDefined();
      // Under the seam, both resolve to the same dir
      // (the seam overrides both stores)
      expect(swarmDir).toBe(MEMORY_DIR);
    });

    it("memoryIndexPathForScope returns per-store index paths", () => {
      const swarmIdx = hooks.memoryIndexPathForScope("swarm");
      const projectIdx = hooks.memoryIndexPathForScope("project");
      expect(swarmIdx).toContain("memory-search-index.jsonl");
      expect(projectIdx).toContain("memory-search-index.jsonl");
      // Under the seam, both resolve to the same path
      expect(swarmIdx).toBe(projectIdx);
    });
  });

  // Memory-index absent-store hygiene: a merged search
  // touches every store, so never-written project/generic stores used to
  // hit an ENOENT on the index write and log "memory index: write failed"
  // per search. The fix skips the write for absent store dirs; these tests
  // pin the diagnostic silence plus the stronger hygiene invariant that
  // merged searches create zero directories under absent store roots.
  describe("memory index — absent-store hygiene (fresh module instance)", () => {
    let hygieneModule;
    let hygieneHooks;
    let configRoot;
    let projectRoot;

    // Runs fn with the plugin's debug channel enabled and returns the log
    // text appended during the call — the only diagnostics surface the
    // plugin has, so "zero error-level output" is asserted against it.
    function captureDebugLog(fn) {
      process.env.KNOWLEDGE_GATE_DEBUG = "1";
      const before = existsSync(KG_LOG_FILE) ? readFileSync(KG_LOG_FILE, "utf8") : "";
      let result, appended;
      try {
        result = fn();
        const after = existsSync(KG_LOG_FILE) ? readFileSync(KG_LOG_FILE, "utf8") : "";
        appended = after.slice(before.length);
      } finally {
        delete process.env.KNOWLEDGE_GATE_DEBUG;
      }
      return { result, appended };
    }

    beforeAll(async () => {
      configRoot = mkdtempSync(join(tmpdir(), "kg-hygiene-config-"));
      projectRoot = mkdtempSync(join(tmpdir(), "kg-hygiene-project-"));
      // Disjoint roots without seams: the seam overrides collapse all three
      // stores onto one dir, which makes an "absent store" unconstructible.
      delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
      delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
      delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
      process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
      process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRoot;
      hygieneModule = await import("../../../plugins/knowledge-gate/index.js?index-hygiene");
      hygieneHooks = await hygieneModule.default.server({}, {});
    });

    afterAll(() => {
      process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
      process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
      process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = SHORT_TERM_DIR;
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      rmSync(configRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    });

    it("merged search over absent stores completes, serves swarm results, and leaves both roots untouched", () => {
      const swarmDir = join(configRoot, "knowledge", "memory");
      mkdirSync(swarmDir, { recursive: true });
      const entry = addMemoryEntry(1, { tags: ["hygiene-probe"], topic: "Absent-store probe" });
      writeFileSync(join(swarmDir, entry.fileName), entry.content);

      const { result: results, appended } = captureDebugLog(() =>
        hygieneHooks.searchMemory({ tags: [], topic: "", limit: 5 })
      );

      expect(results).toHaveLength(1);
      expect(results[0].store).toBe("swarm");
      expect(results[0].topic).toBe("Absent-store probe");

      // Zero error-level index diagnostics for never-written stores
      expect(appended).not.toContain("memory index: write failed");
      expect(appended).not.toContain("memory index: rebuild write failed");

      // Merged searches create no directories under absent roots
      expect(existsSync(join(configRoot, "knowledge", "projects", basename(projectRoot), "memory"))).toBe(false);
      expect(existsSync(join(configRoot, "knowledge", "generic"))).toBe(false);

      // Failure isolation leaves zero tmp residue behind
      const residue = readdirSync(swarmDir).filter(f => f.endsWith(".tmp"));
      expect(residue).toEqual([]);
    });

    it("store-filtered search on an absent store returns empty and emits zero failure diagnostics", () => {
      const { result: results, appended } = captureDebugLog(() =>
        hygieneHooks.searchMemory({ tags: [], topic: "", limit: 5, store: "generic" })
      );

      expect(results).toEqual([]);
      expect(appended).not.toContain("memory index: write failed");
      expect(existsSync(join(configRoot, "knowledge", "generic"))).toBe(false);
    });

    it("present store materializes the index post-search and serves subsequent searches from it", async () => {
      const swarmDir = join(configRoot, "knowledge", "memory");
      mkdirSync(swarmDir, { recursive: true });
      const entry = addMemoryEntry(2, { tags: ["regression-probe"], topic: "Index regression probe" });
      writeFileSync(join(swarmDir, entry.fileName), entry.content);

      const first = hygieneHooks.searchMemory({ tags: ["regression-probe"], topic: "", limit: 5 });
      expect(first).toHaveLength(1);

      const indexPath = join(swarmDir, "memory-search-index.jsonl");
      expect(existsSync(indexPath)).toBe(true);
      const doc = JSON.parse(readFileSync(indexPath, "utf8"));
      expect(doc.version).toBe(1);
      // entryCount mirrors the on-disk entry-file count — the same invariant
      // isMemoryIndexValid enforces before serving from the index.
      const fileCount = readdirSync(swarmDir).filter(f => f.endsWith(".json")).length;
      expect(doc.entryCount).toBe(fileCount);

      // Prove the serve-from-index path: a fresh server instance (empty
      // caches) reads a tweaked index — the unchanged entryCount keeps it
      // valid, so the altered topic flows through to results.
      const tweaked = JSON.parse(readFileSync(indexPath, "utf8"));
      const target = tweaked.entries.find(e => e.id === JSON.parse(entry.content).id);
      target.topic = "Served from index";
      writeFileSync(indexPath, JSON.stringify(tweaked));
      const freshHooks = await hygieneModule.default.server({}, {});
      const second = freshHooks.searchMemory({ tags: ["regression-probe"], topic: "", limit: 5 });
      expect(second).toHaveLength(1);
      expect(second[0].topic).toBe("Served from index");
    });
  });

  // Dual-instance physical isolation (#68): earlier isolation evidence in
  // this file rested on single instances — either the seam collapse (all
  // stores on one dir) or one instance with disjoint roots. This harness
  // grounds the strongest claim, zero cross-instance visibility, by keeping
  // two fresh module instances alive in one process, each bound to its own
  // config/project root pair. A write in one instance stays invisible to the
  // other across memory search, open-issue scans, and short-term reads, in
  // both directions. Project-scope short-term writes stay out of scope here:
  // that path reads KNOWLEDGE_GATE_PROJECT_ROOT at call time and would fall
  // back to process.cwd() once the env roots are cleared below.
  describe("dual-instance physical isolation (two fresh module instances)", () => {
    let instanceA;
    let instanceB;
    let hooksA;
    let hooksB;
    let configRootA;
    let projectRootA;
    let configRootB;
    let projectRootB;

    const scribe = { agent: "scribe", sessionID: "ses_iso" };
    const builder = { agent: "habit-builder", sessionID: "ses_iso" };

    function memEntry(topic, tags) {
      return {
        source_kd: "knowledge/composed-iso.md",
        tags: [...tags, "isolation"],
        topic,
        insight: `${topic} isolation probe`,
        type: "fact",
        created: "2026-08-23T00:00:00.000Z",
        session: "ses_iso",
        version: "1.0.0"
      };
    }

    function issue(title) {
      return { title, severity: "high", created: "2026-08-23", session: "ses_iso", scope: "swarm" };
    }

    beforeAll(async () => {
      configRootA = mkdtempSync(join(tmpdir(), "kg-iso-config-a-"));
      projectRootA = mkdtempSync(join(tmpdir(), "kg-iso-project-a-"));
      configRootB = mkdtempSync(join(tmpdir(), "kg-iso-config-b-"));
      projectRootB = mkdtempSync(join(tmpdir(), "kg-iso-project-b-"));
      // Disjoint roots need seam-free modules: the overrides would collapse
      // all stores onto one dir and make cross-instance leakage unobservable.
      delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
      delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
      delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
      process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRootA;
      process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRootA;
      instanceA = await import("../../../plugins/knowledge-gate/index.js?iso-a");
      hooksA = await instanceA.default.server({ directory: projectRootA }, {});
      process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRootB;
      process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRootB;
      instanceB = await import("../../../plugins/knowledge-gate/index.js?iso-b");
      hooksB = await instanceB.default.server({ directory: projectRootB }, {});
      // Roots are baked into each instance's module constants and server
      // closures by now; clearing the env keeps call-time readers away from
      // either instance's tree for the rest of the suite.
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
    });

    afterAll(() => {
      process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
      process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
      process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = SHORT_TERM_DIR;
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      for (const dir of [configRootA, projectRootA, configRootB, projectRootB]) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("hides memory writes from the sibling instance's merged search in both directions", async () => {
      const alpha = JSON.parse(await hooksA.tool.memory_write.execute(
        { entry: memEntry("Alpha-only insight", ["iso-probe"]), scope: "swarm" },
        scribe
      ));
      const beta = JSON.parse(await hooksB.tool.memory_write.execute(
        { entry: memEntry("Beta-only insight", ["iso-probe"]), scope: "swarm" },
        scribe
      ));
      expect(alpha.error).toBeUndefined();
      expect(beta.error).toBeUndefined();

      const seenFromA = hooksA.searchMemory({ tags: ["iso-probe"], topic: "", limit: 10 });
      expect(seenFromA.map(r => r.topic)).toEqual(["Alpha-only insight"]);
      const seenFromB = hooksB.searchMemory({ tags: ["iso-probe"], topic: "", limit: 10 });
      expect(seenFromB.map(r => r.topic)).toEqual(["Beta-only insight"]);

      // Both instances start from empty stores, so the shared per-store ID
      // sequence hands out the same ID while the entries land as physically
      // distinct files under disjoint roots.
      expect(alpha.id).toBe(beta.id);
      expect(existsSync(join(configRootA, "knowledge", "memory", "entry-001.json"))).toBe(true);
      expect(existsSync(join(configRootB, "knowledge", "memory", "entry-001.json"))).toBe(true);
    });

    it("hides issue writes from the sibling instance's merged open-issue scan in both directions", async () => {
      await hooksA.tool.issue_write.execute({ issue: issue("Alpha open debt") }, builder);
      await hooksB.tool.issue_write.execute({ issue: issue("Beta open debt") }, builder);

      expect(hooksA.scanOpenIssuesMerged().map(i => i.title)).toEqual(["Alpha open debt"]);
      expect(hooksB.scanOpenIssuesMerged().map(i => i.title)).toEqual(["Beta open debt"]);

      // Each config root holds its own first issue file — independent per-store
      // counters over physically separate dirs.
      expect(existsSync(join(configRootA, "knowledge", "issues", "issue-1.md"))).toBe(true);
      expect(existsSync(join(configRootB, "knowledge", "issues", "issue-1.md"))).toBe(true);
    });

    it("keeps short-term notes unreadable through the sibling instance", async () => {
      const noteA = JSON.parse(await hooksA.tool.memory_note.execute(
        { topic: "Alpha scratch", content: "instance A scratch note" },
        { agent: "artisan", sessionID: "ses_iso_a" }
      ));
      const noteB = JSON.parse(await hooksB.tool.memory_note.execute(
        { topic: "Beta scratch", content: "instance B scratch note" },
        { agent: "artisan", sessionID: "ses_iso_b" }
      ));
      expect(noteA.error).toBeUndefined();
      expect(noteB.error).toBeUndefined();

      // Distinct session tokens keep note IDs distinct, so reading the
      // sibling's ID resolves inside the reader's own store and misses.
      const readAinB = JSON.parse(await hooksB.tool.memory_note_read.execute(
        { id: noteA.id },
        { agent: "artisan", sessionID: "ses_iso_b" }
      ));
      expect(readAinB.error).toContain("not found");
      const readBinA = JSON.parse(await hooksA.tool.memory_note_read.execute(
        { id: noteB.id },
        { agent: "artisan", sessionID: "ses_iso_a" }
      ));
      expect(readBinA.error).toContain("not found");

      // Each instance still reads its own note by ID.
      const ownA = JSON.parse(await hooksA.tool.memory_note_read.execute(
        { id: noteA.id },
        { agent: "artisan", sessionID: "ses_iso_a" }
      ));
      expect(ownA.topic).toBe("Alpha scratch");
      const ownB = JSON.parse(await hooksB.tool.memory_note_read.execute(
        { id: noteB.id },
        { agent: "artisan", sessionID: "ses_iso_b" }
      ));
      expect(ownB.topic).toBe("Beta scratch");

      // Namespace listing (Scribe view) surfaces only local notes.
      const listA = JSON.parse(await hooksA.tool.memory_notes_list.execute(
        { session: "ses_iso_a", agent: "artisan" },
        scribe
      ));
      expect(listA.map(n => n.topic)).toEqual(["Alpha scratch"]);
      const listB = JSON.parse(await hooksB.tool.memory_notes_list.execute(
        { session: "ses_iso_b", agent: "artisan" },
        scribe
      ));
      expect(listB.map(n => n.topic)).toEqual(["Beta scratch"]);
    });

    it("routes project-scope writes into each instance's own project root with zero cross-visibility", async () => {
      await hooksA.tool.memory_write.execute(
        { entry: memEntry("Alpha project insight", ["iso-project"]), scope: "project" },
        scribe
      );
      await hooksB.tool.issue_write.execute(
        { issue: { ...issue("Beta project debt"), scope: "project" } },
        builder
      );

      expect(existsSync(join(configRootA, "knowledge", "projects", basename(projectRootA), "memory", "entry-001.json"))).toBe(true);
      expect(existsSync(join(configRootB, "knowledge", "projects", basename(projectRootB), "issues", "issue-1.md"))).toBe(true);
      // Nothing bled into the sibling's project tree
      expect(existsSync(join(configRootB, "knowledge", "projects", basename(projectRootA), "memory"))).toBe(false);
      expect(existsSync(join(configRootA, "knowledge", "projects", basename(projectRootB), "issues"))).toBe(false);

      // Positive control goes through the store-filtered surface: A's
      // project entry shares the ID MEM-001 with A's earlier swarm entry
      // (per-store ID sequences), and the merged path dedupes same-ID
      // entries with swarm precedence — the filtered read proves the
      // project store itself holds and serves the entry.
      const seenFromA = hooksA.searchMemory({ tags: ["iso-project"], topic: "", limit: 10, store: "project" });
      expect(seenFromA.map(r => [r.topic, r.store])).toEqual([["Alpha project insight", "project"]]);
      expect(hooksB.searchMemory({ tags: ["iso-project"], topic: "", limit: 10 })).toEqual([]);
      expect(hooksA.scanOpenIssuesMerged().filter(i => i.scope === "project")).toEqual([]);
      expect(hooksB.scanOpenIssuesMerged().filter(i => i.scope === "project").map(i => i.title))
        .toEqual(["Beta project debt"]);
    });
  });

  // Seam-free dir resolution: the seam pins earlier in this file document
  // the hermetic-redirection contract (all stores on one dir under the
  // overrides). Isolation evidence must rest on disjoint roots instead of
  // that collapse, so these tests prove the production resolution — each
  // store's memory dir and derived index land under their own root — with
  // a fresh seam-free instance.
  describe("store dir resolution — disjoint-root instance", () => {
    let resolveHooks;
    let configRoot;
    let projectRoot;

    beforeAll(async () => {
      configRoot = mkdtempSync(join(tmpdir(), "kg-resolve-config-"));
      projectRoot = mkdtempSync(join(tmpdir(), "kg-resolve-project-"));
      delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
      delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
      delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
      process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
      process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRoot;
      const fresh = await import("../../../plugins/knowledge-gate/index.js?dir-resolve");
      resolveHooks = await fresh.default.server({}, {});
    });

    afterAll(() => {
      process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
      process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
      process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = SHORT_TERM_DIR;
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      rmSync(configRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    });

    it("resolves swarm and project memory dirs to distinct paths under their own roots", () => {
      const swarmDir = resolveHooks.memoryDirForScope("swarm");
      const projectDir = resolveHooks.memoryDirForScope("project");
      expect(swarmDir).toBe(join(configRoot, "knowledge", "memory"));
      expect(projectDir).toBe(join(configRoot, "knowledge", "projects", basename(projectRoot), "memory"));
      expect(swarmDir).not.toBe(projectDir);
    });

    it("resolves per-store index paths to distinct files under their own roots", () => {
      const swarmIdx = resolveHooks.memoryIndexPathForScope("swarm");
      const projectIdx = resolveHooks.memoryIndexPathForScope("project");
      expect(swarmIdx).toBe(join(configRoot, "knowledge", "memory", "memory-search-index.jsonl"));
      expect(projectIdx).toBe(join(configRoot, "knowledge", "projects", basename(projectRoot), "memory", "memory-search-index.jsonl"));
      expect(swarmIdx).not.toBe(projectIdx);
    });

    it("serves store-filtered searches from physically separate store dirs", () => {
      const swarmDir = join(configRoot, "knowledge", "memory");
      const projectDir = join(configRoot, "knowledge", "projects", basename(projectRoot), "memory");
      mkdirSync(swarmDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      // Distinct IDs per store: the merged path dedupes same-ID entries
      // across stores (swarm precedence), which would mask one copy.
      const swarmEntry = addMemoryEntry(1, { tags: ["resolve-probe"], topic: "Swarm-side entry" });
      const projectEntry = addMemoryEntry(2, { tags: ["resolve-probe"], topic: "Project-side entry" });
      writeFileSync(join(swarmDir, swarmEntry.fileName), swarmEntry.content);
      writeFileSync(join(projectDir, projectEntry.fileName), projectEntry.content);

      const swarmHits = resolveHooks.searchMemory({ tags: ["resolve-probe"], topic: "", limit: 10, store: "swarm" });
      expect(swarmHits.map(r => r.topic)).toEqual(["Swarm-side entry"]);
      const projectHits = resolveHooks.searchMemory({ tags: ["resolve-probe"], topic: "", limit: 10, store: "project" });
      expect(projectHits.map(r => r.topic)).toEqual(["Project-side entry"]);
      const merged = resolveHooks.searchMemory({ tags: ["resolve-probe"], topic: "", limit: 10 });
      expect(merged.map(r => r.topic).sort()).toEqual(["Project-side entry", "Swarm-side entry"]);
    });
  });

  describe("Workspace-aware issue injection", () => {
    let waHooks;
    let configRoot;
    let projectRoot;

    afterAll(() => {
      delete process.env.KNOWLEDGE_GATE_CONFIG_ROOT;
      delete process.env.KNOWLEDGE_GATE_PROJECT_ROOT;
      if (configRoot) rmSync(configRoot, { recursive: true, force: true });
      if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    });

    describe("scopesForInjection — config dir (PROJECT === CONFIG)", () => {
      beforeAll(async () => {
        configRoot = mkdtempSync(join(tmpdir(), "kg-wa-configdir-"));
        projectRoot = configRoot; // Same dir → isInConfigDir = true
        delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
        delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
        delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
        process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
        process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRoot;
        const fresh = await import("../../../plugins/knowledge-gate/index.js?wa-configdir");
        waHooks = await fresh.default.server({}, {});
      });

      it("returns swarm and generic when running in the config directory", () => {
        expect(waHooks.scopesForInjection()).toEqual(["swarm", "generic"]);
      });

      it("scanOpenIssuesWorkspaceAware only returns swarm+generic issues, not project", () => {
        // Swarm scope resolves to join(CONFIG_STORE_ROOT, "knowledge", "issues")
        const swarmDir = join(configRoot, "knowledge", "issues");
        // Generic scope resolves to join(GENERIC_STORE_ROOT, "issues")
        const genericDir = join(configRoot, "knowledge", "generic", "issues");
        mkdirSync(swarmDir, { recursive: true });
        mkdirSync(genericDir, { recursive: true });

        writeFileSync(join(swarmDir, "issue-001.md"),
          addIssueFile(1, { severity: "high", title: "Swarm issue" }).content);
        writeFileSync(join(genericDir, "issue-002.md"),
          addIssueFile(2, { severity: "medium", title: "Generic issue" }).content);
        writeFileSync(join(swarmDir, "issue-003.md"),
          addIssueFile(3, { severity: "low", title: "Third issue" }).content);

        const results = waHooks.scanOpenIssuesWorkspaceAware();
        const scopes = results.map(i => i.scope).sort();
        expect(scopes).toEqual(["generic", "swarm", "swarm"]); // 2 swarm + 1 generic
        expect(results).toHaveLength(3); // 2 from swarm + 1 from generic
      });
    });

    describe("scopesForInjection — other project (PROJECT !== CONFIG)", () => {
      beforeAll(async () => {
        configRoot = mkdtempSync(join(tmpdir(), "kg-wa-otherproj-config-"));
        projectRoot = mkdtempSync(join(tmpdir(), "kg-wa-otherproj-project-"));
        delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
        delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
        delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
        process.env.KNOWLEDGE_GATE_CONFIG_ROOT = configRoot;
        process.env.KNOWLEDGE_GATE_PROJECT_ROOT = projectRoot;
        const fresh = await import("../../../plugins/knowledge-gate/index.js?wa-otherproj");
        waHooks = await fresh.default.server({}, {});
      });

      it("returns generic and project when running in a non-config project", () => {
        expect(waHooks.scopesForInjection()).toEqual(["generic", "project"]);
      });

      it("scanOpenIssuesWorkspaceAware only returns generic+project issues, not swarm", () => {
        // Swarm scope resolves to join(CONFIG_STORE_ROOT, "knowledge", "issues")
        const swarmDir = join(configRoot, "knowledge", "issues");
        // Generic scope resolves to join(CONFIG_STORE_ROOT, "knowledge", "generic", "issues")
        // (GENERIC_STORE_ROOT is derived from CONFIG_STORE_ROOT, not PROJECT_STORE_ROOT)
        const genericDir = join(configRoot, "knowledge", "generic", "issues");
        // Project scope resolves to join(CONFIG_STORE_ROOT, "knowledge", "projects", {name}, "issues")
        // — centralized under the config root regardless of the workspace
        const projectDir = join(configRoot, "knowledge", "projects", basename(projectRoot), "issues");
        mkdirSync(swarmDir, { recursive: true });
        mkdirSync(genericDir, { recursive: true });
        mkdirSync(projectDir, { recursive: true });

        writeFileSync(join(swarmDir, "issue-001.md"),
          addIssueFile(1, { severity: "high", title: "Swarm issue" }).content);
        writeFileSync(join(genericDir, "issue-002.md"),
          addIssueFile(2, { severity: "medium", title: "Generic issue" }).content);
        writeFileSync(join(projectDir, "issue-003.md"),
          addIssueFile(3, { severity: "low", title: "Project issue" }).content);

        const results = waHooks.scanOpenIssuesWorkspaceAware();
        const scopes = results.map(i => i.scope).sort();
        expect(scopes).toEqual(["generic", "project"]);
        expect(results).toHaveLength(2); // 1 generic + 1 project
        expect(results.every(i => i.severity !== "high" || i.scope !== "swarm")).toBe(true);
      });
    });
  });
});
