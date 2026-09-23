import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../plugins/delegation-gate/index.js";

// Static guards for the swarm configuration surface: SPEC-template git
// hygiene, agent permission allowlists, the git force-add staging guard, the
// committer plan/spec read contract, memory tool ownership, agents delegation
// dispatch docs, and delegation-gate integration. Each group verifies a
// runtime contract — files exist, permissions stay scoped, dispatch examples
// stay valid — without pinning the exact prose of the rules themselves.

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

// Parses the v2 `permissions:` frontmatter list (ordered action / resource /
// effect rules) into flat entries. The `bash:` / `read:` / `edit:` mapping
// blocks an earlier revision of this guard read predate the migration; no
// agent file uses them anymore, so the parser follows the current schema.
function permissionRules(content) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === "permissions:");
  if (start === -1) return [];
  const rules = [];
  let current = null;
  const flush = () => {
    if (current && current.action && current.resource && current.effect) rules.push(current);
    current = null;
  };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^---\s*$/.test(line)) break;
    let m;
    if ((m = line.match(/^\s*-\s*action:\s*(\S+)\s*$/))) {
      flush();
      current = { action: m[1] };
    } else if (current && (m = line.match(/^\s*resource:\s*"?([^"]*)"?\s*$/))) {
      current.resource = m[1];
    } else if (current && (m = line.match(/^\s*effect:\s*(allow|deny|ask)\s*$/))) {
      current.effect = m[1];
      flush();
    } else if (/^\S/.test(line)) {
      break;
    }
  }
  flush();
  return rules;
}

// Entries for one action, shaped as { pattern, mode } so every invariant
// below reads unchanged (pattern is the rule resource, mode the effect).
function actionEntries(content, action) {
  return permissionRules(content)
    .filter((r) => r.action === action)
    .map((r) => ({ pattern: r.resource, mode: r.effect }));
}

