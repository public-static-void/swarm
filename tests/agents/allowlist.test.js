import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Static security scan of agents/*.md bash allowlists (issue-2, M2). Guards the
// R205 contract: no agent bash entry may be a bare runtime/package-manager
// wildcard that enables arbitrary code execution, and the scoped commands
// mandated by the SPEC must stay present.

const FORBIDDEN_BARE = ["node", "bun", "npm", "npx", "yarn", "pnpm", "deno"];
const VITEST_AGENTS = ["inspector.md", "artisan.md", "analyzer.md"];
const GIT_AGENTS = ["inspector.md", "explorer.md", "analyzer.md"];
const GIT_COMMANDS = ["git branch*", "git merge-base*", "git check-ignore*", "git log --oneline*"];

function agentFiles() {
  return readdirSync(join(process.cwd(), "agents")).filter(f => f.endsWith(".md")).sort();
}

// Extracts `    "pattern": mode` lines directly under the `  bash:` mapping in
// the agent frontmatter — the only place bash permissions are declared.
function bashEntries(content) {
  const lines = content.split("\n");
  const start = lines.findIndex(l => l.trim() === "bash:");
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+"([^"]+)"\s*:\s*(allow|deny|ask)\s*$/);
    if (!m) break;
    entries.push({ pattern: m[1], mode: m[2] });
  }
  return entries;
}

describe("agents/*.md bash allowlist security scan", () => {
  const files = agentFiles();
  const entriesByFile = new Map(
    files.map(f => [f, bashEntries(readFileSync(join(process.cwd(), "agents", f), "utf8"))])
  );

  it("contains no bare runtime/package-manager wildcard (R205/AC202)", () => {
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

  it("keeps a scoped vitest entry for Inspector, Artisan, and Analyzer (AC203)", () => {
    const missing = VITEST_AGENTS.filter(
      f => !entriesByFile.get(f).some(e => e.pattern.startsWith("npx vitest"))
    );
    expect(missing).toEqual([]);
  });

  it("keeps safe git inspection commands for Inspector, Explorer, and Analyzer (AC204)", () => {
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
});
