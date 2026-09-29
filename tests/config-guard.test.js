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
// Intentionally empty: no cargo run invocation is project-agnostic, so any
// cargo run allow in any agent file is an offender by design.
const SANCTIONED_CARGO_RUN_COMMANDS = [];
const ARTISAN_HEADLESS_COMMANDS = [
  "git rm*", "npm install --save-dev*", "npm ci*", "bun install*",
  "poetry install*", "cargo build*", "composer install*",
  "make test*", "make build*", "go get*", "go install*",
  "uv run*", "uv sync*", "pip install*",
  "docker compose exec*", "docker compose run --rm*",
  "podman compose exec*", "podman compose run --rm*",
  "compose exec*", "compose run --rm*",
];
const ARTISAN_READONLY_GATE_COMMANDS = ["cargo fmt*"];
const ANALYZER_BUILDER_INSTALLER_COMMANDS = [
  "cargo build*", "pip install*", "poetry install*", "make build*",
  "composer install*", "cmake --build*", "gradle build*", "uv sync*",
];
const RUST_BUILD_COMMANDS = ["cargo build*"];
const RUST_FMT_CHECK_AGENTS = ["inspector.md", "analyzer.md"];
const RUST_FMT_CHECK_COMMANDS = ["cargo fmt --all --check*"];
const COMMITTER_PLAN_SPEC_READ = ["knowledge/plan-*.md", "knowledge/spec-*.md"];
// Verb families the overseer shell scope admits. A new family reddens by
// design (shell growth deserves review); a narrower grant inside a listed
// family stays green.
const OVERSEER_SHELL_FAMILIES = ["mkdir"];

// Least-scope findings for an overseer permission rule set: deny-by-default
// present, shell allows family-closed with no bare grants, read/edit/glob
// allows confined to the docs scope. Empty means the scope holds.
function overseerScopeFindingsFor(rules) {
  const findings = [];
  if (!rules.some((r) => r.resource === "*" && r.effect === "deny")) {
    findings.push("no wildcard deny — deny-by-default missing");
  }
  for (const r of rules) {
    if (r.action === "shell" && r.effect === "allow") {
      const verb = r.resource.split(" ")[0].replace(/\*+$/, "");
      if (r.resource === "*" || FORBIDDEN_BARE.includes(verb)) {
        findings.push(`unscoped shell grant: ${r.resource}`);
      } else if (!OVERSEER_SHELL_FAMILIES.includes(verb)) {
        findings.push(`shell allow outside admitted families: ${r.resource}`);
      }
    }
    if ((r.action === "read" || r.action === "edit" || r.action === "glob") && r.effect === "allow") {
      if (!r.resource.startsWith("knowledge/")) {
        findings.push(`non-docs allow: ${r.action} ${r.resource}`);
      }
    }
  }
  return findings;
}

function overseerScopeFindings(content) {
  return overseerScopeFindingsFor(permissionRules(content));
}
const CURATED_ALLOWLIST_AGENTS = ["artisan.md", "inspector.md"];
// Curated test/build verbs with scoped targets: each entry carries a
// verb-first shape (tool verb, test subcommand, scoped target family) so
// project-declared gates run directly through the role capability.
const CURATED_TEST_BUILD_COMMANDS = [
  "npm test*",
  "npm run test*",
  "npx vitest*",
  "cargo test*",
  "pytest tests*",
  "go test*",
];