function bashEntries(content) {
  return actionEntries(content, "shell");
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
const TEXT_INSPECTION_AGENTS = ["scribe.md", "habit-builder.md", "spec-weaver.md"];
const TEXT_INSPECTION_COMMANDS = ["cat*", "head*", "tail*", "wc*"];
const ANALYZER_READ_BASELINE_COMMANDS = [
  "ls*", "find*", "cat*", "head*", "tail*", "wc*", "sort*", "uniq*",
  "diff*", "tree*", "which*", "type*", "stat*", "du*", "df*",
];
const COMMITTER_LIST_COMMANDS = ["ls*"];
const SCAN_AGENTS = ["inspector.md", "analyzer.md", "artisan.md"];
const SCAN_COMMANDS = ["npm audit*", "npm run audit*"];
const INSTALL_AGENTS = ["artisan.md"];
const INSTALL_COMMANDS = ["npm install --save-dev*"];
const RUST_BUILD_AGENTS = ["artisan.md"];
const SANCTIONED_CARGO_RUN_COMMANDS = [
  "cargo run -p xtask -- build-wasm-tests*",
  "cargo run --bin schema_validator*",
];
const ARTISAN_HEADLESS_COMMANDS = [
  "git rm*", "npm install --save-dev*", "npm ci*", "bun install*",
  "poetry install*", "cargo build*", "composer install*",
  "make test*", "make build*", "go get*", "go install*",
  "uv run*", "uv sync*", "pip install*",
  "docker compose exec*", "docker compose run --rm*",
  "podman compose exec*", "podman compose run --rm*",
  "compose exec*", "compose run --rm*",
];
const ARTISAN_READONLY_GATE_COMMANDS = [
  "cargo fmt*",
  "cargo run -p xtask -- build-wasm-tests*",
  "cargo run --bin schema_validator*",
  "make validate-schema*",
];
const ANALYZER_BUILDER_INSTALLER_COMMANDS = [
  "cargo build*", "pip install*", "poetry install*", "make build*",
  "composer install*", "cmake --build*", "gradle build*", "uv sync*",
];
const INSPECTOR_BUILD_COMMANDS = ["cargo build*", "make build*"];
const RUST_BUILD_COMMANDS = ["cargo build*"];
const RUST_FMT_CHECK_AGENTS = ["inspector.md", "analyzer.md"];
const RUST_FMT_CHECK_COMMANDS = ["cargo fmt --all --check*"];
const COMMITTER_PLAN_SPEC_READ = ["knowledge/plan-*.md", "knowledge/spec-*.md"];

describe("SPEC-template git hygiene", () => {
  const skill = readRoot(join("skills", "template-spec", "SKILL.md"));
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

  it("keeps the text-inspection baseline for the doc-processing roles", () => {
    const missing = [];
    for (const f of TEXT_INSPECTION_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of TEXT_INSPECTION_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the read-only inspection baseline for the analyzer role", () => {
    const patterns = entriesByFile.get("analyzer.md").map((e) => e.pattern);
    const missing = ANALYZER_READ_BASELINE_COMMANDS.filter((cmd) => !patterns.includes(cmd));
    expect(missing).toEqual([]);
  });

  it("keeps directory listing for the committer", () => {
    const patterns = entriesByFile.get("committer.md").map((e) => e.pattern);
    const missing = COMMITTER_LIST_COMMANDS.filter((cmd) => !patterns.includes(cmd));
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

  it("keeps scoped cargo build and format-check entries for the Rust workspace agents", () => {
    const missing = [];
    for (const f of RUST_BUILD_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of RUST_BUILD_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    for (const f of RUST_FMT_CHECK_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of RUST_FMT_CHECK_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    // Artisan's broad "cargo fmt*" entry covers the check gate by prefix match.
    const artisanPatterns = entriesByFile.get("artisan.md").map((e) => e.pattern);
    if (!artisanPatterns.some((p) => p.startsWith("cargo fmt"))) {
      missing.push("artisan.md: cargo fmt* prefix");
    }
    expect(missing).toEqual([]);
  });

  it("restricts cargo run to the sanctioned read-only workspace gates", () => {
    const offenders = [];
    for (const f of files) {
      for (const { pattern } of entriesByFile.get(f)) {
        if (pattern.startsWith("cargo run") && !SANCTIONED_CARGO_RUN_COMMANDS.includes(pattern)) {
          offenders.push(`${f}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("holds the sanctioned read-only gate commands for Artisan", () => {
    const artisan = new Map(entriesByFile.get("artisan.md").map((e) => [e.pattern, e.mode]));
    const missing = ARTISAN_READONLY_GATE_COMMANDS.filter((cmd) => artisan.get(cmd) !== "allow");
    expect(missing).toEqual([]);
  });

  it("allows install and exec-class commands headless for Artisan", () => {
    const artisan = new Map(entriesByFile.get("artisan.md").map((e) => [e.pattern, e.mode]));
    const violations = ARTISAN_HEADLESS_COMMANDS.filter((cmd) => artisan.get(cmd) !== "allow");
    expect(violations).toEqual([]);
  });

  it("keeps builder and installer grants out of the read-only analyzer role", () => {
    const patterns = new Map(entriesByFile.get("analyzer.md").map((e) => [e.pattern, e.mode]));
    const granted = ANALYZER_BUILDER_INSTALLER_COMMANDS.filter((cmd) => patterns.get(cmd) === "allow");
    expect(granted).toEqual([]);
  });

  it("keeps build grants out of the verifier inspector role", () => {
    const patterns = new Map(entriesByFile.get("inspector.md").map((e) => [e.pattern, e.mode]));
    const granted = INSPECTOR_BUILD_COMMANDS.filter((cmd) => patterns.get(cmd) === "allow");
    expect(granted).toEqual([]);
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
    const readPatterns = actionEntries(committer, "read").map((e) => e.pattern);
    const editPatterns = actionEntries(committer, "edit").map((e) => e.pattern);
    const missing = COMMITTER_PLAN_SPEC_READ.filter((p) => !readPatterns.includes(p));
    expect(missing).toEqual([]);
    const granted = editPatterns.filter((p) => /^knowledge\/(plan|spec)-/.test(p));
    expect(granted).toEqual([]);
  });

  it("grants committer read access to composed, process, and report KD types", () => {
    const readPatterns = actionEntries(readAgent("committer.md"), "read").map((e) => e.pattern);
    const editPatterns = actionEntries(readAgent("committer.md"), "edit").map((e) => e.pattern);
    const closureTypes = ["composed", "process", "report"];
    const missing = closureTypes.map((t) => `knowledge/${t}-*.md`).filter((p) => !readPatterns.includes(p));
    expect(missing).toEqual([]);
    const grantedEdits = editPatterns.filter((p) => /^knowledge\/(composed|process|report)-/.test(p));
    expect(grantedEdits).toEqual([]);
  });
});

describe("memory tool ownership", () => {
  const files = agentFiles();

  it("keeps memory tool ownership with the Scribe and out of habit-builder", () => {
    expect(files).toContain("habit-builder.md");
    const habitBuilder = readAgent("habit-builder.md");
    expect(habitBuilder).not.toContain("written by the Scribe during EXTRACT");
    const habitWrites = permissionRules(habitBuilder).filter(
      (r) => /^memory_(write|update|delete)$/.test(r.action) && r.effect === "allow"
    );
    expect(habitWrites).toEqual([]);

    expect(files).toContain("scribe.md");
    const scribe = readAgent("scribe.md");
    expect(scribe).toContain("write each as a JSON entry via the `memory_write` tool");
    for (const tool of ["memory_search", "memory_write", "memory_update", "memory_delete"]) {
      const allows = permissionRules(scribe).filter((r) => r.action === tool && r.effect === "allow");
      expect(allows).toHaveLength(1);
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

      // A description that already carries the hint is left alone: the hint
      // still appears exactly once and the original text survives. Matched
      // by containment rather than exact equality so a legitimate reformat
      // of the hint template cannot break the dedupe contract this guards.
      const dupe = { description: "Delegate work. Delegation Prompt Format:\nDISPATCH TO: <agent>" };
      await hooks["tool.definition"]({ toolID: "task" }, dupe);
      expect(dupe.description).toContain("Delegate work.");
      expect(dupe.description).toContain("DISPATCH TO: <agent>");
      expect(dupe.description.match(/Delegation Prompt Format:/g)).toHaveLength(1);

      const other = { description: "Read a file." };
      await hooks["tool.definition"]({ toolID: "read" }, other);
      expect(other.description).toContain("Read a file.");
      expect(other.description).not.toContain("Delegation Prompt Format:");
    });

    // BRANCH format hint test removed — BRANCH parameter eliminated from delegation system

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

    it("states the artisan checkpoint dispatch as unconditional", async () => {
      // The skipped-checkpoint defect came from artisans treating a scope
      // without checkpoint fields as permission to skip the dispatch —
      // artisan.md must state the dispatch happens after every plan step
      // regardless of scope wording, with red gates delaying (fix, re-run,
      // then dispatch) rather than cancelling it.
      const artisan = readAgent("artisan.md");
      expect(artisan).toMatch(/unconditional/);
      expect(artisan).toMatch(/leaves the dispatch required/);
      expect(artisan).toMatch(/the dispatch still happens/);
    });
  });
});
