import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../plugins/delegation-gate/index.js";

// Static guards for the swarm configuration surface: the README architecture
// documentation, the SPEC-template git hygiene contract, agent permission
// allowlists, and the delegation examples in agent docs. Each group verifies a
// runtime contract — files exist, the tracked set stays gitignored,
// permissions stay scoped, dispatch examples stay valid — without pinning the
// exact prose of the rules themselves.

const ROOT = process.cwd();
const AGENTS_DIR = join(ROOT, "agents");

function readRoot(name) {
  return readFileSync(join(ROOT, name), "utf8");
}

function agentFiles() {
  return readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
}

function readAgent(name) {
  return readFileSync(join(AGENTS_DIR, name), "utf8");
}

// Extracts `    "pattern": mode` lines directly under a named mapping in the
// agent frontmatter (`bash:`, `read:`, `edit:`) — the place permission entries
// are declared. Stops at the first non-entry line, the next mapping key.
function permissionEntries(content, blockName) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === `${blockName}:`);
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
const SCAN_COMMANDS = ["npm audit*", "npm run audit*"];
const INSTALL_AGENTS = ["artisan.md"];
const INSTALL_COMMANDS = ["npm install --save-dev*"];
const COMMITTER_PLAN_SPEC_READ = ["knowledge/plan-*.md", "knowledge/spec-*.md"];

describe("README architecture documentation", () => {
  const readme = readRoot("README.md");

  it("exists at the repo root as a tracked file", () => {
    expect(existsSync(join(ROOT, "README.md"))).toBe(true);
  });

  it("documents the focused-agent concept", () => {
    expect(readme).toContain("one responsibility per agent");
    expect(readme).toContain("Focused Agents");
  });

  it("documents the labor subdivision across the agent roster", () => {
    expect(readme).toContain("Labor Subdivision");
    for (const role of ["Overseer", "Explorer", "Analyzer", "Artisan", "Inspector", "Committer"]) {
      expect(readme).toContain(role);
    }
  });

  it("documents role boundaries as disjoint ownership", () => {
    expect(readme).toContain("Explorer");
    expect(readme).toContain("exploration");
    expect(readme).toContain("Analyzer");
    expect(readme).toContain("root cause");
    expect(readme).toContain("owned by exactly one role");
  });

  it("documents that permissions are limited by design", () => {
    expect(readme).toContain("limited by design");
    expect(readme).toContain("enforcement");
    expect(readme).toContain("not a gap");
  });

  it("documents the dispatch semantics for git operations and checkpoints", () => {
    expect(readme).toContain("Git operations go to the Committer");
    expect(readme).toContain("dispatches the Committer");
  });

  it("documents plugin structural enforcement", () => {
    expect(readme).toContain("Plugins");
    expect(readme).toContain("structural");
  });

  it("documents the layer discipline of the configuration", () => {
    expect(readme).toContain("AGENTS.md");
    expect(readme).toContain("agents/");
    expect(readme).toContain("skills/");
    expect(readme).toContain("plugins/");
    expect(readme).toContain("ground rules");
    expect(readme).toContain("agent-specific");
    expect(readme).toContain("domain knowledge");
    expect(readme).toContain("structural constraints");
  });
});

describe("SPEC-template git hygiene", () => {
  const skill = readRoot(join("skills", "template-spec", "SKILL.md"));
  const agents = readRoot("AGENTS.md");
  const gitignore = readRoot(".gitignore");

  it("keeps disk-verification and task-agnostic staging guidance in the AC template", () => {
    expect(skill).toContain("verified from disk via `read`/`glob`/`grep`");
    expect(skill).toContain("Stage the files this task changed");
  });

  it("requires no git-diff or staged-state evidence in the AC template", () => {
    const acSection = skill.slice(skill.indexOf("## Acceptance Criteria"));
    expect(acSection).not.toContain("git diff");
    expect(acSection).not.toContain("staged");
  });

  it("documents the tracked-set ground rule in AGENTS.md", () => {
    expect(agents).toContain("git tracks swarm config: AGENTS.md, agents/, skills/, plugins/, tests/, commands/, opencode.json. knowledge/ is workflow meta and stays gitignored.");
  });

  it("keeps knowledge/ gitignored in .gitignore", () => {
    expect(gitignore.split("\n")).toContain("knowledge/");
  });
});