describe("SPEC-template git hygiene", () => {
  const skill = readRoot(join("skills", "template-spec", "SKILL.md"));
  const gitignore = readRoot(".gitignore");

  it("requires disk-tool evidence and task-scoped staging in the AC template", () => {
    const acSection = skill.slice(skill.indexOf("## Acceptance Criteria"));
    const tools = ["`read`", "`glob`", "`grep`"].filter((t) => acSection.includes(t));
    expect(tools.length).toBeGreaterThanOrEqual(2);
    const stagingLine = acSection.split("\n").find((l) => l.includes("Stage"));
    expect(stagingLine, "AC template must carry a task-scoped staging rule").toBeTruthy();
    expect(stagingLine).toMatch(/changed/);
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

  it("carries the curated test and build verbs with scoped targets for the gate-running roles", () => {
    const missing = [];
    for (const f of CURATED_ALLOWLIST_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of CURATED_TEST_BUILD_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("shapes every curated entry verb-first with a scoped target", () => {
    const verbs = ["npm", "npx", "cargo", "pytest", "go"];
    const misshapen = [];
    for (const f of CURATED_ALLOWLIST_AGENTS) {
      for (const { pattern } of entriesByFile.get(f)) {
        if (!CURATED_TEST_BUILD_COMMANDS.includes(pattern)) continue;
        const [verb, ...rest] = pattern.split(" ");
        if (!verbs.includes(verb) || rest.length === 0 || !rest.join(" ").endsWith("*")) {
          misshapen.push(`${f}: ${pattern}`);
        }
      }
    }
    expect(misshapen).toEqual([]);
  });

  it("keeps bare tool invocations out of the curated entries", () => {
    const offenders = [];
    for (const f of CURATED_ALLOWLIST_AGENTS) {
      for (const { pattern } of entriesByFile.get(f)) {
        if (!CURATED_TEST_BUILD_COMMANDS.includes(pattern)) continue;
        if (FORBIDDEN_BARE.includes(pattern.replace(/\*+$/, ""))) {
          offenders.push(`${f}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(CURATED_TEST_BUILD_COMMANDS).not.toContain("pytest*");
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
    const habitWrites = permissionRules(habitBuilder).filter(
      (r) => /^memory_(write|update|delete)$/.test(r.action) && r.effect === "allow"
    );
    expect(habitWrites).toEqual([]);

    expect(files).toContain("scribe.md");
    const scribe = readAgent("scribe.md");
    expect(scribe).toContain("memory_write");
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

    it("dispatches the checkpoint after every plan step, unconditionally", async () => {
      // The cadence rule, the unconditional framing, and the red-gate
      // handling live in one protocol block: cadence never splits from the
      // dispatch guarantee, and a red run delays rather than cancels it.
      const artisan = readAgent("artisan.md");
      const stepBlock = artisan.slice(
        artisan.indexOf("7. Implement incrementally"),
        artisan.indexOf("### Dispatching Committer")
      );
      expect(stepBlock, "incremental-dispatch protocol block must exist").not.toBe("");
      expect(stepBlock).toContain("unconditional");
      expect(stepBlock).toMatch(/each plan step/);
      expect(stepBlock).toMatch(/red gate/);

      // Live proof: the documented example validates end to end as a
      // checkpoint dispatch — mode and result path survive the gate, and no
      // intent reference leaks into a committer-owned mode.
      const m = artisan.match(/prompt:\s*`([\s\S]*?)`/);
      expect(m, "artisan.md must contain a task() example with a template-literal prompt").toBeTruthy();
      const output = { args: { prompt: m[1], subagent_type: "committer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_abc123", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MODE: checkpoint");
      expect(output.args.prompt).toContain("RESULT KD: knowledge/checkpoint-");
      expect(output.args.prompt).not.toContain("INTENT KD:");
    });
  });
});

describe("impl KD handoff contract", () => {
  const implTemplate = readRoot(join("skills", "template-impl", "SKILL.md"));
  const artisan = readAgent("artisan.md");
  const inspector = readAgent("inspector.md");

  // Schema labels, not sentences: both handoff variants (behavior and
  // docs-only) carry the full denial delta row.
  const IMPL_HANDOFF_FIELDS = [
    "tests touched:",
    "handoff:",
    "touched surface:",
    "compile-level status:",
    "declared gate:",
    "attempted alternatives:",
    "actually-run gate:",
    "run status:",
    "full-gate status:",
  ];

  it("carries the handoff schema with the denial delta fields in the impl template", () => {
    const missing = IMPL_HANDOFF_FIELDS.filter((f) => !implTemplate.includes(f));
    expect(missing).toEqual([]);
    for (const field of ["attempted alternatives:", "actually-run gate:", "run status:"]) {
      const occurrences = implTemplate.split(field).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
  });

  it("records the denial delta row in the artisan handoff", () => {
    for (const label of ["declared gate", "attempted alternatives", "actually-run gate", "run status", "handoff block"]) {
      expect(artisan).toContain(label);
    }
  });

  it("consumes the handoff block into the inspector traceability matrix", () => {
    expect(inspector).toContain("handoff block");
    expect(inspector).toContain("traceability matrix");
    expect(inspector).toContain("actually-run gate");
  });
});

describe("planning shape and scribe composition discipline", () => {
  const pathfinder = readAgent("pathfinder.md");
  const planTemplate = readRoot(join("skills", "template-plan", "SKILL.md"));
  const scribe = readAgent("scribe.md");

  // The milestone discipline is a parity contract: the role definition and
  // the plan template agree label for label, so neither drifts alone.
  const MILESTONE_DISCIPLINE_LABELS = [
    "same milestone",
    "standing suite",
    "tests touched:",
    "failing test first",
    "implementation plus handoff",
    "skeleton",
    "final implementation milestone",
  ];

  it("keeps the milestone discipline in parity between role and template", () => {
    for (const content of [pathfinder, planTemplate]) {
      const missing = MILESTONE_DISCIPLINE_LABELS.filter((l) => !content.includes(l));
      expect(missing).toEqual([]);
    }
  });

  it("routes permanent suite changes to the body and ephemeral scratch to Excluded with disposition", () => {
    const rule = scribe.split("\n").find((l) => l.includes("Excluded"));
    expect(rule, "scribe must carry one composed-routing rule naming Excluded").toBeTruthy();
    for (const token of ["permanent", "ephemeral", "disposition"]) {
      expect(rule).toContain(token);
    }
  });
});

describe("VERIFY evidence shape", () => {
  const inspector = readAgent("inspector.md");
  const gates = readRoot(join("skills", "verification-gates", "SKILL.md"));
  const reviewTemplate = readRoot(join("skills", "template-review", "SKILL.md"));
  const milestonesTemplate = readRoot(join("skills", "template-milestones", "SKILL.md"));

  it("frames VERIFY around REVIEW KD evidence with a single verdict field", () => {
    for (const content of [inspector, gates, reviewTemplate]) {
      expect(content).toContain("traceability matrix");
      expect(content).toContain("full suite");
    }
    expect(reviewTemplate).toContain("verdict: {{PASS | FAIL | FUNDAMENTAL}}");
    for (const content of [inspector, gates]) {
      expect(content).toContain("single machine source");
    }
  });

  it("carries declared-gate and actually-run-gate columns in the VERIFY traceability matrices", () => {
    for (const content of [gates, reviewTemplate]) {
      expect(content).toContain("Declared Gate");
      expect(content).toContain("Actually-Run Gate");
    }
  });

  it("malforms uncited FAIL findings under the stale-PASS recency rule", () => {
    for (const content of [inspector, gates, reviewTemplate]) {
      expect(content).toContain("MALFORMED");
      expect(content).toMatch(/zero milestone citations/);
      expect(content).toContain("stale PASS");
    }
  });

  it("gates SWARM-to-VERIFY on registry-plus-disk evidence, fail-closed", () => {
    expect(milestonesTemplate).toContain("checkAllMilestonesCheckedOff");
    expect(milestonesTemplate).toContain("on disk");
    expect(milestonesTemplate).toContain("fails closed");
    const gateSource = readFileSync(join(ROOT, "plugins", "protocol-gate", "index.js"), "utf8");
    expect(gateSource).toContain("function checkAllMilestonesCheckedOff");
  });
});

describe("inspector rebuild parity and overseer disk-check scope", () => {
  it("carries rebuild-class shell grants for the verifier role", () => {
    const patterns = new Map(bashEntries(readAgent("inspector.md")).map((e) => [e.pattern, e.mode]));
    expect(patterns.get("make build*")).toBe("allow");
    expect(patterns.get("cargo --version*")).toBe("allow");
  });

  it("covers impl and checkpoint KD reads in the overseer glob scope", () => {
    const allows = actionEntries(readAgent("overseer.md"), "glob")
      .filter((e) => e.mode === "allow")
      .map((e) => e.pattern);
    expect(allows).toContain("knowledge/*.md");
    expect(allows).toContain("knowledge/impl-*.md");
    expect(allows).toContain("knowledge/checkpoint-*.md");
  });

  it("holds deny-by-default with family-scoped shell and docs-scoped reads", () => {
    expect(overseerScopeFindings(readAgent("overseer.md"))).toEqual([]);
  });

  it("admits a legitimate scoped grant without tripping the invariants", () => {
    const base = permissionRules(readAgent("overseer.md"));
    const extended = base.concat([
      { action: "shell", resource: "mkdir scratch-*", effect: "allow" },
      { action: "read", resource: "knowledge/extra-*.md", effect: "allow" },
    ]);
    expect(overseerScopeFindingsFor(extended)).toEqual([]);
  });

  it("fails closed on an unscoped grant", () => {
    const base = permissionRules(readAgent("overseer.md"));
    const wildcardShell = base.concat([{ action: "shell", resource: "*", effect: "allow" }]);
    expect(overseerScopeFindingsFor(wildcardShell)).not.toEqual([]);
    const outsideDocs = base.concat([{ action: "read", resource: "src/*.ts", effect: "allow" }]);
    expect(overseerScopeFindingsFor(outsideDocs)).not.toEqual([]);
  });
});

describe("harmless version-probe class", () => {
  it("carries the toolchain version probes together for the implementation role", () => {
    const patterns = bashEntries(readAgent("artisan.md")).map((e) => e.pattern);
    for (const cmd of ["cargo --version*", "rustc --version*", "node --version*"]) {
      expect(patterns).toContain(cmd);
    }
  });

  it("holds the idiomatic build target as a scoped grant for the implementation role", () => {
    const allows = bashEntries(readAgent("artisan.md"))
      .filter((e) => e.mode === "allow")
      .map((e) => e.pattern);
    expect(allows).toContain("make build*");
  });

  it("requires green-gate evidence with a denial delta row before dispatch", () => {
    const artisan = readAgent("artisan.md");
    const rule = artisan.slice(
      artisan.indexOf("6. **Gate-Verification Rule"),
      artisan.indexOf("7. Implement incrementally")
    );
    expect(rule, "gate-verification rule block must exist").not.toBe("");
    for (const label of ["declared gate", "attempted alternatives", "actually-run gate", "run status"]) {
      expect(rule).toContain(label);
    }
    expect(rule).toContain("precondition");
    expect(rule).toMatch(/re-run.*green/);
  });
});
