import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../plugins/delegation-gate/index.js";
import * as protocolPhases from "../plugins/protocol-gate/phases.js";

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

// Line-index span of a file's leading `--- … ---` metadata region. Only the
// first region is ever returned: a file whose first line is not `---` has no
// frontmatter, and a later `---` region belongs to a different document shape
// (the multi-region skill template) that this guard deliberately does not fold
// into the leading one.
function frontmatterRegion(content) {
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return end === -1 ? null : { start: 0, end };
}

// 1-based line numbers inside that region whose first non-whitespace character
// is `#` — a YAML comment where the metadata block carries data only. The test
// keys on a line-leading `#`, so a `#` inside a quoted scalar value is never
// mistaken for a comment.
function metadataCommentOffenders(content) {
  const region = frontmatterRegion(content);
  if (!region) return [];
  const lines = content.split("\n");
  const offenders = [];
  for (let i = region.start + 1; i < region.end; i++) {
    if (/^\s*#/.test(lines[i])) offenders.push(i + 1);
  }
  return offenders;
}

// Every source file beneath a tree, filtered by extension. Used to sweep the
// configuration surface for external path literals; directories named in
// `skip` are pruned wholesale.
function sourceFilesRecursive(dir, extensions, skip = []) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (skip.includes(full)) continue;
    if (entry.isDirectory()) out.push(...sourceFilesRecursive(full, extensions, skip));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
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
const SCAN_COMMANDS = ["npm audit*", "npm run audit*", "pip audit*"];
// Per-command owners: the python scan probe is a scanner-role grant (the
// builder holds it for dependency work, the verifier for scan parity) while
// the investigator role stays denied by design.
const SCAN_COMMAND_AGENTS = {
  "npm audit*": SCAN_AGENTS,
  "npm run audit*": SCAN_AGENTS,
  "pip audit*": ["inspector.md", "artisan.md"],
};
const INSTALL_AGENTS = ["artisan.md"];
const INSTALL_COMMANDS = ["npm install --save-dev*", "npm install*", "npm update*"];
const RUST_BUILD_AGENTS = ["artisan.md"];
// Intentionally empty: no cargo run invocation is project-agnostic, so any
// cargo run allow in any agent file is an offender by design.
const SANCTIONED_CARGO_RUN_COMMANDS = [];
const ARTISAN_HEADLESS_COMMANDS = [
  "git rm*", "npm install --save-dev*", "npm install*", "npm update*", "npm ci*", "bun install*",
  "poetry install*", "cargo build*", "composer install*",
  "make test*", "make build*", "go get*", "go install*",
  "uv run*", "uv sync*", "pip install*",
  "poetry add*", "poetry update*", "poetry lock*",
  "uv add*", "uv lock*",
  "yarn install --frozen-lockfile*", "pnpm install --frozen-lockfile*",
  "docker compose exec*", "docker compose run --rm*",
  "podman compose exec*", "podman compose run --rm*",
  "compose exec*", "compose run --rm*",
];
const ARTISAN_READONLY_GATE_COMMANDS = ["cargo fmt*"];
// Read-only diagnostic family the implementation role holds for headless
// triage: shell builtins-free inspection verbs shared with the analysis
// role's baseline, each a single-verb glob with no interpreter scope.
const ARTISAN_DIAGNOSTIC_COMMANDS = [
  "pwd*", "whoami*", "date*", "printenv*", "find*", "sort*", "uniq*",
  "diff*", "tree*", "which*", "type*", "stat*", "du*", "df*",
];
// Toolchain version probes for the implementation role: verb-first entries
// with a scoped target (tool plus version flag), never a bare interpreter.
const ARTISAN_VERSION_PROBE_COMMANDS = [
  "npm --version*", "node --help*", "node --version*", "npx --version*",
  "python3 --version*", "go version*", "gh --version*",
  "yarn --version*", "pnpm --version*", "bun --version*",
];
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
// Python read-only probes: verb-first inspection entries shared by the
// gate-running roles. Ownership varies per entry (only the builder holds
// pip-compile), so each entry maps to its owning roles.
const PYTHON_READ_PROBE_COMMANDS = [
  "poetry check*", "poetry show*", "poetry --version*",
  "pip check*", "pip list*", "pip show*", "pip freeze*", "pip --version*",
  "uv pip list*", "uv --version*",
  "python --version*", "pip-compile --version*",
];
const PYTHON_READ_PROBE_AGENTS = {
  "poetry check*": ["artisan.md", "analyzer.md", "inspector.md"],
  "poetry show*": ["artisan.md", "analyzer.md", "inspector.md"],
  "poetry --version*": ["artisan.md", "analyzer.md"],
  "pip check*": ["artisan.md", "analyzer.md", "inspector.md"],
  "pip list*": ["artisan.md", "analyzer.md", "inspector.md"],
  "pip show*": ["artisan.md", "analyzer.md", "inspector.md"],
  "pip freeze*": ["artisan.md", "analyzer.md", "inspector.md"],
  "pip --version*": ["artisan.md", "analyzer.md"],
  "uv pip list*": ["artisan.md", "analyzer.md"],
  "uv --version*": ["artisan.md", "analyzer.md"],
  "python --version*": ["artisan.md", "analyzer.md"],
  "pip-compile --version*": ["artisan.md"],
};
// Python mutators stay builder-only: the investigator and verifier roles
// must not gain dependency-write entries.
const PYTHON_MUTATOR_COMMANDS = [
  "poetry add*", "poetry update*", "poetry lock*",
  "pip install*", "uv add*", "uv sync*", "uv lock*",
];
// Read-only make gates: lint/check/vet/audit for all three gate-running
// roles; the format gate mutates sources so only the builder holds it.
const MAKE_GATE_COMMANDS = [
  "make fmt*", "make lint*", "make check*", "make vet*", "make audit*",
];
const MAKE_GATE_AGENTS = {
  "make fmt*": ["artisan.md"],
  "make lint*": ["artisan.md", "analyzer.md", "inspector.md"],
  "make check*": ["artisan.md", "analyzer.md", "inspector.md"],
  "make vet*": ["artisan.md", "analyzer.md", "inspector.md"],
  "make audit*": ["artisan.md", "analyzer.md", "inspector.md"],
};
// Read-only gh inspection entries for the gate-running roles; roles without
// a verification mandate hold none of them.
const GH_READ_COMMANDS = [
  "gh issue view*", "gh pr view*", "gh search*",
  "gh release view*", "gh repo view*",
];
const GH_READ_AGENTS = ["artisan.md", "analyzer.md", "inspector.md"];
const GH_READ_EXCLUDED_AGENTS = ["overseer.md", "explorer.md", "committer.md"];
// Read-only posture for the narrow inspection roles: none of them holds an
// echo shell grant (echo with redirect is a file-write primitive). The
// absence assertion below fails on any echo-verb allow in those files.
const READONLY_NO_ECHO_AGENTS = ["explorer.md", "scribe.md", "pathfinder.md"];
const EXPLORER_GIT_DIAG_COMMANDS = ["git diff*", "git log*"];
// Analyzer parity additions: the test-runner entry and toolchain probes the
// other gate-running roles already hold, without any installer scope.
const ANALYZER_PARITY_COMMANDS = ["npm run test*", "cargo --version*", "cargo fmt --check*"];
// Read-only workspace-introspection class (swarm/60): verb-first, exact-prefix
// shell entries whose target subcommand reports workspace structure/metadata
// with no build, run, or mutation side effect. `cargo metadata` is the current
// concrete member; the class rule carries the generality, so a future workspace
// ecosystem's metadata verb joins this pinned list rather than being added
// speculatively.
const ANALYZER_INTROSPECTION_COMMANDS = ["cargo metadata*"];
// Target subcommands carrying a build, run, or mutation side effect — an entry
// whose subcommand is one of these is not a read-only introspection probe.
const INTROSPECTION_MUTATION_SUBCOMMANDS = [
  "build", "run", "install", "add", "remove", "update", "clean",
  "check", "test", "clippy", "fmt", "fix", "bench", "publish",
];
// Ecosystem metadata verbs the class rule deliberately leaves ungranted: each
// joins the class only when that ecosystem is the workspace.
const SPECULATIVE_INTROSPECTION_COMMANDS = [
  "npm ls*", "bun pm ls*", "go list*", "yarn list*", "pnpm list*",
];
// Working-directory boundary: the external-directory posture is a blanket deny
// in every role, and no OS-specific or literal external path prefix appears in
// the swarm configuration. The matcher below is the scannable boundary
// predicate; the scan is grant-shaped — a permission `resource:` value, an
// `external_directory` rule, or an allow-mapping entry — so the path literals
// that ordinary suite fixtures carry are not mistaken for grants. The sole
// enumerated exception is the pre-existing artisan scratch-removal grant,
// retained pending the open decision to retarget it to a workspace-relative
// scratch.
const EXTERNAL_PATH =
  /(?:~|\$HOME)[/\\]|\b[A-Za-z]:[/\\]|(?:^|[\s"'`([{=:])\/(?:tmp|home|Users|usr|etc|var|opt|root|mnt|media|srv|proc|sys|dev|boot|lib|bin|sbin|run)(?=[/\\])/;
const EXTERNAL_GRANT_SHAPE =
  /\bresource\s*:|\bexternal_directory\b|["'][^"'\n]+["']\s*:\s*["']?(?:allow|ask)["']/;

function hasExternalLiteral(text) {
  return EXTERNAL_GRANT_SHAPE.test(text) && EXTERNAL_PATH.test(text);
}

// The one pre-existing in-tree external literal: artisan's scoped scratch
// removal grant, kept as the enumerated exception pending the open retarget
// decision.
const EXTERNAL_LITERAL_EXCEPTIONS = ['resource: "rm /tmp/opencode/*"'];

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
    for (const cmd of SCAN_COMMANDS) {
      for (const f of SCAN_COMMAND_AGENTS[cmd]) {
        const patterns = entriesByFile.get(f).map((e) => e.pattern);
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(
      entriesByFile.get("analyzer.md").map((e) => e.pattern)
    ).not.toContain("pip audit*");
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

  it("holds the dependency-mutation path approval-free for Artisan", () => {
    const artisan = new Map(entriesByFile.get("artisan.md").map((e) => [e.pattern, e.mode]));
    for (const cmd of ["npm install*", "npm update*", "npm ci*"]) {
      expect(artisan.get(cmd)).toBe("allow");
    }
  });

  it("carries the read-only diagnostic family for the implementation role", () => {
    const artisan = new Map(entriesByFile.get("artisan.md").map((e) => [e.pattern, e.mode]));
    const missing = ARTISAN_DIAGNOSTIC_COMMANDS.filter((cmd) => artisan.get(cmd) !== "allow");
    expect(missing).toEqual([]);
  });

  it("carries the toolchain version probes for the implementation role", () => {
    const artisan = new Map(entriesByFile.get("artisan.md").map((e) => [e.pattern, e.mode]));
    const missing = ARTISAN_VERSION_PROBE_COMMANDS.filter((cmd) => artisan.get(cmd) !== "allow");
    expect(missing).toEqual([]);
  });

  it("keeps the new diagnostic and probe grants scoped with no bare-interpreter allow", () => {
    const allows = entriesByFile.get("artisan.md").filter((e) => e.mode === "allow").map((e) => e.pattern);
    const bareInterpreters = [
      "npm*", "node*", "npx*", "yarn*", "pnpm*", "bun*",
      "python3*", "go*", "gh*",
    ];
    const offenders = allows.filter((p) => bareInterpreters.includes(p));
    expect(offenders).toEqual([]);
    for (const cmd of [...ARTISAN_DIAGNOSTIC_COMMANDS, ...ARTISAN_VERSION_PROBE_COMMANDS]) {
      expect(cmd.endsWith("*")).toBe(true);
    }
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

  it("pins the python read probes per owning role and keeps mutators builder-only", () => {
    const missing = [];
    for (const cmd of PYTHON_READ_PROBE_COMMANDS) {
      for (const f of PYTHON_READ_PROBE_AGENTS[cmd]) {
        const patterns = entriesByFile.get(f).map((e) => e.pattern);
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
    const offenders = [];
    for (const f of ["analyzer.md", "inspector.md"]) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of PYTHON_MUTATOR_COMMANDS) {
        if (patterns.includes(cmd)) {
          offenders.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pins the read-only make gates per owning role and keeps the format gate builder-only", () => {
    const missing = [];
    for (const cmd of MAKE_GATE_COMMANDS) {
      for (const f of MAKE_GATE_AGENTS[cmd]) {
        const patterns = entriesByFile.get(f).map((e) => e.pattern);
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
    const offenders = [];
    for (const f of ["analyzer.md", "inspector.md"]) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      if (patterns.includes("make fmt*")) {
        offenders.push(`${f}: make fmt*`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pins the read-only gh inspection entries for the gate-running roles only", () => {
    const missing = [];
    for (const f of GH_READ_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of GH_READ_COMMANDS) {
        if (!patterns.includes(cmd)) {
          missing.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(missing).toEqual([]);
    const offenders = [];
    for (const f of GH_READ_EXCLUDED_AGENTS) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of GH_READ_COMMANDS) {
        if (patterns.includes(cmd)) {
          offenders.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carries the test-runner parity entries for the analysis role", () => {
    const patterns = entriesByFile.get("analyzer.md").map((e) => e.pattern);
    const missing = ANALYZER_PARITY_COMMANDS.filter((cmd) => !patterns.includes(cmd));
    expect(missing).toEqual([]);
  });

  it("holds no echo shell grant in the narrow inspection roles", () => {
    const offenders = [];
    for (const f of READONLY_NO_ECHO_AGENTS) {
      for (const e of entriesByFile.get(f)) {
        if (e.mode !== "allow") continue;
        const verb = e.pattern.split(" ")[0].replace(/\*+$/, "");
        if (verb === "echo") {
          offenders.push(`${f}: ${e.pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scopes the git diff and log diagnostics to the explorer role", () => {
    const explorer = new Map(entriesByFile.get("explorer.md").map((e) => [e.pattern, e.mode]));
    const missing = EXPLORER_GIT_DIAG_COMMANDS.filter((cmd) => explorer.get(cmd) !== "allow");
    expect(missing).toEqual([]);
    const offenders = [];
    for (const f of ["scribe.md", "pathfinder.md"]) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of EXPLORER_GIT_DIAG_COMMANDS) {
        if (patterns.includes(cmd)) {
          offenders.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps dependency mutators out of the narrow inspection roles", () => {
    const offenders = [];
    for (const f of [...READONLY_NO_ECHO_AGENTS, "analyzer.md", "inspector.md"]) {
      const patterns = entriesByFile.get(f).map((e) => e.pattern);
      for (const cmd of ["npm install*", "npm update*", "npm ci*"]) {
        if (patterns.includes(cmd)) {
          offenders.push(`${f}: ${cmd}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the dangerous exec and privilege class out of every agent allowlist", () => {
    const dangerousVerbs = ["chmod", "chown", "sudo", "su", "curl", "wget", "ssh", "eval"];
    const dangerousPhrases = ["python -c", "node -e", "bash -c"];
    const offenders = [];
    for (const f of files) {
      for (const e of entriesByFile.get(f)) {
        if (e.mode !== "allow") continue;
        const verb = e.pattern.split(" ")[0].replace(/\*+$/, "");
        if (dangerousVerbs.includes(verb)) {
          offenders.push(`${f}: ${e.pattern}`);
        } else if (dangerousPhrases.some((p) => e.pattern.startsWith(p))) {
          offenders.push(`${f}: ${e.pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Metadata-block purity (frontmatter is data): the leading `--- … ---` region
// of an agent definition carries role config and ordered permission rules, and
// no prose. A line-leading `#` in that region is the defect this guard names.
// Only the leading region is read — a file carrying more than one `---` region
// (the multi-region skill template shape) is out of scope by explicit decision,
// so a second region is never folded in and never silently scanned.
describe("agent metadata block purity", () => {
  it("keeps agent metadata blocks free of comment lines", () => {
    const offenders = [];
    for (const f of agentFiles()) {
      for (const line of metadataCommentOffenders(readAgent(f))) {
        offenders.push(`${f}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Analyzer read-only workspace introspection (swarm/60): the analyzer holds a
// grant for read-only workspace-introspection verbs — verb-first exact-prefix
// shell entries whose target subcommand reports workspace structure/metadata
// with no build, run, or mutation side effect. The class rule, stated in the
// role instructions, carries the generality; `cargo metadata*` is its current
// concrete member and no other ecosystem verb is added speculatively.
describe("analyzer read-only introspection class (swarm/60)", () => {
  const analyzer = readAgent("analyzer.md");
  const patterns = new Map(bashEntries(analyzer).map((e) => [e.pattern, e.mode]));

  it("grants the concrete introspection member to the analysis role", () => {
    const missing = ANALYZER_INTROSPECTION_COMMANDS.filter((cmd) => patterns.get(cmd) !== "allow");
    expect(missing).toEqual([]);
  });

  it("shapes every introspection entry verb-first with a scoped, read-only target", () => {
    const misshapen = [];
    for (const cmd of ANALYZER_INTROSPECTION_COMMANDS) {
      if (!cmd.endsWith("*")) {
        misshapen.push(`${cmd}: not a trailing-wildcard scoped target`);
        continue;
      }
      const tokens = cmd.replace(/\*+$/, "").split(" ").filter(Boolean);
      if (tokens.length < 2) {
        misshapen.push(`${cmd}: not verb-first (needs a verb and a metadata subcommand)`);
        continue;
      }
      if (FORBIDDEN_BARE.includes(cmd.replace(/\*+$/, ""))) {
        misshapen.push(`${cmd}: bare tool invocation, not a scoped introspection verb`);
      }
      if (INTROSPECTION_MUTATION_SUBCOMMANDS.includes(tokens[1])) {
        misshapen.push(`${cmd}: ${tokens[1]} carries a build/run/mutation side effect`);
      }
    }
    expect(misshapen).toEqual([]);
  });

  it("states the read-only introspection class rule in the role instructions", () => {
    // Prose wraps across lines, so normalize whitespace before matching the rule.
    const flat = analyzer.replace(/\s+/g, " ");
    expect(flat).toMatch(/read-only introspection/i);
    expect(flat).toContain("no build, run, or mutation side effect");
  });

  it("adds no speculative ecosystem metadata verb beyond the class member", () => {
    const offenders = SPECULATIVE_INTROSPECTION_COMMANDS.filter((cmd) => patterns.get(cmd) === "allow");
    expect(offenders).toEqual([]);
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

describe("temp-scoped removal grant", () => {
  it("holds exactly the temp-scoped removal allow for the implementation role", () => {
    const artisan = new Map(bashEntries(readAgent("artisan.md")).map((e) => [e.pattern, e.mode]));
    expect(artisan.get("rm /tmp/opencode/*")).toBe("allow");
    expect(artisan.get("rm*")).toBe("ask");
  });

  it("holds no unscoped removal allow in any agent file", () => {
    const offenders = [];
    for (const f of agentFiles()) {
      for (const e of bashEntries(readAgent(f))) {
        if (e.pattern === "rm*" && e.mode === "allow") {
          offenders.push(`${f}: rm* allow`);
        }
      }
    }
    expect(offenders).toEqual([]);
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

describe("planning shape and scribe composition discipline", () => {
  const scribe = readAgent("scribe.md");

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

describe("local-contract guardrail", () => {
  it("states the local contract in the implementation and testing docs", () => {
    const artisan = readAgent("artisan.md");
    const testing = readFileSync(join(ROOT, "skills", "testing-skill", "SKILL.md"), "utf8");
    for (const content of [artisan, testing]) {
      expect(content).toContain("local contract");
    }
  });

  it("keeps the commit convention docs-only with an unchanged hook", () => {
    expect(readAgent("artisan.md")).toContain("Commit messages");
    const hook = readRoot(".githooks/pre-commit");
    expect(hook).toContain("npx vitest run");
    expect(hook).toContain("npx eslint -c eslint.security.config.mjs");
    expect(hook).not.toContain("commit-msg");
    expect(hook).not.toContain("commitlint");
  });

  it("holds the prose scope without the dead commands glob", () => {
    const config = readRoot("eslint.security.config.mjs");
    for (const surface of ["agents/**/*.md", "skills/**/*.md", "AGENTS.md"]) {
      expect(config).toContain(surface);
    }
    expect(config).not.toContain("commands/");
  });
});

// Consolidation home for the removed audit-fix suite's short-term channel
// group: the bare memory_note name is the compaction-resume path, so its
// registration name, skill wording, and prompt-wide absence of the prefixed
// form stay pinned here while the behavioral half lives with the
// knowledge-gate suite.
describe("short-term memory bare channel", () => {
  function readResumeSkill() {
    return readFileSync(join(ROOT, "skills", "resume-protocol", "SKILL.md"), "utf8");
  }

  function readKnowledgeGateSource() {
    return readFileSync(join(ROOT, "plugins", "knowledge-gate", "index.js"), "utf8");
  }

  function markdownFilesRecursive(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...markdownFilesRecursive(full));
      else if (entry.name.endsWith(".md")) out.push(full);
    }
    return out;
  }

  it("states the bare write invocation in the resume skill", () => {
    const skill = readResumeSkill();
    const section = skill.slice(skill.indexOf("### Short-Term Layer"));
    expect(section).toContain("memory_note");
    expect(section).toContain("tools.memory_note");
  });

  it("carries the bare invocation in the write channel descriptions", () => {
    const source = readKnowledgeGateSource();
    const occurrences = source.split("tools.memory_note").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("keeps prompts and sources free of the prefixed channel name", () => {
    const offenders = [];
    const targets = [
      ...markdownFilesRecursive(join(ROOT, "agents")),
      ...markdownFilesRecursive(join(ROOT, "skills")),
      join(ROOT, "plugins", "knowledge-gate", "index.js"),
    ];
    for (const file of targets) {
      if (readFileSync(file, "utf8").includes("default.memory_note")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("grants the implementation role the bare memory channel", () => {
    expect(readAgent("artisan.md")).toContain("- action: memory_note");
  });
});

// The delete channel is scoped to short-term notes only: ownership rules
// live with the knowledge-gate suite, this pins the blast radius of the
// handler itself.
describe("short-term note deletion scope", () => {
  it("bounds the note-delete channel to short-term notes", () => {
    const source = readFileSync(join(ROOT, "plugins", "knowledge-gate", "index.js"), "utf8");
    const deleteSection = source.slice(source.indexOf('if (toolID === "memory_note_delete")'));
    expect(deleteSection).toContain("short-term");
    expect(deleteSection).not.toContain("byproduct");
    expect(deleteSection).not.toContain("/tmp/opencode");
  });
});

// Verification verbs stay routed to the role that owns them: doc-lint and
// format-check verbs never landed as grants, the dependency scan sits with
// the reviewer, supply-chain mutation is denied everywhere, and the ignore
// probe stays with the read roles.
describe("verification verb routing", () => {
  const DOC_LINT_PATTERN = "make lint-docs*";
  const FORMAT_CHECK_PATTERN = "make fmt-check*";
  const REVIEW_SCAN_PATTERN = "cargo audit*";
  const SUPPLY_MUTATION_PATTERN = "cargo update*";
  const IGNORE_PROBE_PATTERN = "git check-ignore*";
  const READ_ROLE_FILES = ["analyzer.md", "explorer.md", "inspector.md"];

  function shellAllows(content) {
    return permissionRules(content).filter((r) => r.action === "shell" && r.effect === "allow");
  }

  it("leaves doc-lint and format-check verbs ungranted", () => {
    const offenders = [];
    for (const file of agentFiles()) {
      const content = readAgent(file);
      for (const rule of shellAllows(content)) {
        if (rule.resource === DOC_LINT_PATTERN || rule.resource === FORMAT_CHECK_PATTERN) {
          offenders.push(`${file}: ${rule.resource}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the dependency scan with the reviewer role", () => {
    expect(shellAllows(readAgent("artisan.md")).some((r) => r.resource === REVIEW_SCAN_PATTERN)).toBe(false);
    expect(shellAllows(readAgent("inspector.md")).some((r) => r.resource === REVIEW_SCAN_PATTERN)).toBe(true);
  });

  it("leaves supply-chain mutation denied everywhere", () => {
    const offenders = [];
    for (const file of agentFiles()) {
      const content = readAgent(file);
      for (const rule of shellAllows(content)) {
        if (rule.resource === SUPPLY_MUTATION_PATTERN || rule.resource.startsWith("cargo update")) {
          offenders.push(`${file}: ${rule.resource}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the ignore probe with the read roles", () => {
    const holders = agentFiles().filter((file) =>
      shellAllows(readAgent(file)).some((r) => r.resource === IGNORE_PROBE_PATTERN)
    );
    expect(holders.sort()).toEqual(READ_ROLE_FILES);
  });
});

// Dispatch-discipline anchors stay greppable in the overseer delegation docs:
// the fault-recovery pair names the rewrite and escalation rules, the shape
// trio names the dispatch contract, and the tone pair names the phrasing
// contract. Store-number close references stay out so a title-cited issue
// can never resolve to an unrelated store record.
describe("overseer dispatch-discipline anchors", () => {
  it("carries the fault-recovery anchors", () => {
    const overseer = readAgent("overseer.md");
    expect(overseer).toContain("rewrite-dont-stop");
    expect(overseer).toContain("escalate-with-exact-phase");
  });

  it("carries the dispatch-shape and phrasing anchors", () => {
    const overseer = readAgent("overseer.md");
    for (const anchor of ["WHAT-only", "diagnose-first", "cleanup-if-required", "expert-tone", "exact-issue-verbatim"]) {
      expect(overseer).toContain(anchor);
    }
  });

  it("cites issues by title without store-number close references", () => {
    const overseer = readAgent("overseer.md");
    expect(overseer).not.toContain("swarm/11");
    expect(overseer).not.toContain("swarm/12");
  });
});

// Durable prose survives the scribe: lasting decisions live in the body,
// downstream trace stops at its source, and the commit hook stays scoped to
// the suite plus security lint.
describe("composed-docs durability", () => {
  it("states that durable content lives in the composed body", () => {
    expect(readAgent("scribe.md")).toContain("Durable content lives in the body");
  });

  it("honors the source stop-line when composing downstream", () => {
    expect(readAgent("scribe.md")).toContain("Downstream trace stops at the source");
  });

  it("keeps the commit hook scoped to the suite plus security lint", () => {
    const hook = readRoot(".githooks/pre-commit");
    expect(hook).toContain("npx vitest run");
    expect(hook).toContain("npx eslint -c eslint.security.config.mjs");
    expect(hook).not.toContain("knowledge");
  });
});

// The phase gate enforces a tool-id allowlist and advertises the same set back
// to the model. Both surfaces must derive from one table each — TOOL_ALLOWLIST
// for the phase-legal logical tools, TRANSPORT_TOOLS for the carriers
// (`execute` Code Mode, `subagent` delegation) the gate passes through without
// a phase decision of its own. A second in-tree copy of either set, or a
// per-site carve-out, re-opens the advertised-vs-enforced identity split this
// guard closes.
describe("protocol-gate tool-identity single source of truth", () => {
  const PHASE_NAMES = Object.keys(protocolPhases.STATES);

  it("declares the carrier and the delegator as the transport set", () => {
    expect(protocolPhases.TRANSPORT_TOOLS).toContain("execute");
    expect(protocolPhases.TRANSPORT_TOOLS).toContain("subagent");
  });

  it("derives admission from the transport set plus the phase allowlist", () => {
    for (const phase of PHASE_NAMES) {
      const allowed = protocolPhases.TOOL_ALLOWLIST[phase] || [];
      for (const tool of [...allowed, ...protocolPhases.TRANSPORT_TOOLS]) {
        expect(protocolPhases.admitTool(phase, tool), `${phase}:${tool}`).toBe(true);
      }
      // A transport tool is admitted in every phase without a phase decision.
      expect(protocolPhases.admitTool(phase, "execute"), `${phase}:execute`).toBe(true);
      expect(protocolPhases.admitTool(phase, "subagent"), `${phase}:subagent`).toBe(true);
    }
  });

  it("fails closed for a permitted and a forbidden inner tool per phase class", () => {
    // A permitted inner tool reaches the carrier's phase-legal set.
    expect(protocolPhases.admitTool("INTENT", "memory_search")).toBe(true);
    expect(protocolPhases.admitTool("EXPLORE", "memory_search")).toBe(true);
    // A phase-forbidden inner tool is refused rather than silently carried.
    expect(protocolPhases.admitTool("INTENT", "glob")).toBe(false);
    expect(protocolPhases.admitTool("EXPLORE", "read")).toBe(false);
    // An unknown id is refused — the predicate is allowlist-closed.
    expect(protocolPhases.admitTool("INTENT", "frobnicate")).toBe(false);
  });

  it("binds the memory_search advertisement to every phase allowlist", () => {
    const missing = PHASE_NAMES.filter((p) => !(protocolPhases.TOOL_ALLOWLIST[p] || []).includes("memory_search"));
    expect(missing).toEqual([]);
  });

  it("keeps the knowledge-gate memory_search hint emitted for every agent", () => {
    const knowledgeGate = readFileSync(join(ROOT, "plugins", "knowledge-gate", "index.js"), "utf8");
    expect(knowledgeGate).toContain("memory_search tool");
  });

  it("derives every gate decision from the tables — no per-site subagent carve-out", () => {
    const gate = readFileSync(join(ROOT, "plugins", "protocol-gate", "index.js"), "utf8");
    expect(gate).toContain("TRANSPORT_TOOLS");
    expect(gate).toContain("admitTool");
    // The three admission sites (permission.ask, tool.execute.before,
    // tool.definition) and the context adapter no longer branch on a literal
    // subagent comparison.
    expect(gate).not.toContain(`tool !== "subagent" && !allowedTools.includes(tool)`);
    expect(gate).not.toContain(`if (toolID === "subagent") return;`);
    expect(gate).not.toContain(`canonicalToolName(toolID) === "subagent"`);
  });
});

// The INTENT stop-edit boundary (swarm/57) has a behavioural half the plugin
// owns and a compliance half owned by the Overseer's own instructions. The
// boundary refusal points the agent at the recovery; these guards keep both
// halves greppable as prose and source drift — the three overseer section
// headings that carry the advance/stop rules, and the boundary-specific
// refusal text distinct from the generic wrong-phase message.
describe("INTENT stop-edit boundary (swarm/57)", () => {
  it("keeps the swarm/57 instruction sections in the overseer definition", () => {
    const overseer = readAgent("overseer.md");
    for (const heading of ["### Phase Transition Rules", "### Failure Handling", "### Dispatch Discipline"]) {
      expect(overseer, `overseer.md must carry the ${heading} section`).toContain(heading);
    }
  });

  it("raises a boundary-specific refusal naming the phase and the /phase INTENT recovery", () => {
    const gate = readFileSync(join(ROOT, "plugins", "protocol-gate", "index.js"), "utf8");
    expect(gate).toContain("INTENT BOUNDARY CLOSED");
    expect(gate).toContain("INTENT_BOUNDARY_CLOSED");
    expect(gate).toContain("/phase INTENT");
  });

  it("keeps the presence-based INTENT advance — the first intent-KD write is the boundary", () => {
    const gate = readFileSync(join(ROOT, "plugins", "protocol-gate", "index.js"), "utf8");
    // The non-override branch keeps the presence exemption: a session-matching
    // intent KD advances regardless of mtime. Reintroducing a freshness gate
    // here would re-open the write→stop stall the advance was added to close.
    expect(gate).toContain("presence exemption (a session-matching intent KD advances regardless of");
  });
});

// The working-directory boundary: the swarm configuration carries no
// OS-specific or literal external path prefix, and every role keeps a blanket
// external-directory deny. The scan is grant-shaped and covers the agent
// permission blocks, the plugin sources and templates, the suites (bar this
// guard file, which hosts the predicate along with its injected negative
// fixtures), and the ground rules. Runtime transcripts under plugins/logs are
// excluded — they are log output, not configuration.
describe("working-directory boundary (no external literals)", () => {
  const SURFACE_SKIP = [join(ROOT, "plugins", "logs"), join(ROOT, "tests", "config-guard.test.js")];

  function surfaceFiles() {
    return [
      ...agentFiles().map((f) => join(AGENTS_DIR, f)),
      join(ROOT, "AGENTS.md"),
      ...sourceFilesRecursive(join(ROOT, "plugins"), [".js", ".json", ".md"], SURFACE_SKIP),
      ...sourceFilesRecursive(join(ROOT, "tests"), [".js", ".json"], SURFACE_SKIP),
    ];
  }

  it("keeps the boundary predicate catch the external grant shapes", () => {
    expect(hasExternalLiteral('    resource: "~/.local/share/opencode/log/*"')).toBe(true);
    expect(hasExternalLiteral('    resource: "/tmp/opencode/*"')).toBe(true);
    expect(hasExternalLiteral('{ "external_directory": { "~/.local/share/opencode/log/*": "allow" } }')).toBe(true);
    expect(hasExternalLiteral('    resource: "plugins/logs/**"')).toBe(false);
    expect(hasExternalLiteral('    expect(x).not.toContain("/tmp/opencode")')).toBe(false);
  });

  it("carries no external path literal outside the enumerated exception", () => {
    const offenders = [];
    for (const file of surfaceFiles()) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (!hasExternalLiteral(line)) return;
        if (EXTERNAL_LITERAL_EXCEPTIONS.some((ex) => line.includes(ex))) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("enumerates the single pre-existing artisan exception verbatim", () => {
    expect(EXTERNAL_LITERAL_EXCEPTIONS.length).toBeLessThanOrEqual(1);
    const artisan = readAgent("artisan.md");
    for (const ex of EXTERNAL_LITERAL_EXCEPTIONS) {
      expect(artisan, "the enumerated exception must name the artisan block verbatim").toContain(ex);
    }
  });

  it("keeps a blanket external-directory deny with no allow in any role", () => {
    const offenders = [];
    for (const f of agentFiles()) {
      const ext = actionEntries(readAgent(f), "external_directory");
      if (!ext.some((e) => e.pattern === "*" && e.mode === "deny")) {
        offenders.push(`${f}: missing external_directory "*" deny`);
      }
      for (const e of ext) {
        if (e.mode === "allow") offenders.push(`${f}: external allow ${e.pattern}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(agentFiles()).toHaveLength(10);
  });

  it("leaves the Overseer docs-only scope unchanged", () => {
    const overseer = readAgent("overseer.md");
    const readAllows = actionEntries(overseer, "read").filter((e) => e.mode === "allow").map((e) => e.pattern);
    const globAllows = actionEntries(overseer, "glob").filter((e) => e.mode === "allow").map((e) => e.pattern);
    expect(globAllows).toEqual(["knowledge/*.md", "knowledge/impl-*.md", "knowledge/checkpoint-*.md"]);
    for (const p of [...readAllows, ...globAllows]) {
      expect(p.startsWith("knowledge/"), `${p} must stay in the docs scope`).toBe(true);
    }
    expect(overseerScopeFindings(overseer)).toEqual([]);
  });

  it("redirects external evidence requests to workspace-local targets in the ground rules", () => {
    const groundRules = readRoot("AGENTS.md");
    expect(groundRules).toContain("plugins/logs/");
    expect(groundRules).toMatch(/workspace-local/);
    expect(groundRules).toMatch(/working directory/);
  });
});

// The advertised-vs-granted seam (A2): the phase layer advertises a tool by
// NAME while the acting agent's permission block grants it by RESOURCE SCOPE.
// The two derivations live in different files, so nothing but a guard keeps
// them in step — a phase that lists a resource-scoped tool must advertise that
// scope through TOOL_RESTRICTIONS, and the advertised scope must match what the
// agent is actually granted. The Overseer's docs-only glob reach is the
// by-design limit this binds; widening the grant to satisfy the advertisement
// is the failure mode, not the remedy.
const OVERSEER_GLOB_PHASES = Object.keys(protocolPhases.STATES).filter((p) =>
  (protocolPhases.TOOL_ALLOWLIST[p] || []).includes("glob")
);

function overseerGlobGrantPatterns() {
  return actionEntries(readAgent("overseer.md"), "glob")
    .filter((e) => e.mode === "allow")
    .map((e) => e.pattern);
}

// The resource tokens an advertised scope names. The binding reads the paths
// back out of the advertisement text instead of trusting its prose, so a
// dropped pattern and a widened one are both visible: the text carries no other
// dotted token, which makes the extraction unambiguous.
function advertisedScopeTokens(text) {
  return [...new Set(text.match(/[-A-Za-z0-9_.*\/]+\.[A-Za-z0-9]+/g) || [])].sort();
}

// Scope-level comparison of an advertised restriction table against a grant.
// Empty means every phase that advertises glob names exactly the granted
// resource set; a missing entry, a dropped pattern, or an extra one is drift.
function globScopeFindings(restrictions, grantPatterns) {
  const findings = [];
  const granted = [...grantPatterns].sort().join(", ");
  for (const phase of OVERSEER_GLOB_PHASES) {
    const advertised = restrictions[phase]?.glob;
    if (typeof advertised !== "string" || advertised.length === 0) {
      findings.push(`${phase}: glob is advertised with no scope`);
      continue;
    }
    const tokens = advertisedScopeTokens(advertised).sort().join(", ");
    if (tokens !== granted) {
      findings.push(`${phase}: advertised "${tokens}" != granted "${granted}"`);
    }
  }
  return findings;
}

describe("advertised-vs-granted seam — Overseer glob scope (A2)", () => {
  it("carries a glob restriction entry in every phase that advertises glob", () => {
    // Coverage, not mere presence: a partial table re-creates the asymmetry
    // that opened the seam. glob is listed everywhere except INTENT and REPORT,
    // where the tool is blocked outright and no scope is advertised.
    expect(OVERSEER_GLOB_PHASES).toHaveLength(10);
    expect(OVERSEER_GLOB_PHASES).not.toContain("INTENT");
    expect(OVERSEER_GLOB_PHASES).not.toContain("REPORT");
    const missing = OVERSEER_GLOB_PHASES.filter(
      (p) => typeof protocolPhases.TOOL_RESTRICTIONS[p]?.glob !== "string"
    );
    expect(missing).toEqual([]);
  });

  it("binds the advertised glob scope to the Overseer's granted glob scope", () => {
    const granted = overseerGlobGrantPatterns();
    expect(granted).toEqual(["knowledge/*.md", "knowledge/impl-*.md", "knowledge/checkpoint-*.md"]);
    expect(globScopeFindings(protocolPhases.TOOL_RESTRICTIONS, granted)).toEqual([]);
  });

  it("fails closed when an advertised scope drops, widens, or omits a granted pattern", () => {
    const granted = overseerGlobGrantPatterns();
    const live = protocolPhases.TOOL_RESTRICTIONS;
    const withSwarmGlob = (text) => ({ ...live, SWARM: { ...live.SWARM, glob: text } });
    // Advertised narrower than granted (a dropped pattern).
    expect(globScopeFindings(withSwarmGlob("ONLY knowledge/*.md — docs-scoped"), granted)).not.toEqual([]);
    // Advertised wider than granted (an extra resource).
    expect(
      globScopeFindings(
        withSwarmGlob("ONLY knowledge/*.md, knowledge/impl-*.md, knowledge/checkpoint-*.md, src/*.ts — docs-scoped"),
        granted
      )
    ).not.toEqual([]);
    // No entry at all for a glob-advertising phase.
    expect(globScopeFindings({ ...live, SWARM: { read: "ONLY milestone registry KDs" } }, granted)).not.toEqual([]);
    // The grant narrowed without the advertisement following.
    expect(
      globScopeFindings(live, granted.filter((p) => p !== "knowledge/checkpoint-*.md"))
    ).not.toEqual([]);
  });

  it("advertises an allowed tool's scope through the generic restriction path", () => {
    // No per-tool branch: an allowlisted glob picks up its entry through the
    // same lookup read already uses, so a scope entry needs no index.js edit.
    const gate = readFileSync(join(ROOT, "plugins", "protocol-gate", "index.js"), "utf8");
    expect(gate).toContain("TOOL_RESTRICTIONS[phaseName]?.[toolID]");
    expect(gate).toContain("phase restriction: ${restriction}");
  });

  it("keeps the Overseer docs-only scope and its watchdog unchanged", () => {
    // The seam closes on the advertisement side; the grant itself stands.
    expect(overseerScopeFindings(readAgent("overseer.md"))).toEqual([]);
    expect(overseerGlobGrantPatterns()).toEqual([
      "knowledge/*.md",
      "knowledge/impl-*.md",
      "knowledge/checkpoint-*.md",
    ]);
  });
});