describe("agent permission allowlists", () => {
  const files = agentFiles();
  const entriesByFile = new Map(
    files.map((f) => [f, bashEntries(readAgent(f))])
  );

  it("rejects bare runtime and build-tool wildcards", () => {
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

  it("keeps scoped vitest entries for the test-running agents", () => {
    const missing = VITEST_AGENTS.filter(
      (f) => !entriesByFile.get(f).some((e) => e.pattern.startsWith("npx vitest"))
    );
    expect(missing).toEqual([]);
  });

  it("keeps safe git inspection commands for the inspection agents", () => {
    const missing = [];
    for (const f of GIT_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of GIT_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the read-only inspection baseline for the inspection roles", () => {
    const missing = [];
    for (const f of READONLY_BASELINE_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of READONLY_BASELINE_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps verb-pinned dependency-scan commands for the scanning agents", () => {
    const missing = [];
    for (const f of SCAN_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of SCAN_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the scoped npm install enabler for Artisan", () => {
    const missing = [];
    for (const f of INSTALL_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of INSTALL_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("git force-add staging guard", () => {
  it("pairs every git add allow with a later git add -f deny in every agent", () => {
    const violations = [];
    for (const f of agentFiles()) {
      const entries = bashEntries(readAgent(f));
      const denyIdx = entries.findIndex((e) => e.pattern === "git add -f*" && e.mode === "deny");
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.pattern.startsWith("git add") && e.mode === "allow") {
          if (denyIdx === -1) violations.push(`${f}: ${e.pattern} has no git add -f* deny`);
          else if (denyIdx < i) violations.push(`${f}: git add -f* deny (idx ${denyIdx}) precedes ${e.pattern} allow (idx ${i})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the committer git add allow before its git add -f deny", () => {
    const committer = bashEntries(readAgent("committer.md"));
    const allowIdx = committer.findIndex((e) => e.pattern === "git add*" && e.mode === "allow");
    const denyIdx = committer.findIndex((e) => e.pattern === "git add -f*" && e.mode === "deny");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });
});

describe("committer plan/spec read contract", () => {
  const committer = readAgent("committer.md");

  it("grants read access to plan and spec KDs and keeps edit access scoped away", () => {
    const readPatterns = permissionEntries(committer, "read").map((e) => e.pattern);
    const editPatterns = permissionEntries(committer, "edit").map((e) => e.pattern);
    const missing = COMMITTER_PLAN_SPEC_READ.filter((p) => !readPatterns.includes(p));
    expect(missing).toEqual([]);
    const granted = editPatterns.filter((p) => /^knowledge\/(plan|spec)-/.test(p));
    expect(granted).toEqual([]);
  });
});

describe("memory tool ownership", () => {
  const files = agentFiles();

  it("keeps memory tool ownership with the Scribe and out of habit-builder", () => {
    expect(files).toContain("habit-builder.md");
    const habitBuilder = readAgent("habit-builder.md");
    expect(habitBuilder).not.toContain("written by the Scribe during EXTRACT");
    const habitWriteEntries = habitBuilder.split("\n").filter((l) => /^\s*memory_(write|update|delete):\s*allow\s*$/.test(l));
    expect(habitWriteEntries).toEqual([]);

    expect(files).toContain("scribe.md");
    const scribe = readAgent("scribe.md");
    expect(scribe).toContain("write each as a JSON entry via the `memory_write` tool");
    for (const tool of ["memory_search", "memory_write", "memory_update", "memory_delete"]) {
      const allowLines = scribe.split("\n").filter((l) => new RegExp(`^\\s*${tool}:\\s*allow\\s*$`).test(l));
      expect(allowLines).toHaveLength(1);
    }
  });
});

describe("agents delegation dispatch docs", () => {
  const files = agentFiles();

  it("teaches no top-level task() args with placeholder prompt or description", () => {
    const offenders = [];
    for (const f of files) {
      const content = readAgent(f);
      if (/prompt:\s*"placeholder"/i.test(content)) {
        offenders.push(`${f}: prompt: "placeholder"`);
      }
      if (/description:\s*"placeholder"/i.test(content)) {
        offenders.push(`${f}: description: "placeholder"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("embeds no literal brace placeholders in task() examples", () => {
    const offenders = [];
    for (const f of files) {
      const content = readAgent(f);
      const fence = /```([\s\S]*?)```/g;
      let m;
      while ((m = fence.exec(content)) !== null) {
        const block = m[1];
        if (!block.includes("task(")) continue;
        const brace = block.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
        if (brace) offenders.push(`${f}: ${brace[0]} inside a task( example`);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe("delegation-gate integration", () => {
    let hooks;
    let logDir;
    let priorLogDir;
    let priorDebug;

    beforeAll(async () => {
      // Log isolation: bind the module-level log cache to a temp dir before
      // the first server() call so this file never writes the real log.
      priorLogDir = process.env.DELEGATION_GATE_LOG_DIR;
      priorDebug = process.env.DELEGATION_GATE_DEBUG;
      logDir = mkdtempSync(join(tmpdir(), "config-guard-test-"));
      process.env.DELEGATION_GATE_LOG_DIR = logDir;
      hooks = await pluginModule.server({}, {});
    });

    afterAll(() => {
      if (priorLogDir === undefined) delete process.env.DELEGATION_GATE_LOG_DIR;
      else process.env.DELEGATION_GATE_LOG_DIR = priorLogDir;
      if (priorDebug === undefined) delete process.env.DELEGATION_GATE_DEBUG;
      else process.env.DELEGATION_GATE_DEBUG = priorDebug;
      rmSync(logDir, { recursive: true, force: true });
    });

    it("annotates the task tool definition with a single format hint", async () => {
      const output = { description: "Delegate work to another agent." };
      await hooks["tool.definition"]({ toolID: "task" }, output);
      expect(output.description).toContain("Delegation Prompt Format:");
      expect(output.description).toContain("KEY: value lines");
      expect(output.description).toContain("prompt parameter");
      expect(output.description.match(/Delegation Prompt Format:/g)).toHaveLength(1);

      // A description that already carries the hint is untouched.
      const dupe = { description: "Delegate work. Delegation Prompt Format:\nDISPATCH TO: <agent>" };
      await hooks["tool.definition"]({ toolID: "task" }, dupe);
      expect(dupe.description).toBe("Delegate work. Delegation Prompt Format:\nDISPATCH TO: <agent>");

      const other = { description: "Read a file." };
      await hooks["tool.definition"]({ toolID: "read" }, other);
      expect(other.description).toBe("Read a file.");
    });

    it("annotates the task tool definition with the BRANCH line for committer modes", async () => {
      const output = { description: "Delegate work to another agent." };
      await hooks["tool.definition"]({ toolID: "task" }, output);
      expect(output.description).toContain("BRANCH: branch name (required for preflight/cleanup)");
      expect(output.description).toContain("preflight/cleanup");
    });

    it("validates the artisan.md checkpoint dispatch example", async () => {
      const artisan = readAgent("artisan.md");
      const m = artisan.match(/prompt:\s*`([\s\S]*?)`/);
      expect(m, "artisan.md must contain a task() example with a template-literal prompt").toBeTruthy();
      const prompt = m[1];
      expect(prompt).toContain("DISPATCH TO: committer");
      expect(prompt).toContain("MODE: checkpoint");
      expect(prompt).not.toContain("{");

      const output = { args: { prompt, subagent_type: "committer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_abc123", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MODE: checkpoint");
      expect(output.args.prompt).toContain("RESULT KD: knowledge/checkpoint-");
      expect(output.args.prompt).not.toContain("INTENT KD:");
    });
  });
});
