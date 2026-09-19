import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";

// Store-scope audit over hermetic temp dirs. The earlier revision scanned the
// real gitignored knowledge/memory + knowledge/issues trees, so it passed
// vacuously on a fresh clone and failed on environment state instead of code
// behavior. The same invariant is now seeded through the plugin's own write
// paths on per-run temp dirs (the legacy KNOWLEDGE_GATE_*_DIR seams, bound
// before module load): every artifact the store accepts carries a valid
// scope, and scope-less writes are rejected before touching disk.

const VALID_SCOPES = ["project", "generic", "swarm"];

let tempRoot;
let MEMORY_DIR;
let ISSUES_DIR;
let SHORT_TERM_DIR;
let priorMemoryDir;
let priorIssuesDir;
let priorShortTermDir;
let pluginModule;
let hooks;

function memoryEntryFor(topic, tags) {
  return {
    type: "fact",
    source_kd: "knowledge/backfill-audit.md",
    tags,
    topic,
    insight: `Backfill audit probe for ${topic}.`,
    created: "2026-09-19T00:00:00.000Z",
    session: "ses_backfill_audit",
    version: "1.0.0"
  };
}

function issueForScope(scope, title) {
  return {
    title,
    severity: "high",
    created: "2026-09-19",
    session: "ses_backfill_audit",
    scope
  };
}

function frontmatterScope(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  const line = fm && fm[1].split("\n").find((l) => /^scope:\s*/.test(l));
  return line && line.replace(/^scope:\s*/, "").trim();
}

describe("swarm store backfill integrity", () => {
  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "kg-backfill-"));
    MEMORY_DIR = join(tempRoot, "memory");
    ISSUES_DIR = join(tempRoot, "issues");
    SHORT_TERM_DIR = join(tempRoot, "short-term");
    mkdirSync(MEMORY_DIR, { recursive: true });
    mkdirSync(ISSUES_DIR, { recursive: true });
    mkdirSync(SHORT_TERM_DIR, { recursive: true });
    // Dir seams are read once at module load — bind them before importing.
    priorMemoryDir = process.env.KNOWLEDGE_GATE_MEMORY_DIR;
    priorIssuesDir = process.env.KNOWLEDGE_GATE_ISSUES_DIR;
    priorShortTermDir = process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
    process.env.KNOWLEDGE_GATE_MEMORY_DIR = MEMORY_DIR;
    process.env.KNOWLEDGE_GATE_ISSUES_DIR = ISSUES_DIR;
    process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = SHORT_TERM_DIR;
    pluginModule = await import("../../../plugins/knowledge-gate/index.js?backfill-integrity");
  });

  beforeEach(async () => {
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    rmSync(ISSUES_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    mkdirSync(ISSUES_DIR, { recursive: true });
    // A fresh server instance carries fresh in-server caches.
    hooks = await pluginModule.default.server({}, {});
  });

  afterAll(() => {
    if (priorMemoryDir === undefined) delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
    else process.env.KNOWLEDGE_GATE_MEMORY_DIR = priorMemoryDir;
    if (priorIssuesDir === undefined) delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
    else process.env.KNOWLEDGE_GATE_ISSUES_DIR = priorIssuesDir;
    if (priorShortTermDir === undefined) delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
    else process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = priorShortTermDir;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("carries a valid scope in every memory entry written through memory_write", async () => {
    const probes = [
      ["swarm", "Swarm scope probe", ["testing", "cache"]],
      ["project", "Project scope probe", ["permissions", "auth"]],
      ["generic", "Generic scope probe", ["validation", "scope"]]
    ];
    for (const [scope, topic, tags] of probes) {
      const result = JSON.parse(await hooks.tool.memory_write.execute(
        { entry: memoryEntryFor(topic, tags), scope },
        { agent: "scribe", sessionID: "backfill-audit" }
      ));
      expect(result.message).toContain("written");
    }

    // Seeded above, so the audit always has artifacts to scan — never vacuous.
    const files = readdirSync(MEMORY_DIR).filter((f) => f.startsWith("entry-") && f.endsWith(".json"));
    expect(files).toHaveLength(probes.length);
    const missing = [];
    for (const f of files) {
      const entry = JSON.parse(readFileSync(join(MEMORY_DIR, f), "utf8"));
      if (!VALID_SCOPES.includes(entry.scope)) missing.push(`${f}: ${JSON.stringify(entry.scope)}`);
    }
    expect(missing).toEqual([]);
  });

  it("carries a valid scope in every issue frontmatter written through issue_write", async () => {
    const probes = [
      ["swarm", "Swarm issue probe"],
      ["project", "Project issue probe"],
      ["generic", "Generic issue probe"]
    ];
    for (const [scope, title] of probes) {
      const result = JSON.parse(await hooks.tool.issue_write.execute(
        { issue: issueForScope(scope, title) },
        { agent: "habit-builder", sessionID: "backfill-audit" }
      ));
      expect(result.message).toContain("written");
    }

    const files = readdirSync(ISSUES_DIR).filter((f) => f.startsWith("issue-") && f.endsWith(".md"));
    expect(files).toHaveLength(probes.length);
    const missing = [];
    for (const f of files) {
      const value = frontmatterScope(readFileSync(join(ISSUES_DIR, f), "utf8"));
      if (!VALID_SCOPES.includes(value)) missing.push(`${f}: ${value ?? "none"}`);
    }
    expect(missing).toEqual([]);
  });

  it("rejects scope-less writes before any artifact reaches the store", async () => {
    const memResult = JSON.parse(await hooks.tool.memory_write.execute(
      { entry: memoryEntryFor("Scopeless memory probe", ["testing"]) },
      { agent: "scribe", sessionID: "backfill-audit" }
    ));
    expect(memResult.error).toContain("scope");

    const scopelessIssue = {
      title: "Scopeless issue probe",
      severity: "high",
      created: "2026-09-19",
      session: "ses_backfill_audit"
    };
    const issueResult = JSON.parse(await hooks.tool.issue_write.execute(
      { issue: scopelessIssue },
      { agent: "habit-builder", sessionID: "backfill-audit" }
    ));
    expect(issueResult.error).toContain("scope");

    expect(readdirSync(MEMORY_DIR).filter((f) => f.startsWith("entry-"))).toHaveLength(0);
    expect(readdirSync(ISSUES_DIR).filter((f) => f.startsWith("issue-"))).toHaveLength(0);
  });
});
