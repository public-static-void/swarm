import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Static security scan of agents/*.md bash allowlists (issue-21). Guards the
// R201/R202/R203 contract: no agent bash entry may be a bare runtime or
// build-tool wildcard (a bare wildcard silently permits arbitrary subcommands),
// the scoped commands mandated by the SPEC stay present, and the four
// read/inspect roles carry the read-only inspection baseline. Also guards the
// R003 SAST baseline (issue-25): the npm audit/dependency-scan commands stay
// verb-pinned in every agent that runs scans or installs the tooling.

const FORBIDDEN_BARE = [
  "node", "bun", "npm", "npx", "yarn", "pnpm", "deno",
  "cargo", "poetry", "pip", "make", "mvn", "gradle", "cmake", "composer",
  "rustc", "rustup", "uv", "pytest",
];
const VITEST_AGENTS = ["inspector.md", "artisan.md", "analyzer.md"];
const GIT_AGENTS = ["inspector.md", "explorer.md", "analyzer.md"];
const GIT_COMMANDS = ["git branch*", "git merge-base*", "git check-ignore*", "git log --oneline*"];
const READONLY_BASELINE_AGENTS = ["explorer.md", "inspector.md", "pathfinder.md", "artisan.md"];
const READONLY_BASELINE_COMMANDS = ["cat*", "head*", "tail*", "wc*", "git show*", "git status -sb*"];
const SCAN_AGENTS = ["inspector.md", "analyzer.md", "artisan.md"];
const SCAN_COMMANDS = ["npm audit*"];
const SCAN_SCRIPT_COMMANDS = ["npm run audit*"];
const INSTALL_AGENTS = ["artisan.md"];
const INSTALL_COMMANDS = ["npm install --save-dev*"];
const COMMITTER_PLAN_SPEC_READ = ["knowledge/plan-*.md", "knowledge/spec-*.md"];

function agentFiles() {
  return readdirSync(join(process.cwd(), "agents")).filter(f => f.endsWith(".md")).sort();
}

// Extracts `    "pattern": mode` lines directly under a named mapping in the
// agent frontmatter (`bash:`, `read:`, `edit:`) — the only place permission
// entries are declared. Stops at the first non-entry line, which is the next
// mapping key.
function permissionEntries(content, blockName) {
  const lines = content.split("\n");
  const start = lines.findIndex(l => l.trim() === `${blockName}:`);
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+"([^"]+)"\s*:\s*(allow|deny|ask)\s*$/);
    if (!m) break;
    entries.push({ pattern: m[1], mode: m[2] });
  }
  return entries;
}

function bashEntries(content) {
  return permissionEntries(content, "bash");
}

describe("agents/*.md bash allowlist security scan", () => {
  const files = agentFiles();
  const entriesByFile = new Map(
    files.map(f => [f, bashEntries(readFileSync(join(process.cwd(), "agents", f), "utf8"))])
  );

  it("contains no bare runtime or build-tool wildcard (R201/R202, AC201)", () => {
    const offenders = [];
    for (const f of files) {
      for (const { pattern } of entriesByFile.get(f)) {
        if (FORBIDDEN_BARE.includes(pattern.replace(/\*+$/, ""))) {
          offenders.push(`${f}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps a scoped vitest entry for Inspector, Artisan, and Analyzer", () => {
    const missing = VITEST_AGENTS.filter(
      f => !entriesByFile.get(f).some(e => e.pattern.startsWith("npx vitest"))
    );
    expect(missing).toEqual([]);
  });

  it("keeps safe git inspection commands for Inspector, Explorer, and Analyzer", () => {
    const missing = [];
    for (const f of GIT_AGENTS) {
      const patterns = entriesByFile.get(f).map(e => e.pattern);
      for (const cmd of GIT_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the read-only inspection baseline for Explorer, Inspector, Pathfinder, and Artisan (R203, AC202)", () => {
    const missing = [];
    for (const f of READONLY_BASELINE_AGENTS) {
      const patterns = entriesByFile.get(f).map(e => e.pattern);
      for (const cmd of READONLY_BASELINE_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps verb-pinned npm audit entries for Inspector, Analyzer, and Artisan (R003, AC012)", () => {
    const missing = [];
    for (const f of SCAN_AGENTS) {
      const patterns = entriesByFile.get(f).map(e => e.pattern);
      for (const cmd of SCAN_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the verb-pinned npm run audit script form for Inspector, Analyzer, and Artisan (R008, AC022)", () => {
    const missing = [];
    for (const f of SCAN_AGENTS) {
      const patterns = entriesByFile.get(f).map(e => e.pattern);
      for (const cmd of SCAN_SCRIPT_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the verb-pinned npm install enabler for Artisan (R003, AC012)", () => {
    const missing = [];
    for (const f of INSTALL_AGENTS) {
      const patterns = entriesByFile.get(f).map(e => e.pattern);
      for (const cmd of INSTALL_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("committer read allowlist (R006, issue-33)", () => {
  const committer = readFileSync(join(process.cwd(), "agents", "committer.md"), "utf8");
  const readPatterns = permissionEntries(committer, "read").map(e => e.pattern);
  const editPatterns = permissionEntries(committer, "edit").map(e => e.pattern);

  it("grants read access to plan and spec KDs (AC018)", () => {
    const missing = COMMITTER_PLAN_SPEC_READ.filter(p => !readPatterns.includes(p));
    expect(missing).toEqual([]);
  });

  it("does not grant edit access to plan or spec KDs (AC019)", () => {
    const granted = editPatterns.filter(p => /^knowledge\/(plan|spec)-/.test(p));
    expect(granted).toEqual([]);
  });
});

// Static contract guard for the memory division of labor (M3, FIX1): the write
// memory tools live in the Scribe's allowlist only. The Scribe-writes-memory
// rule lives in scribe.md (step 11), NOT in Habit Builder surfaces — FIX1
// removed it from habit-builder.md after it was wrongfully placed there by M2.
describe("Memory division of labor — static agent-file contract guard (M3, AC011)", () => {
  const files = agentFiles();
  const readAgent = name => readFileSync(join(process.cwd(), "agents", name), "utf8");

  it("keeps the Scribe-writes-memory rule out of habit-builder and no memory write/update/delete allowlist entries", () => {
    expect(files).toContain("habit-builder.md");
    const habitBuilder = readAgent("habit-builder.md");
    expect(habitBuilder).not.toContain("written by the Scribe during EXTRACT");
    const writeEntries = habitBuilder.split("\n").filter(l => /^\s*memory_(write|update|delete):\s*allow\s*$/.test(l));
    expect(writeEntries).toEqual([]);
  });

  it("keeps the scribe step-11 memory_write instruction and memory tool allowlist entries", () => {
    expect(files).toContain("scribe.md");
    const scribe = readAgent("scribe.md");
    expect(scribe).toContain("write each as a JSON entry via the `memory_write` tool");
    for (const tool of ["memory_search", "memory_write", "memory_update", "memory_delete"]) {
      const allowLines = scribe.split("\n").filter(l => new RegExp(`^\\s*${tool}:\\s*allow\\s*$`).test(l));
      expect(allowLines).toHaveLength(1);
    }
  });
});
