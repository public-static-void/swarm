import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "fs";
import { spawnSync } from "node:child_process";
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

// The retired prompt-level resume field. A prohibition has to name what it
// forbids, so the literal lives in this pin and nowhere else on the
// configuration surface: the handle travels as the subagent call's
// `sessionID` argument, and a prompt field re-taught in any layer is the
// regression this regex catches.
const RETIRED_RESUME_FIELD = /\bTASK ID\b|\btask_id\b/;

function readRoot(name) {
  return readFileSync(join(ROOT, name), "utf8");
}

function agentFiles() {
  return readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
}

function readAgent(name) {
  return readFileSync(join(AGENTS_DIR, name), "utf8");
}

// The rendered body of a delegation-gate template. Parsed, never raw-matched:
// the JSON string is escaped, so a raw match against the file would pass on an
// escape change while the dispatch the Inspector receives said something else.
function renderedTemplate(name) {
  return JSON.parse(readRoot(join("plugins", "delegation-gate", "templates", `${name}.json`))).template;
}

// The in-code fallback body for one mode. `defaultTemplates` is local to
// `loadTemplates`, so the entry is sliced out of the plugin source and decoded
// as the JSON string literal it is.
function defaultTemplateBody(mode) {
  const source = readRoot(join("plugins", "delegation-gate", "index.js"));
  const blockStart = source.indexOf("const defaultTemplates = {");
  const block = source.slice(blockStart, source.indexOf("};", blockStart));
  const entry = block.match(new RegExp(`^\\s{4}${mode}:\\s*("(?:[^"\\\\]|\\\\.)*")`, "m"));
  return entry ? JSON.parse(entry[1]) : "";
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

// Metadata-family shell grants: the resource strings of every shell grant whose
// second whitespace token (the target subcommand, wildcard stripped) is a member
// of the declared family. The helper reads the same ordered grants the role
// holds, so membership is decided by the grant itself and never by a prose
// mention.
function metadataFamilyGrants(content, family) {
  const out = [];
  for (const { pattern } of bashEntries(content)) {
    const tokens = pattern.replace(/\*+$/, "").split(" ").filter(Boolean);
    if (tokens.length > 1 && family.includes(tokens[1])) out.push(pattern);
  }
  return out;
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

// Prose body of a role definition: everything after the leading metadata
// region's closing fence. The class rule lives here, so a member literal in
// this region would restate membership the ordered grants already carry.
function bodyRegion(content) {
  const region = frontmatterRegion(content);
  if (!region) return content;
  return content.split("\n").slice(region.end + 1).join("\n");
}

// The member literals whose membership the ordered grants carry: each pinned
// entry with its trailing wildcard stripped, so a prose mention is caught with
// or without the wildcard.
function introspectionMemberLiterals() {
  return ANALYZER_INTROSPECTION_COMMANDS.map((cmd) => cmd.replace(/\*+$/, ""));
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
const COMMITTER_LIST_COMMANDS = ["ls*", "git ls-files*"];
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
// with no build, run, or mutation side effect. The pinned list below carries the
// members; the class rule in the role instructions carries the generality, so a
// future workspace ecosystem's metadata verb joins this pinned list rather than
// being added speculatively.
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
// The declared finite set of target-subcommand tokens that make a shell grant
// metadata-family-shaped. The granted-to-pinned predicate decides only inside
// this set, so a metadata-shaped verb under a name outside it is not decided
// here; the speculative-list check above covers the deliberately ungranted set.
const INTROSPECTION_METADATA_FAMILY = ["metadata", "ls", "info", "describe"];
// The boundary rule this suite keeps: frontmatter is data; body is prose; tests
// are the enforcement home. Each clause names the assertion that backs it, so a
// clause left without a live predicate shows up as a dangling name.
const BOUNDARY_RULE = {
  "frontmatter is data": "keeps agent metadata blocks free of comment lines",
  "body is prose": "states the class rule without naming a member",
  "tests enforce membership": "pins every metadata-family grant or declares it speculative",
};
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

  it("requires disk-tool evidence in the AC template", () => {
    const acSection = skill.slice(skill.indexOf("## Acceptance Criteria"));
    const tools = ["`read`", "`glob`", "`grep`"].filter((t) => acSection.includes(t));
    expect(tools.length).toBeGreaterThanOrEqual(2);
    // Staging guidance belongs to the Committer that stages: the template's
    // acceptance section carries the disk-verification rule alone.
    expect(acSection).not.toMatch(/stage/i);
  });

  it("requires no git-diff or staged-state evidence in the AC template", () => {
    const acSection = skill.slice(skill.indexOf("## Acceptance Criteria"));
    expect(acSection).not.toContain("git diff");
    expect(acSection).not.toContain("staged");
  });

  it("keeps the post-AC template sections free of git-state evidence", () => {
    // The AC slice spans to end of file, so the sections added after it are
    // read by the same guard; a git-state token in either one reddens it.
    const postAc = skill.slice(
      skill.indexOf("## Verification Methods"),
      skill.indexOf("## Open Questions")
    );
    expect(postAc).not.toContain("git diff");
    expect(postAc).not.toContain("staged");
  });

  it("keeps knowledge/ gitignored in .gitignore", () => {
    expect(gitignore.split("\n")).toContain("knowledge/");
  });
});

// The SPEC template shapes the artifact the Spec Weaver writes, so the template
// section set and the body order the producing protocol declares are one
// contract with two on-disk homes. A section the protocol requires without a
// template home is dropped in practice; a template section the protocol never
// assembles has no producer. Both sides are read from disk and compared, so a
// drop on either side reddens.
const SPEC_SECTION_ORDER = [
  "Overview",
  "Check Alignment",
  "Functional Requirements",
  "Non-Functional Requirements",
  "Interface Contracts",
  "Acceptance Criteria",
  "Verification Methods",
  "Edge Cases & Failure Modes",
  "Open Questions",
  "Process Friction",
];

// Level-two headings in document order. The template's first heading is the
// level-one title, so only `##` sections enter the shape.
function markdownSections(content) {
  return [...content.matchAll(/^## +(.+?)\s*$/gm)].map((m) => m[1]);
}

// The section order the producing protocol declares, read from the sentence
// that names it, so the guard follows the shipped contract rather than a second
// hand-maintained list.
function declaredSpecSections(weaver) {
  const marker = "Assemble the SPEC KD body in this order:";
  const line = weaver.split("\n").find((l) => l.includes(marker));
  if (!line) return [];
  return line
    .slice(line.indexOf(marker) + marker.length)
    .trim()
    .replace(/\.$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Two-way section-set comparison: a section one side carries and the other
// omits is a drop, and a reordering of the shared set is drift.
function specSectionDrift(actual, required) {
  const shared = actual.filter((s) => required.includes(s));
  return {
    missing: required.filter((s) => !actual.includes(s)),
    extra: actual.filter((s) => !required.includes(s)),
    misordered: shared.join(" | ") !== required.join(" | "),
  };
}

describe("SPEC template and protocol section conformance", () => {
  const template = readRoot(join("skills", "template-spec", "SKILL.md"));
  const weaver = readAgent("spec-weaver.md");
  const templateSections = markdownSections(template);
  const declaredSections = declaredSpecSections(weaver);

  it("declares the required section order in the producing protocol", () => {
    expect(declaredSections).toEqual(SPEC_SECTION_ORDER);
  });

  it("shapes the template to the declared sections in order", () => {
    expect(templateSections).toEqual(SPEC_SECTION_ORDER);
    expect(specSectionDrift(templateSections, declaredSections)).toEqual({
      missing: [],
      extra: [],
      misordered: false,
    });
  });

  it("places the alignment section ahead of the requirements", () => {
    const alignment = templateSections.indexOf("Check Alignment");
    expect(alignment).toBeGreaterThan(templateSections.indexOf("Overview"));
    expect(alignment).toBeLessThan(templateSections.indexOf("Functional Requirements"));
  });

  it("places the verification and failure sections after the acceptance criteria", () => {
    const ac = templateSections.indexOf("Acceptance Criteria");
    expect(templateSections.indexOf("Verification Methods")).toBe(ac + 1);
    expect(templateSections.indexOf("Edge Cases & Failure Modes")).toBe(ac + 2);
  });

  it("requires a per-requirement observable check in the verification section", () => {
    const section = template.slice(
      template.indexOf("## Verification Methods"),
      template.indexOf("## Edge Cases & Failure Modes")
    );
    expect(section).toMatch(/each functional requirement/i);
    expect(section).toContain("observable check");
  });

  it("states the alignment step once in the producing protocol", () => {
    const normative = weaver.match(/summarize your understanding/gi) || [];
    expect(normative).toHaveLength(1);
  });

  it("keeps the authoring rule with the producing agent, not the template", () => {
    expect(template).not.toContain("Spec-author requirement");
    const principles = weaver.slice(weaver.indexOf("## Principles"), weaver.indexOf("## Constraints"));
    expect(principles).toMatch(/positive framing/i);
    expect(principles).toContain("expected action directly");
  });

  it("fails when either side drops a required section", () => {
    // Injected offenders: a template that loses the alignment section, and a
    // protocol that stops requiring the verification-methods section.
    const templateDropped = templateSections.filter((s) => s !== "Check Alignment");
    expect(specSectionDrift(templateDropped, declaredSections).missing).toEqual(["Check Alignment"]);
    const declaredDropped = declaredSections.filter((s) => s !== "Verification Methods");
    expect(specSectionDrift(templateSections, declaredDropped).extra).toEqual(["Verification Methods"]);
  });

  it("fails on a misordered section set", () => {
    const swapped = [...templateSections];
    const i = swapped.indexOf("Edge Cases & Failure Modes");
    swapped[i] = swapped[i - 1];
    swapped[i - 1] = "Edge Cases & Failure Modes";
    expect(specSectionDrift(swapped, declaredSections).misordered).toBe(true);
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

  it("keeps directory listing and file inventory for the committer", () => {
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
//
// The region's shape is pinned beside its comment purity: a fixed key set and an
// ordered table of action/resource/effect triples. An entry the rules parser
// drops for a missing key otherwise reads everywhere else as an absent rule, so
// a shape defect is named here rather than surfacing as a wrong grant.
const METADATA_KEYS = ["description", "mode", "steps", "request", "permissions"];
const PERMISSION_KEYS = ["action", "resource", "effect"];

// Top-level keys of the leading region, in file order. Indented lines belong to
// the key above them, so a `- action:` entry is never read as a top-level key.
function metadataTopLevelKeys(content) {
  const region = frontmatterRegion(content);
  if (!region) return [];
  const lines = content.split("\n");
  const keys = [];
  for (let i = region.start + 1; i < region.end; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// Declared-key findings for every definition, reported per file so a mutation
// names its offender rather than only shifting a helper's return value.
function metadataKeyFindings(read) {
  const findings = [];
  for (const f of agentFiles()) {
    const keys = metadataTopLevelKeys(read(f));
    if (keys.join(",") !== METADATA_KEYS.join(",")) {
      findings.push(`${f}: ${keys.join(", ") || "(no keys)"}`);
    }
  }
  return findings;
}

// Entries of the `permissions:` block whose key set is not exactly the triple,
// reported as `line: keys`. The block ends at the next top-level key or the
// region's closing fence, so a later document shape is never folded in.
function permissionEntryFindings(content) {
  const region = frontmatterRegion(content);
  if (!region) return ["no leading metadata region"];
  const lines = content.split("\n");
  const blockStart = lines.findIndex(
    (line, i) => i > region.start && i < region.end && /^permissions:\s*$/.test(line)
  );
  if (blockStart === -1) return ["no permissions block"];
  const findings = [];
  let entry = null;
  const flush = () => {
    if (!entry) return;
    const { line, keys } = entry;
    const triple =
      keys.length === PERMISSION_KEYS.length && PERMISSION_KEYS.every((k) => keys.includes(k));
    if (!triple) findings.push(`${line}: ${keys.length ? keys.join("/") : "(no keys)"}`);
    entry = null;
  };
  for (let i = blockStart + 1; i < region.end; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    if (/^\s*-\s/.test(line)) {
      flush();
      entry = { line: i + 1, keys: [] };
    }
    if (!entry) continue;
    const m = line.match(/^\s*(?:-\s*)?([A-Za-z_][\w-]*):/);
    if (m) entry.keys.push(m[1]);
  }
  flush();
  return findings;
}

describe("agent metadata block purity", () => {
  it("reports a comment line injected into the leading metadata region", () => {
    // Non-vacuous: the predicate reports the offender at line 2 of an injected
    // fixture, so the current-tree assertion below rests on observed reporting
    // rather than on an empty result a `return []` regression would preserve.
    const fixture = ["---", "# role rationale in prose", "name: x", "---", "Body."].join("\n");
    expect(metadataCommentOffenders(fixture)).toEqual([2]);
  });

  it("keeps agent metadata blocks free of comment lines", () => {
    const offenders = [];
    for (const f of agentFiles()) {
      for (const line of metadataCommentOffenders(readAgent(f))) {
        offenders.push(`${f}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads a leading metadata region for every agent file", () => {
    // A file whose first line is not `---`, or which lacks a closing fence, has
    // no region, and the purity predicate then returns []. Asserting the region
    // is present keeps such a file reported rather than silently exempt.
    for (const f of agentFiles()) {
      expect(frontmatterRegion(readAgent(f)), `${f} carries a leading metadata region`).not.toBeNull();
    }
  });

  it("carries the five declared keys in every agent file", () => {
    expect(metadataKeyFindings(readAgent)).toEqual([]);
  });

  it("fails when an undeclared key joins the metadata block", () => {
    const content = readAgent("artisan.md");
    const annotated = content.replace(
      /^steps: /m,
      "title: rationale moved out of the body\nsteps: "
    );
    expect(annotated).not.toBe(content);
    const findings = metadataKeyFindings((file) => (file === "artisan.md" ? annotated : readAgent(file)));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("artisan.md");
    expect(findings[0]).toContain("title");
  });

  it("carries only action/resource/effect triples in the permission table", () => {
    const offenders = [];
    for (const f of agentFiles()) {
      for (const finding of permissionEntryFindings(readAgent(f))) {
        offenders.push(`${f}: ${finding}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("fails when a permission entry drops a key", () => {
    const content = readAgent("artisan.md");
    const match = content.match(/  - action: read\n\s*resource: "\*"\n\s*effect: allow\n/);
    expect(match).toBeTruthy();
    const dropped = content.replace(match[0], match[0].replace(/\s*effect: allow\n$/, "\n"));
    expect(dropped).not.toBe(content);
    expect(permissionEntryFindings(dropped)).toHaveLength(1);
  });

  it("fails when a permission entry carries an extra key", () => {
    const content = readAgent("artisan.md");
    const match = content.match(/  - action: read\n\s*resource: "\*"\n\s*effect: allow\n/);
    expect(match).toBeTruthy();
    const extended = content.replace(match[0], match[0].replace(/\n$/, "\n    note: justification\n"));
    expect(extended).not.toBe(content);
    expect(permissionEntryFindings(extended)).toHaveLength(1);
  });
});

// Analyzer read-only workspace introspection (swarm/60): the analyzer holds a
// grant for read-only workspace-introspection verbs — verb-first exact-prefix
// shell entries whose target subcommand reports workspace structure/metadata
// with no build, run, or mutation side effect. The class rule, stated in the
// role instructions, carries the generality; no other ecosystem verb is added
// speculatively.
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

  it("pins every metadata-family grant or declares it speculative", () => {
    // Membership has a single source: the ordered grants and the pinned constant
    // move together, so a member change never requires a prose edit. The
    // predicate decides only inside the declared finite family — a
    // metadata-shaped verb under an undeclared name escapes it, while the
    // speculative-list check covers the deliberately ungranted set.
    const declared = new Set([...ANALYZER_INTROSPECTION_COMMANDS, ...SPECULATIVE_INTROSPECTION_COMMANDS]);
    const unpinned = (content) =>
      metadataFamilyGrants(content, INTROSPECTION_METADATA_FAMILY).filter((grant) => !declared.has(grant));

    expect(unpinned(analyzer)).toEqual([]);

    // Non-vacuous: a grant of a metadata-family verb that is neither pinned nor
    // declared speculative is reported. The fixture is observed reporting before
    // the current-tree assertion above is accepted.
    const fixture = [
      "---",
      "permissions:",
      "  - action: shell",
      '    resource: "ecosystem info*"',
      "    effect: allow",
      "---",
    ].join("\n");
    expect(unpinned(fixture)).toEqual(["ecosystem info*"]);
  });

  it("states the class rule without naming a member", () => {
    // The join rule is stated structurally — a verb-first exact-prefix shell
    // entry whose target subcommand reports workspace structure/metadata with no
    // build, run, or mutation side effect — together with the clause that
    // workspace-introspection claims attribute to a granted verb.
    const body = bodyRegion(analyzer).replace(/\s+/g, " ");
    expect(body).toContain("verb-first exact-prefix");
    expect(body).toContain("no build, run, or mutation side effect");
    expect(body).toContain("granted verb");
    for (const member of introspectionMemberLiterals()) {
      expect(body, `role prose must not name the member ${member}`).not.toContain(member);
    }
  });

  it("keeps the introspection member out of agent prose", () => {
    const offenders = [];
    for (const f of agentFiles()) {
      const body = bodyRegion(readAgent(f));
      for (const member of introspectionMemberLiterals()) {
        if (body.includes(member)) offenders.push(`${f}: ${member}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("confines the introspection member to the grant and the pinned constant", () => {
    // Membership has exactly two on-disk homes: the analyzer's ordered grant and
    // the pinned constant below. Every other surface — role prose and this
    // suite's own comments — stays member-agnostic, so a member change edits the
    // two homes in lockstep and never touches prose.
    const members = introspectionMemberLiterals();
    const mentions = (text) =>
      text.split("\n").filter((line) => members.some((m) => line.includes(m)));

    const grantMentions = mentions(readAgent("analyzer.md"));
    expect(grantMentions).toHaveLength(1);
    expect(grantMentions[0]).toContain("resource:");

    const suiteMentions = mentions(readRoot(join("tests", "config-guard.test.js")));
    expect(suiteMentions).toHaveLength(1);
    expect(suiteMentions[0]).toContain("ANALYZER_INTROSPECTION_COMMANDS");
  });
});

// Boundary rule, clause by clause: frontmatter carries data with no comment line,
// the role body carries the class rule as prose that names no member, and the
// suite carries membership as the pinned constant the granted-to-pinned
// predicate enforces. Each clause maps to the assertion named in BOUNDARY_RULE.
describe("boundary rule — frontmatter is data, body is prose, tests enforce", () => {
  it("states each clause with a backing assertion that exists in the suite", () => {
    const clauses = Object.keys(BOUNDARY_RULE);
    expect(clauses).toEqual(["frontmatter is data", "body is prose", "tests enforce membership"]);
    const suiteSource = readRoot(join("tests", "config-guard.test.js"));
    const dangling = clauses.filter((clause) => !suiteSource.includes(`it("${BOUNDARY_RULE[clause]}"`));
    expect(dangling).toEqual([]);
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

// The read side of the memory family is a grant every agent holds: the
// knowledge-gate advertises memory_search to all agents, so a missing or
// duplicated allow in any definition is a layer disagreement that would only
// surface later as an unexplained absent tool.
describe("memory_search reachability", () => {
  const files = agentFiles();

  function memorySearchAllows(content) {
    return permissionRules(content).filter((r) => r.action === "memory_search" && r.effect === "allow");
  }

  it("grants memory_search exactly once in every agent definition", () => {
    expect(files).toEqual([
      "analyzer.md",
      "artisan.md",
      "committer.md",
      "explorer.md",
      "habit-builder.md",
      "inspector.md",
      "overseer.md",
      "pathfinder.md",
      "scribe.md",
      "spec-weaver.md",
    ]);
    for (const file of files) {
      expect(memorySearchAllows(readAgent(file)), file).toHaveLength(1);
    }
  });

  it("fails when the grant is removed or duplicated", () => {
    const content = readAgent("artisan.md");
    const match = content.match(/- action: memory_search\n\s*resource: [^\n]*\n\s*effect: allow\n/);
    expect(match).toBeTruthy();

    const removed = content.replace(match[0], "");
    expect(removed).not.toBe(content);
    expect(memorySearchAllows(removed)).toHaveLength(0);

    const duplicated = content.replace(match[0], match[0] + match[0]);
    expect(memorySearchAllows(duplicated)).toHaveLength(2);
  });
});

// The issue store belongs to the role that curates it: the Habit Builder writes,
// updates and moves issues, so it is also the one role that reads them. A grant
// in any other definition puts the store's read path outside that role, and the
// knowledge-gate tool admits whichever caller holds the grant — so the narrowing
// is stated in the frontmatter and pinned here.
const ISSUE_READ_HOLDER = "habit-builder.md";

describe("issue_read reachability", () => {
  const files = agentFiles();
  const ISSUE_READ_ALLOW = /- action: issue_read\n\s*resource: [^\n]*\n\s*effect: allow\n/;

  // Expected count per definition: one allow triple in the curating role, no
  // entry at all elsewhere. Reported per file so a mutation names its offender.
  function holderFindings(read) {
    const findings = [];
    for (const file of files) {
      const rules = permissionRules(read(file)).filter((r) => r.action === "issue_read");
      const allows = rules.filter((r) => r.resource === "*" && r.effect === "allow").length;
      if (file === ISSUE_READ_HOLDER) {
        if (allows !== 1) findings.push(`${file}: ${allows} allows, expected 1`);
      } else if (rules.length !== 0) {
        findings.push(`${file}: ${rules.length} issue_read entries, expected 0`);
      }
    }
    return findings;
  }

  it("grants issue_read once, in the role that curates the issue stores", () => {
    expect(files).toEqual([
      "analyzer.md",
      "artisan.md",
      "committer.md",
      "explorer.md",
      "habit-builder.md",
      "inspector.md",
      "overseer.md",
      "pathfinder.md",
      "scribe.md",
      "spec-weaver.md",
    ]);
    expect(holderFindings(readAgent)).toEqual([]);
  });

  it("keeps the single grant inside the custom-tool run ahead of the shell table", () => {
    const offenders = [];
    const rules = permissionRules(readAgent(ISSUE_READ_HOLDER));
    const grant = rules.findIndex((r) => r.action === "issue_read");
    if (grant === -1) {
      offenders.push(`${ISSUE_READ_HOLDER}: no issue_read grant`);
    } else {
      const firstShell = rules.findIndex((r) => r.action === "shell");
      if (firstShell !== -1 && grant > firstShell) {
        offenders.push(`${ISSUE_READ_HOLDER}: issue_read sits after the shell table`);
      }
      const neighbour = rules.at(grant - 1);
      if (!neighbour || !/^(issue|memory)_/.test(neighbour.action)) {
        offenders.push(`${ISSUE_READ_HOLDER}: issue_read does not follow another custom-tool grant`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("fails when the grant is added to another definition", () => {
    const holder = readAgent(ISSUE_READ_HOLDER);
    const match = holder.match(ISSUE_READ_ALLOW);
    expect(match).toBeTruthy();
    const added = readAgent("artisan.md").replace(
      /(  - action: shell\n\s*resource: "\*"\n\s*effect: deny\n)/,
      `${match[0]}$1`
    );
    expect(added).not.toBe(readAgent("artisan.md"));
    expect(holderFindings((file) => (file === "artisan.md" ? added : readAgent(file)))).toEqual([
      "artisan.md: 1 issue_read entries, expected 0",
    ]);
  });

  it("fails when the grant leaves the curating role", () => {
    const holder = readAgent(ISSUE_READ_HOLDER);
    const match = holder.match(ISSUE_READ_ALLOW);
    expect(match).toBeTruthy();
    const removed = holder.replace(match[0], "");
    expect(removed).not.toBe(holder);
    expect(holderFindings((file) => (file === ISSUE_READ_HOLDER ? removed : readAgent(file)))).toEqual([
      `${ISSUE_READ_HOLDER}: 0 allows, expected 1`,
    ]);
  });

  it("fails when the grant is duplicated", () => {
    const holder = readAgent(ISSUE_READ_HOLDER);
    const match = holder.match(ISSUE_READ_ALLOW);
    expect(match).toBeTruthy();
    const duplicated = holder.replace(match[0], match[0] + match[0]);
    expect(holderFindings((file) => (file === ISSUE_READ_HOLDER ? duplicated : readAgent(file)))).toEqual([
      `${ISSUE_READ_HOLDER}: 2 allows, expected 1`,
    ]);
  });

  it("fails when the grant is flipped to deny", () => {
    const holder = readAgent(ISSUE_READ_HOLDER);
    const match = holder.match(ISSUE_READ_ALLOW);
    expect(match).toBeTruthy();
    const flipped = holder.replace(match[0], match[0].replace("effect: allow", "effect: deny"));
    expect(flipped).not.toBe(holder);
    expect(holderFindings((file) => (file === ISSUE_READ_HOLDER ? flipped : readAgent(file)))).toEqual([
      `${ISSUE_READ_HOLDER}: 0 allows, expected 1`,
    ]);
  });

  it("fails when the grant is narrowed to one store record", () => {
    const holder = readAgent(ISSUE_READ_HOLDER);
    const match = holder.match(ISSUE_READ_ALLOW);
    expect(match).toBeTruthy();
    const narrowed = holder.replace(
      match[0],
      match[0].replace('resource: "*"', 'resource: "knowledge/issues/issue-77.md"')
    );
    expect(narrowed).not.toBe(holder);
    expect(holderFindings((file) => (file === ISSUE_READ_HOLDER ? narrowed : readAgent(file)))).toEqual([
      `${ISSUE_READ_HOLDER}: 0 allows, expected 1`,
    ]);
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

  it("embeds no literal brace placeholders in dispatch examples", () => {
    const offenders = [];
    for (const f of files) {
      const content = readAgent(f);
      const fence = /```([\s\S]*?)```/g;
      let m;
      while ((m = fence.exec(content)) !== null) {
        const block = m[1];
        if (!block.includes("task(") && !block.includes("subagent(")) continue;
        const brace = block.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
        if (brace) offenders.push(`${f}: ${brace[0]} inside a dispatch example`);
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

// The overseer's field example is the grammar the dispatcher copies, and the
// delegation-gate extractor is what reads that copy at dispatch time. A KEY
// line the extractor does not recognize is dropped from the rendered dispatch
// without an error, so the example's anchoring and its key set are one contract
// with the shipped alternation. Both sides are read from disk and compared.
//
// The block's column zero sits at the fence's own indentation: Markdown strips
// the fence prefix from the content, so the guard measures indentation relative
// to it rather than to the raw line start.
function fieldExampleLines(markdown) {
  for (const m of markdown.matchAll(/^([ \t]*)```[^\n]*\n([\s\S]*?)^\1```/gm)) {
    const indent = m[1];
    const lines = m[2]
      .split("\n")
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line));
    if (lines.some((line) => /^MODE:\s/.test(line))) return lines;
  }
  return null;
}

// Keys as the example spells them: an uppercase KEY followed by `: `.
function fieldExampleKeys(lines) {
  return lines
    .map((line) => line.match(/^([A-Z][A-Z ]*?):\s/))
    .filter(Boolean)
    .map((m) => m[1]);
}

// The extractor's recognized key alternation, read out of the plugin source so
// the guard follows the shipped grammar instead of a second hand-kept list.
function extractorFieldKeys() {
  const source = readRoot(join("plugins", "delegation-gate", "index.js"));
  const match = source.match(/\((MODE\|MILESTONE\[\. _\]ID\|[^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split("|")
    .map((key) => key.replace(/\[\. _\]/g, " ").trim())
    .filter(Boolean);
}

// Swarm-only recognized field: the dispatcher hint marks it "swarm mode only"
// and the extractor's shared block is mode-agnostic, so its documentation lives
// with the swarm dispatch path rather than in the shared example.
const SWARM_ONLY_FIELDS = ["MILESTONE ID"];

describe("delegation provenance field example", () => {
  const overseer = readAgent("overseer.md");

  it("anchors every KEY line of the field example at column zero", () => {
    const lines = fieldExampleLines(overseer);
    expect(lines, "overseer.md must carry the field example fenced block").toBeTruthy();
    const indented = lines.filter((line) => /^[ \t]+[A-Z][A-Z ]*?:\s/.test(line));
    expect(indented).toEqual([]);
  });

  it("keeps the example key set aligned with the extractor alternation", () => {
    const lines = fieldExampleLines(overseer);
    const exampleKeys = new Set(fieldExampleKeys(lines));
    const extractorKeys = new Set(extractorFieldKeys());
    expect(extractorKeys.size).toBeGreaterThan(0);

    // A copied example line the extractor cannot match renders empty.
    const unrecognized = [...exampleKeys].filter((key) => !extractorKeys.has(key));
    expect(unrecognized).toEqual([]);

    // A recognized shared field the example omits silently drops on copy.
    const undocumented = [...extractorKeys].filter(
      (key) => !exampleKeys.has(key) && !SWARM_ONLY_FIELDS.includes(key)
    );
    expect(undocumented).toEqual([]);
  });

  describe("leading-space provenance", () => {
    let hooks;
    let logDir;
    let priorLogDir;

    beforeAll(async () => {
      priorLogDir = process.env.DELEGATION_GATE_LOG_DIR;
      logDir = mkdtempSync(join(tmpdir(), "provenance-guard-"));
      process.env.DELEGATION_GATE_LOG_DIR = logDir;
      hooks = await pluginModule.server({}, {});
    });

    afterAll(() => {
      if (priorLogDir === undefined) delete process.env.DELEGATION_GATE_LOG_DIR;
      else process.env.DELEGATION_GATE_LOG_DIR = priorLogDir;
      rmSync(logDir, { recursive: true, force: true });
    });

    it("carries provenance values into the rendered dispatch when the lines are indented", async () => {
      // Provenance is optional, so an unextracted line renders as an empty
      // header with no error — the silent drop this case pins.
      const prompt = `DISPATCH TO: committer
MODE: checkpoint
SESSION DATE: 2026-10-19
SESSION ID: ses_abc123
GENERATION: 0
 BASELINE BRANCH: fix/example-branch
 HEAD SHA: 8a6fea9
SCOPE: Checkpoint commit for the provenance guard
RESULT KD: knowledge/checkpoint-provenance-ses_abc123-gen0.md`;

      const output = { args: { prompt, subagent_type: "committer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_abc123", callID: "c1" }, output);
      expect(output.args.prompt).toContain("BASELINE BRANCH: fix/example-branch");
      expect(output.args.prompt).toContain("HEAD SHA: 8a6fea9");
    });

    it("states the swarm-only scope of the exempt field in the dispatcher hint", async () => {
      // The guard exempts MILESTONE ID from the shared mode-agnostic example on
      // the ground that the dispatcher hint marks it swarm-only, so the hint is
      // where that exemption is anchored.
      const output = { description: "Delegate work to another agent." };
      await hooks["tool.definition"]({ toolID: "task" }, output);
      expect(output.description).toMatch(/MILESTONE ID:[^\n]*swarm mode only/);
    });

    it("keeps the swarm dispatch contract intact for an indented milestone field", async () => {
      const prompt = `DISPATCH TO: artisan
MODE: swarm
 MILESTONE ID: M3
INTENT KD: knowledge/intent-example-ses_abc123-gen0.md
SESSION DATE: 2026-10-19
SESSION ID: ses_abc123
GENERATION: 0
SCOPE: Execute milestone M3
RESULT KD: knowledge/impl-M3-example-ses_abc123-gen0.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_abc123", callID: "c2" }, output);
      expect(output.args.prompt).toContain("MILESTONE ID: M3");
      expect(output.args.prompt).toContain("RESULT KD: knowledge/impl-M3-example-ses_abc123-gen0.md");
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

// The retired prose-citation rule. A FAIL used to be said to reopen the rows its
// findings cite, and a FAIL citing none was called MALFORMED; protocol-gate reads
// the frontmatter `reopen_target` field and derives no target from prose. A site
// that still demands citations tells an Inspector to satisfy a rule the gate
// never reads, so the verdict is refused instead of regressing the milestone.
const RETIRED_CITATION_TOKENS = [
  "CITATION MANDATE",
  "MALFORMED",
  "zero milestone citations",
  "reopens exactly the milestone row(s)",
  "Milestone citation",
];

// The retired tokens present in a text, so one predicate drives both the sweep
// and its injection proof. MALFORMED matches as a word: the log record name
// MALFORMED_FAIL is a different string and is not this rule.
function citationOffenders(text) {
  return RETIRED_CITATION_TOKENS.filter((token) =>
    token === "MALFORMED" ? /\bMALFORMED\b/.test(text) : text.includes(token)
  );
}

// The five sites that carried the rule: the three prose layers an agent reads,
// the template the gate renders into every REVIEW dispatch, and the in-code
// fallback the gate renders when the template file is unreadable. The guard
// names exactly these — a sweep of the prose layers alone let the rendered
// mandate survive a template rewrite.
function citationSites() {
  return [
    ["agents/inspector.md", readAgent("inspector.md")],
    ["skills/verification-gates/SKILL.md", readRoot(join("skills", "verification-gates", "SKILL.md"))],
    ["skills/template-review/SKILL.md", readRoot(join("skills", "template-review", "SKILL.md"))],
    ["plugins/delegation-gate/templates/review.json (parsed template)", renderedTemplate("review")],
    ["plugins/delegation-gate/index.js (defaultTemplates.review)", defaultTemplateBody("review")],
  ];
}

// The evidence rule is stated where the matrix is defined and where the gate
// renders it into a dispatch: the gate protocol that owns the traceability
// matrix, and the review template a reviewer fills in. A row is evidence only
// when it carries captured output, so a paraphrase of a result nobody captured
// — and a row leaning on another row's capture — is the drift this catches.
const EVIDENCE_SHAPE_ID = "evidence shape";

const EVIDENCE_SHAPE_FACTS = [
  { token: "the declared command's literal output", pattern: /the declared command's literal output/i },
  { token: "a durable path to the captured artifact", pattern: /a durable path to the captured artifact/i },
  { token: "each row stands alone", pattern: /each row stands alone/i },
];

// The tokens one site carries, matched by the fact's own pattern rather than
// read off the table, so a site that loses a clause reports the clause it lost.
function evidenceShapeTokens(text) {
  return EVIDENCE_SHAPE_FACTS.filter((fact) => fact.pattern.test(text)).map((fact) => fact.token);
}

// The clause sits under the traceability matrix at both sites, so the region
// runs from the matrix heading to the next section: a clause left elsewhere in
// the file cannot keep the site green after its matrix lost it.
function gatesEvidenceClause(content = readRoot(join("skills", "verification-gates", "SKILL.md"))) {
  return sectionBetween(content, "### Traceability Matrix", "### Enforcement Rules");
}

function reviewEvidenceClause(content = readRoot(join("skills", "template-review", "SKILL.md"))) {
  return sectionBetween(content, "### Traceability Matrix", "## Audit");
}

describe("VERIFY evidence shape", () => {
  const inspector = readAgent("inspector.md");
  const gates = readRoot(join("skills", "verification-gates", "SKILL.md"));
  const reviewTemplate = readRoot(join("skills", "template-review", "SKILL.md"));
  const milestonesTemplate = readRoot(join("skills", "template-milestones", "SKILL.md"));

  // The verdict contract a rendered REVIEW dispatch must carry: the field that
  // selects the reopened rows, the refusal it produces, and the recency rule.
  const RENDERED_CONTRACT_TOKENS = ["reopen_target", "REOPEN_TARGET_INVALID", "no-reopen-target", "stale PASS"];

  it("frames VERIFY around REVIEW KD evidence with a single verdict field", () => {
    for (const content of [inspector, gates, reviewTemplate]) {
      expect(content).toContain("traceability matrix");
      expect(content).toContain("full suite");
    }
    expect(reviewTemplate).toContain("verdict: {{PASS | FAIL}}");
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

  // A row's evidence is the run itself: the command's literal output, or a
  // durable path to the capture, and never a summary of a run the row does not
  // hold. Each row stands alone so one unrun command cannot be carried by a
  // sibling row that did run.
  it("makes every traceability row evidence of its own declared command", () => {
    const expected = EVIDENCE_SHAPE_FACTS.map((fact) => fact.token);
    for (const [site, clause] of [
      ["gate protocol matrix", gatesEvidenceClause()],
      ["review template matrix", reviewEvidenceClause()],
    ]) {
      expect(clause, `${site} must carry the traceability matrix`).toContain("| Req ID |");
      expect(evidenceShapeTokens(clause), `${site} must state the whole evidence rule`).toEqual(expected);
    }
  });

  it("reds a matrix whose evidence clause is paraphrased away", () => {
    // The strip is asserted to have landed, so a reworded clause reds on the
    // next line instead of turning this into a no-op.
    const gateClause = gatesEvidenceClause();
    const gateStripped = gateClause.replace(/each row stands alone/i, "each row expounds on the run");
    expect(gateStripped, "the gate matrix must carry the standalone clause to strip").not.toBe(gateClause);
    expect(evidenceShapeTokens(gateStripped)).not.toEqual(EVIDENCE_SHAPE_FACTS.map((fact) => fact.token));

    const reviewClause = reviewEvidenceClause();
    const reviewStripped = reviewClause.replace(
      /the declared command's literal output/i,
      "a summary of the declared command"
    );
    expect(reviewStripped, "the review matrix must carry the literal-output clause to strip").not.toBe(reviewClause);
    expect(evidenceShapeTokens(reviewStripped)).not.toEqual(EVIDENCE_SHAPE_FACTS.map((fact) => fact.token));
  });

  it("refuses a FAIL with an unusable reopen target under the stale-PASS recency rule", () => {
    for (const content of [inspector, gates, reviewTemplate]) {
      expect(content).toContain("REOPEN_TARGET_INVALID");
      expect(content).toMatch(/no-reopen-target/);
      expect(content).toContain("stale PASS");
    }
  });

  it("retires the citation mandate from all five sites that carried it", () => {
    for (const [site, text] of citationSites()) {
      expect(text, `${site} must be readable — an empty read makes the sweep vacuous`).not.toBe("");
      expect(citationOffenders(text), `${site} still carries the retired citation rule`).toEqual([]);
    }
  });

  it("states the reopen_target contract in the template it renders", () => {
    const rendered = renderedTemplate("review");
    for (const token of RENDERED_CONTRACT_TOKENS) {
      expect(rendered, `rendered review template must state: ${token}`).toContain(token);
    }
    // The positive check is not vacuous: the same check rejects a body with the
    // field removed, which is the state the template was in before the repair.
    const withoutField = rendered.replace(/reopen_target/g, "the findings");
    expect(RENDERED_CONTRACT_TOKENS.filter((token) => !withoutField.includes(token))).not.toEqual([]);
  });

  it("fails when any one of the five sites carries a retired token", () => {
    // Each retired token is injected into each site one at a time: a fixture
    // that only reddens one site would leave the other four unguarded.
    for (const [site, text] of citationSites()) {
      for (const token of RETIRED_CITATION_TOKENS) {
        expect(citationOffenders(`${text}\n${token}`), `${site} must redden on an injected ${token}`).not.toEqual([]);
      }
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

// The rules layer reaches its audience by injection — an agent definition to
// that agent alone, a skill at the moment an agent loads it, AGENTS.md to every
// agent. The reader does not open a sibling file at runtime, so a layer that
// points at another layer strands the rule its reader never loads. Each layer
// states its rule whole; this group fails on a pointer to another file or a
// truncated statement.
describe("rule layers state their rules self-containedly", () => {
  // A pointer to a sibling rules-layer file, a section anchor into another
  // document, or a "see <file>" clause. A hit means the layer defers its rule
  // to a file its reader does not load.
  const CROSS_FILE_REFERENCE =
    /agents\/[a-z-]+\.md|skills\/[a-z-]+\/SKILL\.md|§|see\s+`?(?:agents|skills)\//i;

  function headingRegion(content, startHeading, endHeading) {
    const start = content.indexOf(startHeading);
    if (start === -1) return "";
    const end = content.indexOf(endHeading, start + startHeading.length);
    return content.slice(start, end === -1 ? undefined : end);
  }

  function missingFacts(content, facts) {
    return facts.filter((fact) => !content.includes(fact));
  }

  // The Artisan applies the redispatch choice to its own Committer dispatches,
  // so its section carries the reuse-versus-fresh choice itself; the Overseer's
  // section states the same choice for its own dispatches. The handle travels
  // as the subagent call's `sessionID` argument, and the continuity record
  // names the decision rather than the handle value.
  const REDISPATCH_FACTS = [
    "`sessionID`",
    "Reuse the same instance",
    "Start a fresh instance",
    "returned an empty result",
    "exhausted its token budget",
  ];

  // The verdict semantics each loading agent needs: the erroneous-verdict
  // posture, the refused-target malform, and the stale-PASS recency rule.
  const VERDICT_FACTS = ["reopen_target", "REOPEN_TARGET_INVALID", "stale PASS"];

  // The failure classes a resume can produce, and the recovery each one calls
  // for. A dispatch failure used to be taught as one class — a dead handle — so
  // a correct handle that failed on agent resolution or a quota gate read as
  // lost context. Every layer that teaches recovery states all three branches
  // itself: the dispatcher acts at the moment its dispatch fails, with no
  // sibling file in hand.
  const RESUME_CLASS_FACTS = ["session-not-found", "agent-resolution", "quota-denied"];

  function resumeFallbackSites() {
    return [
      ["artisan redispatch", artisanRedispatch],
      ["overseer redispatch", overseerRedispatch],
      ["swarm template (parsed template)", renderedTemplate("swarm")],
    ];
  }

  function missingResumeClasses(text) {
    return RESUME_CLASS_FACTS.filter((failureClass) => !text.includes(failureClass));
  }

  const artisanRedispatch = headingRegion(
    readAgent("artisan.md"),
    "### Same-Instance Redispatch",
    "\n### "
  );
  const overseerRedispatch = headingRegion(
    readAgent("overseer.md"),
    "### Redispatch Preference Rules",
    "\n### "
  );
  const gatesVerdicts = headingRegion(
    readRoot(join("skills", "verification-gates", "SKILL.md")),
    "### VERIFY Acceptance Proof",
    "\n## Feedback Loop"
  );
  const reviewVerdicts = headingRegion(
    readRoot(join("skills", "template-review", "SKILL.md")),
    "## Verdict",
    "\n## Review Findings"
  );

  it("states the redispatch choice on the live channel in the Artisan layer", () => {
    expect(artisanRedispatch, "artisan.md must carry the Same-Instance Redispatch section").not.toBe("");
    expect(missingFacts(artisanRedispatch, REDISPATCH_FACTS)).toEqual([]);
  });

  it("keeps the retired resume field out of both dispatcher layers", () => {
    expect(overseerRedispatch, "overseer.md must carry the Redispatch Preference Rules section").not.toBe("");
    for (const [layer, text] of [
      ["artisan", artisanRedispatch],
      ["overseer", overseerRedispatch],
    ]) {
      expect(text, `${layer} redispatch section present`).not.toBe("");
      expect(RETIRED_RESUME_FIELD.test(text), `${layer} section names the retired resume field`).toBe(false);
    }
  });

  it("states the verdict semantics in each layer that carries them", () => {
    expect(missingFacts(gatesVerdicts, VERDICT_FACTS)).toEqual([]);
    expect(missingFacts(reviewVerdicts, VERDICT_FACTS)).toEqual([]);
  });

  it("names all three resume failure classes at every fallback site", () => {
    for (const [site, text] of resumeFallbackSites()) {
      expect(text, `${site} must be readable — an empty read makes the sweep vacuous`).not.toBe("");
      expect(missingResumeClasses(text), `${site} must name every resume failure class`).toEqual([]);
      for (const failureClass of RESUME_CLASS_FACTS) {
        expect(text, `${site} must record the decision as fresh: ${failureClass}`).toContain(`fresh: ${failureClass}`);
      }
      expect(text, `${site} must keep the handle value out of the record`).toContain("handle value");
    }
  });

  it("fails when one fallback site drops one resume failure class", () => {
    // Each class is removed from each site one at a time: a fixture that only
    // reddens one site would leave the other two teaching the retired
    // single-class fallback, which is how the drift started.
    for (const [site, text] of resumeFallbackSites()) {
      for (const failureClass of RESUME_CLASS_FACTS) {
        const stripped = text.split(failureClass).join("the failure");
        expect(missingResumeClasses(stripped), `${site} must redden without ${failureClass}`).not.toEqual([]);
      }
    }
  });

  // The closed continuity vocabulary. `same` reuses an instance, `fresh:
  // new-task` covers a first dispatch or a genuinely new task, and one value per
  // failure a re-dispatch recovers from. A four-value set has no legal value for
  // a first dispatch, so the instruction that mandates the record cannot be
  // followed as written; a site that teaches the retired set again is the
  // regression this pins.
  const CONTINUITY_VALUES = [
    "same",
    "fresh: new-task",
    "fresh: session-not-found",
    "fresh: agent-resolution",
    "fresh: quota-denied",
  ];

  // The shape a dispatcher section uses to name the failure-keyed branch. It is
  // a placeholder rather than a value a record carries, so the invented-value
  // check admits it while still rejecting every other `fresh:` spelling.
  const CONTINUITY_SHAPE = "fresh: <class>";

  function continuitySites() {
    return [
      ...resumeFallbackSites(),
      [
        "impl template (Continuity section)",
        headingRegion(readRoot(join("skills", "template-impl", "SKILL.md")), "## Continuity", "\n## "),
      ],
    ];
  }

  // Presence is checked on the backticked spelling: bare "same" is ordinary
  // English and would pass in any paragraph.
  function missingContinuityValues(text) {
    return CONTINUITY_VALUES.filter((value) => !text.includes(`\`${value}\``));
  }

  // Every backticked `fresh:` spelling that is neither a legal value nor the
  // shape placeholder. A record that invents a value cannot be told apart from
  // a legal one, which is what the closed set exists to prevent.
  function inventedFreshValues(text) {
    const legal = new Set([...CONTINUITY_VALUES, CONTINUITY_SHAPE]);
    const spellings = [...text.matchAll(/`fresh: [^`]+`/g)].map((match) => match[0].slice(1, -1));
    return [...new Set(spellings)].filter((spelling) => !legal.has(spelling));
  }

  it("states the closed continuity vocabulary at every site that teaches it", () => {
    const offenders = continuitySites().flatMap(([site, text]) =>
      missingContinuityValues(text).map((value) => `${site} omits ${value}`)
    );
    expect(offenders).toEqual([]);
  });

  it("admits no continuity value outside the closed set", () => {
    for (const [site, text] of continuitySites()) {
      expect(text, `${site} must be readable — an empty read makes the check vacuous`).not.toBe("");
      expect(inventedFreshValues(text), `${site} carries a value outside the closed set`).toEqual([]);
    }
  });

  it("fails when a site keeps the retired continuity vocabulary or invents a value", () => {
    // Both directions per site: dropping the first-dispatch value is the retired
    // set, and an invented class-shaped value is what two records wrote when no
    // legal value existed.
    for (const [site, text] of continuitySites()) {
      const retired = text.split("fresh: new-task").join("");
      expect(missingContinuityValues(retired), `${site} must redden without fresh: new-task`).not.toEqual([]);
      expect(
        inventedFreshValues(`${text}\n\`fresh: new-milestone\``),
        `${site} must redden on an invented continuity value`
      ).not.toEqual([]);
    }
  });

  it("keeps each of the three layers free of cross-file references", () => {
    for (const [layer, text] of [
      ["artisan redispatch", artisanRedispatch],
      ["verification-gates verdicts", gatesVerdicts],
      ["review-template verdicts", reviewVerdicts],
    ]) {
      expect(text, `${layer} section present`).not.toBe("");
      expect(CROSS_FILE_REFERENCE.test(text), `${layer} states its rule without a pointer`).toBe(false);
    }
  });

  it("fails on an injected cross-file reference or a truncated section", () => {
    // Injected offenders: a pointer strands the reader, a truncated section
    // drops the facts its audience needs.
    expect(CROSS_FILE_REFERENCE.test(`${artisanRedispatch}\nSee agents/overseer.md for the contract.`)).toBe(true);
    expect(CROSS_FILE_REFERENCE.test(`${gatesVerdicts}\nThe rules live in agents/inspector.md.`)).toBe(true);
    expect(CROSS_FILE_REFERENCE.test(`${reviewVerdicts}\nSee skills/verification-gates/SKILL.md.`)).toBe(true);
    expect(
      missingFacts("### Same-Instance Redispatch\n\nPass the prior call's `sessionID`.\n", REDISPATCH_FACTS)
    ).not.toEqual([]);
    expect(missingFacts("## Verdict\n\nPASS / FAIL / FUNDAMENTAL\n", VERDICT_FACTS)).not.toEqual([]);
  });

  // A dispatch loads one committer mode skill, so a site that hands its rule to
  // a sibling file strands the reader who loaded this one. The predicate also
  // catches a sibling skill named as the rule's owner, which a path-only match
  // would miss.
  const SIBLING_OWNER_POINTER =
    /agents\/[a-z-]+\.md|skills\/[a-z-]+\/SKILL\.md|§|see\s+`?(?:agents|skills)\/|committer-(?:checkpoint|cleanup|preflight)`?\s+skill|handoff step owns/i;

  // The cleanup convention its loading agent applies: the type table, the
  // scope rule, and the message format.
  const CLEANUP_CONVENTION_FACTS = [
    "| feat",
    "| fix",
    "| style",
    "| refactor",
    "| test",
    "| chore",
    "Scope required if ≥80% of representative commits use scope",
    "imperative present tense",
    "≤72 chars",
    "<type>(<scope>): <description>",
  ];

  // The relay the committer definition's reader runs: capture the hook signal,
  // record it, escalate, retry.
  const COMMITTER_RELAY_FACTS = [
    "exit code",
    "stderr",
    "CHECKPOINT KD friction record",
    "escalate to Artisan",
    "retries",
  ];

  // The staging constraints state their own behavior rather than naming the
  // skill step that carries it.
  const COMMITTER_CONSTRAINT_FACTS = [
    "classify by dominant concern",
    "coherent, independently verifiable change set",
  ];

  const cleanupConvention = headingRegion(
    readRoot(join("skills", "committer-cleanup", "SKILL.md")),
    "## Semantic Commit Convention",
    "\n## Exit"
  );
  const committerPrinciples = headingRegion(readAgent("committer.md"), "## Principles", "\n## Constraints");
  const committerConstraints = headingRegion(readAgent("committer.md"), "## Constraints", "\n## Context Marker");

  it("states the semantic commit convention in the cleanup skill itself", () => {
    expect(cleanupConvention, "committer-cleanup must carry the Semantic Commit Convention section").not.toBe("");
    expect(missingFacts(cleanupConvention, CLEANUP_CONVENTION_FACTS)).toEqual([]);
    expect(SIBLING_OWNER_POINTER.test(cleanupConvention), "cleanup convention states its rule without a pointer").toBe(
      false
    );
  });

  it("states the hook-failure relay whole in the committer definition", () => {
    expect(committerPrinciples, "committer.md must carry a Principles section").not.toBe("");
    expect(missingFacts(committerPrinciples, COMMITTER_RELAY_FACTS)).toEqual([]);
    expect(SIBLING_OWNER_POINTER.test(committerPrinciples), "relay principle states its rule without a pointer").toBe(
      false
    );
  });

  it("states the committer staging constraints without deferring to a skill", () => {
    expect(committerConstraints, "committer.md must carry a Constraints section").not.toBe("");
    expect(missingFacts(committerConstraints, COMMITTER_CONSTRAINT_FACTS)).toEqual([]);
    expect(SIBLING_OWNER_POINTER.test(committerConstraints), "staging constraints state their rule").toBe(false);
  });

  it("fails on an injected sibling-skill pointer or a truncated committer statement", () => {
    // Injected offenders: the pre-rework pointer text for each site, plus
    // statements stripped of the facts their reader needs.
    expect(SIBLING_OWNER_POINTER.test("The convention is owned by the `committer-checkpoint` skill.")).toBe(true);
    expect(SIBLING_OWNER_POINTER.test("The `committer-checkpoint` skill's hook-failure handoff step owns the relay.")).toBe(true);
    expect(SIBLING_OWNER_POINTER.test("Reference the committer-checkpoint skill's concern-separation rule.")).toBe(true);
    expect(missingFacts("## Semantic Commit Convention\n\nUse conventional commits.\n", CLEANUP_CONVENTION_FACTS)).not.toEqual([]);
    expect(missingFacts("## Principles\n\n- **Hook-failure relay**: escalate when a hook fails.\n", COMMITTER_RELAY_FACTS)).not.toEqual([]);
    expect(missingFacts("## Constraints\n\n- Stage the files this task changed.\n", COMMITTER_CONSTRAINT_FACTS)).not.toEqual([]);
  });

  // The auto-injected rule layers every agent's rule arrives in: AGENTS.md, each
  // agent definition, and each skill. A rule reaches its audience by injection,
  // so each file states its rules whole rather than handing them to a sibling
  // config file the reader would have to open.
  function sweptLayerFiles() {
    const skillFiles = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(ROOT, "skills", entry.name, "SKILL.md"))
      .filter((path) => existsSync(path));
    return [join(ROOT, "AGENTS.md"), ...agentFiles().map((name) => join(AGENTS_DIR, name)), ...skillFiles];
  }

  // A rule's authority or home deferred to a sibling config layer: a path into
  // agents/ or skills/, a section anchor, or a "see <sibling> skill for <rule>"
  // clause. A load instruction ("load the <name> skill") and a data path (a KD
  // path or a template file name) name the mechanism or the artifact the reader
  // handles directly, so the predicate leaves them alone.
  const LAYER_DEFERRAL =
    /agents\/[a-z-]+\.md|skills\/[a-z-]+\/SKILL\.md|§|see\s+(?:the\s+)?[a-z]+(?:-[a-z]+)*\s+skill\s+for\b/i;

  it("keeps every swept config layer free of a cross-file rule reference", () => {
    const offenders = sweptLayerFiles().filter((file) => LAYER_DEFERRAL.test(readFileSync(file, "utf8")));
    expect(offenders, "these layers hand their rules to a sibling config file").toEqual([]);
  });

  it("fails on an injected cross-file rule reference or a truncated rule", () => {
    // Offenders: an agent-definition path, a section anchor, and a "see
    // <sibling> skill for <rule>" clause each defer a rule to a file the reader
    // does not load.
    expect(LAYER_DEFERRAL.test("Severity follows the rubric in `agents/habit-builder.md`.")).toBe(true);
    expect(LAYER_DEFERRAL.test("See `agents/inspector.md` §Verdict Rules for the verdicts.")).toBe(true);
    expect(LAYER_DEFERRAL.test("See verification-gates skill for the matrix format.")).toBe(true);
    // Non-offenders: a load instruction and a data path state the mechanism or
    // the artifact, so the predicate leaves them alone.
    expect(LAYER_DEFERRAL.test("Load the escalation-protocol skill and escalate.")).toBe(false);
    expect(LAYER_DEFERRAL.test("Write the KD at `knowledge/impl-M1-x-ses_1-gen0.md`.")).toBe(false);
    expect(LAYER_DEFERRAL.test("Use the `template-checkpoint.md` template from the kd-system skill.")).toBe(false);
    expect(missingFacts("### Step 5: Process Friction\n\n- [ ] Add a friction table.\n", ["low", "medium", "high"]))
      .not.toEqual([]);
  });

  it("states the friction severity scale in the kd-system skill itself", () => {
    const step = headingRegion(
      readRoot(join("skills", "kd-system", "SKILL.md")),
      "### Step 5: Process Friction",
      "\n## Post-Creation Verification"
    );
    expect(step, "kd-system must carry the Process Friction step").not.toBe("");
    expect(missingFacts(step, ["low", "medium", "high"])).toEqual([]);
    expect(LAYER_DEFERRAL.test(step), "severity scale states its rule without a pointer").toBe(false);
  });

  it("states the traceability shape in the code-review skill itself", () => {
    const region = headingRegion(
      readRoot(join("skills", "code-review-skill", "SKILL.md")),
      "### V-Model Traceability",
      "\n### Review Decision Framework"
    );
    expect(region, "code-review-skill must carry the V-Model Traceability section").not.toBe("");
    expect(missingFacts(region, ["Req ID", "Declared Gate", "Actually-Run Gate", "Status"])).toEqual([]);
    expect(LAYER_DEFERRAL.test(region), "traceability shape states its rule without a pointer").toBe(false);
  });
});

// The escalation route names the skill the Overseer reaches for, so the
// instruction and the skill allow list are one contract: an instruction the
// grant does not admit strands the role at the block it is told to handle, and
// a grant with no instruction admits a skill nothing tells the role to load.
// The grant is read from the permission block; the instruction is read from
// the delegation-step section that carries it.
describe("Overseer escalation skill grant", () => {
  const overseer = readAgent("overseer.md");
  const allowedSkills = actionEntries(overseer, "skill")
    .filter((entry) => entry.mode === "allow")
    .map((entry) => entry.pattern);

  function delegationSteps(content) {
    const start = content.indexOf("### Delegation Steps");
    if (start === -1) return "";
    const end = content.indexOf("### Redispatch Preference Rules", start);
    return content.slice(start, end === -1 ? undefined : end);
  }

  it("admits the escalation protocol skill to the Overseer role", () => {
    expect(allowedSkills).toContain("escalation-protocol");
  });

  it("instructs loading that skill with the procedure it reaches for", () => {
    const steps = delegationSteps(overseer);
    expect(steps, "overseer.md must carry the delegation steps").not.toBe("");
    expect(steps).toContain("load the `escalation-protocol` skill");
    expect(steps).toContain("Blocked Path Procedure");
  });

  it("fails on a dropped grant or a pointer that names no skill to load", () => {
    const withoutGrant = allowedSkills.filter((name) => name !== "escalation-protocol");
    expect(withoutGrant).not.toContain("escalation-protocol");
    const pointer =
      "### Delegation Steps\n\n7. **On escalation** — follow the Blocked Path Procedure in the escalation protocol.\n";
    expect(delegationSteps(pointer)).not.toContain("load the `escalation-protocol` skill");
  });
});

// The resume handle travels only as the subagent call's `sessionID` argument.
// Every layer that used to teach a prompt-level resume field now teaches the
// argument instead, and a later edit that reintroduces the field would pass
// every other guard in this file — no template, hint, or section pin reads the
// retired key. This sweep is that pin.
describe("retired prompt-level resume field", () => {
  const TEMPLATES_DIR = join(ROOT, "plugins", "delegation-gate", "templates");

  function sweptSurface() {
    const skillFiles = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(ROOT, "skills", entry.name, "SKILL.md"))
      .filter((path) => existsSync(path));
    const templateFiles = readdirSync(TEMPLATES_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(TEMPLATES_DIR, name));
    return [
      ...agentFiles().map((name) => join(AGENTS_DIR, name)),
      ...skillFiles,
      join(ROOT, "plugins", "delegation-gate", "index.js"),
      ...templateFiles,
    ];
  }

  it("appears nowhere on the configuration surface", () => {
    const offenders = sweptSurface().filter((file) => RETIRED_RESUME_FIELD.test(readFileSync(file, "utf8")));
    expect(offenders, "these files teach the retired prompt-level resume field").toEqual([]);
  });

  it("recognizes each field form a later edit would reintroduce", () => {
    // A predicate that cannot match the old text would make the sweep vacuous.
    for (const line of ["TASK ID: ses_prior_handle", "task_id: ses_prior_handle", "TASK ID: {task_id}"]) {
      expect(RETIRED_RESUME_FIELD.test(line), `unmatched form: ${line}`).toBe(true);
    }
    expect(RETIRED_RESUME_FIELD.test("SESSION ID is the lifecycle session")).toBe(false);
  });
});

describe("inspector rebuild parity and overseer disk-check scope", () => {
  it("carries rebuild-class shell grants for the verifier role", () => {
    const patterns = new Map(bashEntries(readAgent("inspector.md")).map((e) => [e.pattern, e.mode]));
    expect(patterns.get("make build*")).toBe("allow");
    expect(patterns.get("cargo --version*")).toBe("allow");
  });

  it("covers the three artifact families in the overseer glob scope and no others", () => {
    const allows = actionEntries(readAgent("overseer.md"), "glob")
      .filter((e) => e.mode === "allow")
      .map((e) => e.pattern);
    expect(allows).toEqual([
      "knowledge/intent-*.md",
      "knowledge/report-*.md",
      "knowledge/milestones-*.md",
    ]);
    expect(allows).not.toContain("knowledge/*.md");
    expect(allows).not.toContain("knowledge/impl-*.md");
    expect(allows).not.toContain("knowledge/checkpoint-*.md");
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
// probe stays with the holders that verify ignore status as part of their
// remit (the three read roles plus the git-lifecycle agent).
describe("verification verb routing", () => {
  const DOC_LINT_PATTERN = "make lint-docs*";
  const FORMAT_CHECK_PATTERN = "make fmt-check*";
  const REVIEW_SCAN_PATTERN = "cargo audit*";
  const SUPPLY_MUTATION_PATTERN = "cargo update*";
  const IGNORE_PROBE_PATTERN = "git check-ignore*";
  const IGNORE_PROBE_HOLDERS = ["analyzer.md", "committer.md", "explorer.md", "inspector.md"];
  // Reading arbitrary source and echoing text are outside the commit role's
  // remit: source reads belong to a read role, and echo carries no filesystem
  // semantics of its own.
  const COMMITTER_WITHHELD_PATTERNS = ["cat", "echo"];

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

  it("keeps the ignore probe with its holders", () => {
    const holders = agentFiles().filter((file) =>
      shellAllows(readAgent(file)).some((r) => r.resource === IGNORE_PROBE_PATTERN)
    );
    expect(holders.sort()).toEqual(IGNORE_PROBE_HOLDERS);
  });

  it("keeps withheld read and echo verbs off the committer grant", () => {
    const granted = shellAllows(readAgent("committer.md")).map((r) => r.resource);
    const offenders = granted.filter((resource) =>
      COMMITTER_WITHHELD_PATTERNS.some(
        (prefix) => resource.replace(/\*+$/, "") === prefix || resource.startsWith(`${prefix} `)
      )
    );
    expect(offenders).toEqual([]);
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

// The raw-request rule's axis is the kind of message, not its position: a task
// specification addressed to the swarm is copied verbatim, a discussion about
// process becomes its gist, and conduct or status messages are dispositions.
// Every site is read by section marker rather than by line number, so wording
// can move while the guard keeps holding. The issue-text rule (`exact-issue-
// verbatim`) is a different rule and lives outside these sections.
const VERBATIM_DEMAND = /verbatim|word for word|copy exactly/i;
const TASK_SPECIFICATION = /task specification/i;

function rawRequestSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function unqualifiedCopySentences(text) {
  return rawRequestSentences(text).filter(
    (sentence) => VERBATIM_DEMAND.test(sentence) && !TASK_SPECIFICATION.test(sentence)
  );
}

function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  if (!endMarker) return text.slice(start);
  const end = text.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

// The rationale comment immediately above a code anchor. A code anchor can
// repeat in the file, so a `preferMarker` selects the block that names the
// behaviour under guard.
function commentAbove(text, codeMarker, preferMarker) {
  const lines = text.split("\n");
  const isComment = (line) => line.trimStart().startsWith("//");
  const blocks = [];
  for (let anchor = 0; anchor < lines.length; anchor++) {
    if (!lines[anchor].includes(codeMarker)) continue;
    let start = anchor;
    while (start > 0 && isComment(lines[start - 1])) start--;
    const block = lines
      .slice(start, anchor)
      .filter(isComment)
      .map((line) => line.replace(/^\s*\/\/\s?/, ""))
      .join(" ")
      .trim();
    if (block) blocks.push(block);
  }
  if (preferMarker) {
    const preferred = blocks.find((block) => block.includes(preferMarker));
    if (preferred) return preferred;
  }
  return blocks[blocks.length - 1] || "";
}

function protocolGateSource() {
  return readRoot(join("plugins", "protocol-gate", "index.js"));
}

function rawIntentInjectionStrings() {
  return [...protocolGateSource().matchAll(/`(\[Protocol Gate\][^`]*)`/g)].map((match) => match[1]);
}

const RAW_REQUEST_SITES = [
  {
    id: "S1",
    file: "skills/template-intent/SKILL.md",
    text: () =>
      sectionBetween(readRoot(join("skills", "template-intent", "SKILL.md")), "<!-- Template has no decision points", "-->"),
  },
  {
    id: "S2",
    file: "skills/template-intent/SKILL.md",
    text: () =>
      sectionBetween(readRoot(join("skills", "template-intent", "SKILL.md")), "## Raw Request", "## Triage Notes"),
  },
  {
    id: "S3",
    file: "agents/overseer.md",
    text: () => sectionBetween(readAgent("overseer.md"), "### Entry Point", "### Status Surface"),
  },
  {
    id: "S4",
    file: "plugins/protocol-gate/phases.js",
    text: () => protocolPhases.PHASE_INSTRUCTIONS.INTENT,
  },
  {
    id: "S5",
    file: "plugins/protocol-gate/index.js",
    text: () => rawIntentInjectionStrings().find((string) => string.includes("Earliest user message")) || "",
  },
  {
    id: "S6",
    file: "plugins/protocol-gate/index.js",
    text: () =>
      rawIntentInjectionStrings().find((string) => string.includes("[Protocol Gate] Follow-up message")) || "",
  },
];

describe("raw-request discriminator", () => {
  it("states the three classes and the discriminating test at every site", () => {
    for (const site of RAW_REQUEST_SITES) {
      const text = site.text();
      expect(text, `${site.id} not found in ${site.file}`).not.toBe("");
      expect(text, site.id).toMatch(TASK_SPECIFICATION);
      expect(text, site.id).toMatch(/discussion with (?:the Overseer|you) about process|discussion about process/i);
      expect(text, site.id).toContain("Triage Notes");
      expect(text, site.id).toMatch(/disposition/i);
      expect(text, site.id).toContain("would a downstream agent need these exact words to do its job");
    }
  });

  it("demands a copy only inside the task-specification branch", () => {
    for (const site of RAW_REQUEST_SITES) {
      const text = site.text();
      expect(text, site.id).toMatch(VERBATIM_DEMAND);
      expect(unqualifiedCopySentences(text), site.id).toEqual([]);
      expect(text, site.id).not.toContain("Raw user request (verbatim)");
      expect(text, site.id).not.toContain("Do not paraphrase or summarize");
    }
  });

  it("keeps position a tie-breaker and lets a later message become the request", () => {
    for (const site of RAW_REQUEST_SITES) {
      expect(site.text(), site.id).toMatch(/tie-breaker/i);
    }
  });

  it("S7 states the semantic rule and carries no positional copy demand", () => {
    const rationale = commentAbove(protocolGateSource(), "if (phase === STATES.INTENT && sessionID)", "raw-intent injection");
    expect(rationale).not.toBe("");
    expect(rationale).toMatch(TASK_SPECIFICATION);
    expect(rationale).toMatch(/not its position|tie-breaker/i);
    expect(rationale).toContain("Triage Notes");
    expect(rationale).not.toMatch(/only entry 0/i);
    expect(unqualifiedCopySentences(rationale)).toEqual([]);
  });
});

// The issue-text rule is a different rule: a dispatch quotes the triggering
// issue word for word. It and its anchor stay byte-identical, so a global
// verbatim sweep can never be mistaken for the raw-request guard.
describe("issue-text verbatim anchor untouched", () => {
  const ISSUE_TEXT_SENTENCE =
    "Quote the triggering issue in exact-issue-verbatim form and cite it by title rather than number, so the scope carries the requester's words with no store-number close hazard.";

  it("keeps the issue-text sentence byte-identical", () => {
    expect(readAgent("overseer.md")).toContain(ISSUE_TEXT_SENTENCE);
  });

  it("keeps the dispatch-discipline anchor list byte-identical", () => {
    // Read the anchor array out of the guard that owns it, so the expected
    // list below cannot satisfy itself from this file's own text.
    const source = readRoot(join("tests", "config-guard.test.js"));
    const block = sectionBetween(source, 'it("carries the dispatch-shape and phrasing anchors"', "});");
    expect(block).not.toBe("");
    const match = block.match(/for \(const anchor of (\[[^\]]*\])\)/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(
      '["WHAT-only", "diagnose-first", "cleanup-if-required", "expert-tone", "exact-issue-verbatim"]'
    );
  });

  it("scopes the raw-request guard away from the issue-text rule", () => {
    // The sentence carries a verbatim demand and no task-specification token,
    // so only the section scope keeps the raw-request guard off it.
    expect(ISSUE_TEXT_SENTENCE).toMatch(/verbatim/i);
    expect(ISSUE_TEXT_SENTENCE).not.toMatch(TASK_SPECIFICATION);
    for (const site of RAW_REQUEST_SITES) {
      expect(site.text(), site.id).not.toContain("exact-issue-verbatim");
    }
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

// The short-term note family is the durable carrier for in-flight state, and
// the knowledge-gate advertises its resume read to every agent on every call.
// The phase table and the gate's tool contract are separate surfaces, so this
// group binds them: a phase that admits the write but not the read strands the
// note, and a resume hint naming a channel no phase admits strands the agent.
describe("short-term memory family phase legality (swarm/67)", () => {
  const PHASE_NAMES = Object.keys(protocolPhases.STATES);
  const MEMORY_FAMILY = [
    "memory_note",
    "memory_note_read",
    "memory_notes_list",
    "memory_note_delete",
    "memory_search",
  ];

  function readKnowledgeGateSource() {
    return readFileSync(join(ROOT, "plugins", "knowledge-gate", "index.js"), "utf8");
  }

  function phasesMissing(family, allowlist) {
    return PHASE_NAMES.filter((p) => family.some((tool) => !(allowlist[p] || []).includes(tool)));
  }

  it("registers every family member against its schema in the knowledge-gate contract", () => {
    const source = readKnowledgeGateSource();
    const missing = MEMORY_FAMILY.filter((name) => !source.includes(`args: V2_SCHEMAS.${name}`));
    expect(missing).toEqual([]);
  });

  it("admits the whole family in every phase", () => {
    expect(phasesMissing(MEMORY_FAMILY, protocolPhases.TOOL_ALLOWLIST)).toEqual([]);
  });

  it("keeps the resume read phase-legal for the Overseer in every phase", () => {
    const notLegal = PHASE_NAMES.filter((p) => !protocolPhases.admitTool(p, "memory_note_read"));
    expect(notLegal).toEqual([]);
    // The hint names memory_note_read, so the phase table must admit the name
    // the hint instructs the agent to call.
    expect(readKnowledgeGateSource()).toContain("Read them with memory_note_read to resume in-flight state");
  });

  it("keeps SWARM able to write, read, and list a note — the cross-phase carrier", () => {
    for (const tool of ["memory_note", "memory_note_read", "memory_notes_list"]) {
      expect(protocolPhases.TOOL_ALLOWLIST.SWARM).toContain(tool);
    }
  });

  it("fails on the pre-fix state where no phase admitted the family", () => {
    const preFix = Object.fromEntries(
      PHASE_NAMES.map((p) => [p, (protocolPhases.TOOL_ALLOWLIST[p] || []).filter((t) => !MEMORY_FAMILY.includes(t))])
    );
    expect(phasesMissing(MEMORY_FAMILY, preFix)).toEqual(PHASE_NAMES);
  });

  it("fails when a single phase drops one family member", () => {
    const dropped = {
      ...protocolPhases.TOOL_ALLOWLIST,
      SWARM: protocolPhases.TOOL_ALLOWLIST.SWARM.filter((t) => t !== "memory_note_read"),
    };
    expect(phasesMissing(MEMORY_FAMILY, dropped)).toEqual(["SWARM"]);
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

// The Committer's remit at the CLEANUP authoring site: the CLEANUP dispatch
// scope is Overseer-authored free text, so the remit clause lives in the
// Overseer definition where that scope is written — the git closeout belongs to
// the Committer, while gate and test execution belongs to the implementing and
// verifying agents. The pin reads the agent file and asserts the clause text is
// present, so a later edit that drops it fails the suite rather than silently
// re-opening the defect the clause closes.
describe("CLEANUP committer-remit clause (overseer scope authoring)", () => {
  it("keeps the git-closeout remit clause in the overseer CLEANUP guidance", () => {
    expect(readAgent("overseer.md"), "overseer.md must carry the committer-remit clause").toContain(
      "The CLEANUP scope covers the git closeout"
    );
  });

  it("keeps gate and test execution with the implementing and verifying agents", () => {
    expect(readAgent("overseer.md")).toContain(
      "gate and test execution stays with Artisan (implementation) and Inspector (verification)"
    );
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
    expect(globAllows).toEqual([
      "knowledge/intent-*.md",
      "knowledge/report-*.md",
      "knowledge/milestones-*.md",
    ]);
    for (const p of [...readAllows, ...globAllows]) {
      expect(p.startsWith("knowledge/"), `${p} must stay in the docs scope`).toBe(true);
    }
    expect(overseerScopeFindings(overseer)).toEqual([]);
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
    expect(granted).toEqual([
      "knowledge/intent-*.md",
      "knowledge/report-*.md",
      "knowledge/milestones-*.md",
    ]);
    expect(globScopeFindings(protocolPhases.TOOL_RESTRICTIONS, granted)).toEqual([]);
  });

  it("fails closed when an advertised scope drops, widens, or omits a granted pattern", () => {
    const granted = overseerGlobGrantPatterns();
    const live = protocolPhases.TOOL_RESTRICTIONS;
    const withSwarmGlob = (text) => ({ ...live, SWARM: { ...live.SWARM, glob: text } });
    // Advertised narrower than granted (a dropped pattern).
    expect(globScopeFindings(withSwarmGlob("ONLY knowledge/intent-*.md — docs-scoped"), granted)).not.toEqual([]);
    // Advertised wider than granted (an extra resource).
    expect(
      globScopeFindings(
        withSwarmGlob(
          "ONLY knowledge/intent-*.md, knowledge/report-*.md, knowledge/milestones-*.md, src/*.ts — docs-scoped"
        ),
        granted
      )
    ).not.toEqual([]);
    // No entry at all for a glob-advertising phase.
    expect(globScopeFindings({ ...live, SWARM: { read: "ONLY milestone registry KDs" } }, granted)).not.toEqual([]);
    // The grant narrowed without the advertisement following.
    expect(
      globScopeFindings(live, granted.filter((p) => p !== "knowledge/report-*.md"))
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
      "knowledge/intent-*.md",
      "knowledge/report-*.md",
      "knowledge/milestones-*.md",
    ]);
  });
});

// The read-side twin of the glob seam above, and the pin on the Overseer's
// status-only scope. The Overseer authors INTENT and REPORT KDs and tracks the
// milestone registry, so its reach is exactly those three families: it reads
// back what it wrote and the record it dispatches from, and nothing else. The
// advertised classes and the granted patterns are the same three, so
// advertisement and grant cannot drift apart in either direction: a pattern
// dropped from the grant breaks an advertisement that names it, and a pattern
// no advertisement names is reach granted for a phase that never asked for it.
const OVERSEER_READ_CONTRACT = [
  "knowledge/intent-*.md",
  "knowledge/report-*.md",
  "knowledge/milestones-*.md",
];

const OVERSEER_READ_PHASES = Object.keys(protocolPhases.STATES).filter((p) =>
  (protocolPhases.TOOL_ALLOWLIST[p] || []).includes("read")
);

// Each advertisement names a resource class in prose, and the class is what the
// grant has to cover. The three classes are disjoint, so the contract is their
// union: no phase names a class the others already cover.
const READ_SCOPE_CLASSES = [
  { id: "intent KDs", scope: /ONLY intent KDs/i, patterns: ["knowledge/intent-*.md"] },
  { id: "milestone registry KDs", scope: /ONLY milestone registry KDs/i, patterns: ["knowledge/milestones-*.md"] },
  { id: "report KDs", scope: /ONLY report KDs/i, patterns: ["knowledge/report-*.md"] },
];

function overseerReadGrantPatterns() {
  return actionEntries(readAgent("overseer.md"), "read")
    .filter((e) => e.mode === "allow")
    .map((e) => e.pattern);
}

// Compared in both directions, because either one alone hides a failure: a
// pattern the grant lacks is an advertisement promising a read the host
// refuses, and a pattern no advertisement names is reach granted for a phase
// that never asked for it.
function readScopeFindings(restrictions, grantPatterns) {
  const findings = [];
  const granted = new Set(grantPatterns);
  const required = new Set();
  for (const phase of OVERSEER_READ_PHASES) {
    const advertised = restrictions[phase]?.read;
    if (typeof advertised !== "string" || advertised.length === 0) {
      findings.push(`${phase}: read is advertised with no scope`);
      continue;
    }
    const backing = READ_SCOPE_CLASSES.find((klass) => klass.scope.test(advertised));
    if (!backing) {
      findings.push(`${phase}: advertised scope names no known resource class`);
      continue;
    }
    backing.patterns.forEach((pattern) => required.add(pattern));
    const unbacked = backing.patterns.filter((pattern) => !granted.has(pattern));
    if (unbacked.length > 0) {
      findings.push(`${phase}: advertised "${backing.id}" is not backed by ${unbacked.join(", ")}`);
    }
  }
  for (const pattern of grantPatterns) {
    if (!required.has(pattern)) findings.push(`grant carries ${pattern}, which no advertised read scope names`);
  }
  return findings;
}

describe("advertised-vs-granted seam — Overseer status scope", () => {
  it("carries a read restriction entry in every phase that advertises read", () => {
    expect(OVERSEER_READ_PHASES).toEqual(["INTENT", "DECOMPOSE", "SWARM", "VERIFY", "REPORT"]);
    const missing = OVERSEER_READ_PHASES.filter(
      (phase) => typeof protocolPhases.TOOL_RESTRICTIONS[phase]?.read !== "string"
    );
    expect(missing).toEqual([]);
  });

  it("grants exactly the contracted read patterns", () => {
    // Order-insensitive per the contract; the count is the half an order-blind
    // comparison would otherwise leave to a matcher accident.
    expect([...overseerReadGrantPatterns()].sort()).toEqual([...OVERSEER_READ_CONTRACT].sort());
    expect(overseerReadGrantPatterns()).toHaveLength(OVERSEER_READ_CONTRACT.length);
  });

  it("binds the advertised read scope to the Overseer's granted read scope", () => {
    expect(readScopeFindings(protocolPhases.TOOL_RESTRICTIONS, overseerReadGrantPatterns())).toEqual([]);
  });

  it("fails closed when the grant drops a pattern, adds one, or a phase loses its scope entry", () => {
    const live = protocolPhases.TOOL_RESTRICTIONS;
    const granted = overseerReadGrantPatterns();
    // A dropped pattern: the grant narrowed without the advertisement following.
    expect(readScopeFindings(live, granted.filter((p) => p !== "knowledge/report-*.md"))).not.toEqual([]);
    // A fourth pattern: reach the advertisements never asked for.
    expect(readScopeFindings(live, [...granted, "knowledge/spec-*.md"])).not.toEqual([]);
    // An advertised read with no scope entry behind it.
    expect(readScopeFindings({ ...live, SWARM: { glob: live.SWARM.glob } }, granted)).not.toEqual([]);
    // The reach the narrowing removed: an impl or checkpoint pattern is now
    // unbacked, so re-adding either to the grant reds the seam.
    expect(readScopeFindings(live, [...granted, "knowledge/impl-*.md"])).not.toEqual([]);
  });

  it("states the status surface, the vocabulary and the read-back in the Overseer body", () => {
    const body = bodyRegion(readAgent("overseer.md"));
    expect(body).toContain("status surface");
    for (const noun of ["phase", "milestone state", "agent outcome", "succeeded", "failed"]) {
      expect(body.toLowerCase(), `the status vocabulary must name ${noun}`).toContain(noun);
    }
    expect(body).toMatch(/read from the dispatch result/);
    expect(body).toContain("read back the INTENT and REPORT KDs you author");
  });

  it("keeps phase scope, disk checks and plugin internals out of the body", () => {
    // The body states what the role tracks, never the gate mechanics behind it:
    // a phase-scope enumeration, a disk-check evidence model, a glob-scope
    // sentence or a plugin internal in this layer is a rule its reader cannot act
    // on. The four residue rows that carried these facts have their own entries
    // in `audit residue absent`; this case holds the rest of the class.
    const body = bodyRegion(readAgent("overseer.md"));
    for (const phrase of ["permitted in", "blocked in", "disk-check", "glob scope", "glob-scope"]) {
      expect(body, `the body must carry no "${phrase}"`).not.toContain(phrase);
    }
    expect(purityFindings(body, "agents/overseer.md")).toEqual([]);
  });

  it("keeps the Overseer docs-only scope and the glob seam unchanged", () => {
    // The read grant stays inside the docs scope, and the glob group's grant —
    // the pattern set this one mirrors — reads the same as it did before.
    expect(overseerScopeFindings(readAgent("overseer.md"))).toEqual([]);
    expect(overseerGlobGrantPatterns()).toEqual([
      "knowledge/intent-*.md",
      "knowledge/report-*.md",
      "knowledge/milestones-*.md",
    ]);
  });
});

// Runtime transcripts under plugins/logs are produced by every lifecycle and
// are never configuration. Coverage is asked of git rather than inferred from
// the rule text: an anchored pattern, a negation or a later re-inclusion all
// change the answer, and only the matcher knows which. Status 1 means "not
// ignored"; any other outcome means git could not answer, which fails the
// guard instead of passing it, so a machine without git cannot turn a broken
// ignore set into a green run.
function gitIgnored(path, gitBinary = "git") {
  const result = spawnSync(gitBinary, ["check-ignore", "-q", path], { cwd: ROOT });
  if (result.error) {
    throw new Error(`git check-ignore ${path} could not run: ${result.error.message}`);
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore ${path} exited ${result.status}: ${String(result.stderr).trim()}`);
}

// Tracked paths under a directory, read from git rather than the working tree:
// an ignore rule leaves an already-tracked file tracked, so emptiness here is
// the assertion that the rule hides nothing the repository carries. `cwd` is a
// parameter because the answer is only falsifiable against a repository that
// does carry such a file, and a caller holding one must be able to say so.
function trackedUnder(dir, cwd = ROOT) {
  const result = spawnSync("git", ["ls-files", dir], { cwd });
  if (result.error) {
    throw new Error(`git ls-files ${dir} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ls-files ${dir} exited ${result.status}: ${String(result.stderr).trim()}`);
  }
  return String(result.stdout).split("\n").filter(Boolean);
}

const LOGS_DIR = join("plugins", "logs");

describe("plugin logs ignore coverage", () => {
  // Probes are path strings, never created files: a created probe would make
  // the guard observe the suite's own output and leave residue in the directory
  // it is asserting about.
  it("ignores a probe path with an extension no rule names", () => {
    // Extension-independent by construction — the directory rule covers the
    // next artifact type without a new line, which the enumerated set could not
    // do and decayed twice by failing to.
    expect(gitIgnored(join(LOGS_DIR, "probe.xyz"))).toBe(true);
  });

  it("ignores the artifact shapes a run leaves behind", () => {
    for (const name of ["protocol-gate.log", "vitest.json", ".head-index.js"]) {
      expect(gitIgnored(join(LOGS_DIR, name)), `${name} must be ignored`).toBe(true);
    }
  });

  it("tracks nothing under the directory", () => {
    const tracked = trackedUnder(LOGS_DIR);
    expect(tracked, `tracked under ${LOGS_DIR}: ${tracked.join(", ")}`).toEqual([]);
  });

  it("leaves a path outside the directory unignored", () => {
    // The paired positive is what keeps this from being a tautology: the same
    // machinery answers true for a path the rule catches, so a false here is a
    // scope fact rather than a matcher that always answers no.
    expect(gitIgnored(join(LOGS_DIR, "probe.xyz"))).toBe(true);
    expect(gitIgnored(join("plugins", "probe-outside.txt"))).toBe(false);
  });

  it("carries no re-inclusion of a path inside the directory", () => {
    const negations = readRoot(".gitignore")
      .split("\n")
      .filter((line) => line.trim().startsWith("!plugins/logs"));
    expect(negations).toEqual([]);
  });

  it("states the directory rule and keeps the root log rule", () => {
    const lines = readRoot(".gitignore")
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toContain("plugins/logs/");
    expect(lines).toContain("*.log");
    expect(lines).not.toContain("plugins/logs/*.status");
  });

  it("fails rather than skips when git cannot answer", () => {
    // A skip would let a machine without git report the ignore set as healthy.
    expect(() => gitIgnored(join(LOGS_DIR, "probe.xyz"), "git-absent-probe")).toThrow(/could not run/);
  });

  // The assertion above asks whether *this* repository tracks anything under
  // plugins/logs, which a repository that never tracked a file there satisfies
  // by construction — it cannot tell "the rule hides nothing" from "there is
  // nothing to hide". The pair below reads an index that does carry such a
  // file, so the helper's answer is falsifiable in both directions.
  describe("against a repository that tracks a file under the ignored directory", () => {
    let repo;

    // Setup fails loudly rather than leaving a half-built repository that would
    // make the assertions below red for a staging reason instead of the
    // helper's answer.
    const gitIn = (args) => {
      const result = spawnSync("git", args, { cwd: repo });
      if (result.error) {
        throw new Error(`git ${args.join(" ")} could not run: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} exited ${result.status}: ${String(result.stderr).trim()}`);
      }
      return String(result.stdout);
    };

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), "config-guard-tracked-"));
      gitIn(["init", "-q"]);
      writeFileSync(join(repo, ".gitignore"), "plugins/logs/\n");
      mkdirSync(join(repo, "plugins", "logs"), { recursive: true });
      writeFileSync(join(repo, "plugins", "logs", "probe.log"), "");
      // -f is required: the ignore rule written above would otherwise keep the
      // path out of the index, and the positive half would red for a staging
      // failure rather than for the helper's answer.
      gitIn(["add", "-f", "plugins/logs/probe.log"]);
    });

    afterAll(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it("reads the index of the repository it is handed, not this one", () => {
      // The fixture's own index is proven non-empty before the helper is asked
      // anything, so a failure below can only be the helper answering about a
      // different tree.
      expect(gitIn(["ls-files", LOGS_DIR]).split("\n").filter(Boolean)).toEqual([
        "plugins/logs/probe.log",
      ]);
      expect(trackedUnder(LOGS_DIR, repo)).toEqual(["plugins/logs/probe.log"]);
      // Without the negative half a helper that returned every tracked path in
      // the repository it was handed would pass the positive.
      expect(trackedUnder(join("plugins", "absent"), repo)).toEqual([]);
    });
  });
});

// A rule names no technology stack. Verification gates are project-owned: a
// project declares them in its own manifests, task definitions and project
// documentation, so a rule that names one ecosystem's binary, command or
// manifest file reads as unrunnable in the next project. The sweep reads the
// prose body only — a shell grant necessarily names a concrete binary because
// the allowlist is prefix-based, so the permission block is mechanism and stays
// outside the rule surface.
describe("stack-neutral agent rules", () => {
  const MANIFEST_NAMES = /\b(?:Makefile|Cargo\.toml|package\.json|go\.mod|pyproject\.toml|pom\.xml)\b/g;
  const STACK_COMMAND =
    /\b(?:make|cargo|go|pip|npm|npx|yarn|pnpm|bun|cmake|pytest|mvn|gradle|dotnet|poetry|rustc)\s+(?:-{1,2}[\w-]+|build|test|check|clippy|fmt|vet|audit|install|verify|mod|get|ci|lint|metadata|lock|update|add|show|list|freeze|outdated)\b/g;
  const PACKAGE_MANAGER_RUN = /\b(?:npm|npx|yarn|pnpm|bun|poetry|uv)\s+(?:run|exec)\b/g;
  const SWEEP = [MANIFEST_NAMES, STACK_COMMAND, PACKAGE_MANAGER_RUN];

  // Matched fragments rather than a boolean: the failure message names what
  // tripped, so the repair site is visible from the run output alone.
  function stackTokens(text) {
    return SWEEP.flatMap((pattern) => text.match(pattern) ?? []);
  }

  function bodyOffenders() {
    return agentFiles()
      .map((name) => ({ name, tokens: stackTokens(bodyRegion(readAgent(name))) }))
      .filter((row) => row.tokens.length > 0)
      .map((row) => `${row.name}: ${row.tokens.join(", ")}`);
  }

  it("sweeps every agent prose body clean", () => {
    expect(bodyOffenders(), "agent rules naming a build system or its manifest").toEqual([]);
  });

  it("bites on a stack-specific rule injected into any agent body", () => {
    const injected = "Run the make build-wasm-tests target.";
    for (const name of agentFiles()) {
      const body = `${bodyRegion(readAgent(name))}\n${injected}`;
      expect(stackTokens(body), `${name} must be swept`).not.toEqual([]);
    }
  });

  it("bites on each command-shaped form a later edit would reintroduce", () => {
    for (const line of [
      "Run the make build-wasm-tests target.",
      "cargo test",
      "the build reads Cargo.toml",
      "npm audit",
      "go vet ./...",
    ]) {
      expect(stackTokens(line), `unmatched stack rule: ${line}`).not.toEqual([]);
    }
  });

  it("stays green on ordinary English and the generic stack phrase", () => {
    for (const line of [
      "make the test pass",
      "detect the tech stack",
      "the project's declared test command",
      "go through the dispatch fields",
      "the toolchain probe",
    ]) {
      expect(stackTokens(line), `false positive: ${line}`).toEqual([]);
    }
  });

  it("reads the rule text and never the permission block", () => {
    // Both directions in one file: the inspector's grants carry stack binaries,
    // and the sweep over that same file's body must not see them.
    const inspector = readAgent("inspector.md");
    expect(stackTokens(inspector).length, "the permission block carries grants").toBeGreaterThan(0);
    expect(stackTokens(bodyRegion(inspector))).toEqual([]);
  });

  it("states the declared-gate discovery method in the audit protocol", () => {
    const body = bodyRegion(readAgent("inspector.md"));
    expect(body).toContain("declares its verification gates");
    expect(body).toContain("declared-vs-run delta");
    expect(body).toContain("matching grant");
    expect(body).not.toContain("tech stack's");
  });
});

// A layer's audience decides what its prose may name. The ground rules reach
// every agent in every project, so a repo path, a plugin internal or this
// stack's tooling named there is one project's fact leaking into all of them.
// Matching is per whole token, so an ordinary English word that contains one
// stays clean, and each finding names the class, the token and the file.
const PURITY_CLASSES = [
  {
    id: "P1",
    label: "repo path",
    tokens: [
      "plugins/",
      "tests/",
      "agents/",
      "skills/",
      "opencode.json",
      "package.json",
      "service.json",
      "eslint.security.config.mjs",
      ".githooks",
      ".head-index",
      "README.md",
      "AGENTS.md",
      "eslint.config",
    ],
  },
  {
    id: "P2",
    label: "plugin internal",
    tokens: [
      "protocol-gate",
      "delegation-gate",
      "knowledge-gate",
      "TOOL_ALLOWLIST",
      "TOOL_RESTRICTIONS",
      "PHASE_INSTRUCTIONS",
      "admitTool",
      "checkAllMilestonesCheckedOff",
      "gateRecordEvent",
      "lifecycle.json",
      "WRONG_AGENT",
      "SAFETY_STUCK",
      "SAFETY_ESCAPE",
      "REOPEN_TARGET_INVALID",
      "VERDICT_MISSING",
      "STALE_PASS",
      "MISSING_STRUCTURED_FIELDS",
      "all-checked-off",
      "disk-advance",
    ],
  },
  {
    id: "P3",
    label: "stack tooling",
    tokens: ["vitest", "eslint", "npm", "npx", "pnpm", "yarn", "node", "pre-commit", "core.hooksPath"],
  },
];

// A whole-token match for one token: no letter, digit, underscore or hyphen
// bounded before it, and none after it when the token ends in one of those. A
// token ending in a separator (`plugins/`) keeps its tail open, because the
// path it names continues past the separator.
function purityPattern(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = /\w$/.test(token) ? "(?![A-Za-z0-9_-])" : "";
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}${tail}`, "i");
}

// One finding per token that survived in the text, so a red run names the
// offending class, token and file rather than only a count.
function purityFindings(text, file) {
  const findings = [];
  for (const klass of PURITY_CLASSES) {
    for (const token of klass.tokens) {
      if (purityPattern(token).test(text)) {
        findings.push(`${file} carries ${klass.id} ${klass.label} token "${token}"`);
      }
    }
  }
  return findings;
}

// A rule stated for every project names no role of this swarm either. The role
// set is read from the definitions on disk, so a definition added later joins
// the sweep instead of leaving a name the pin never learned.
function roleNamePattern() {
  const forms = agentFiles().flatMap((file) => {
    const name = file.replace(/\.md$/, "");
    return [name, name.replace(/-/g, " ")];
  });
  return new RegExp(`(?<![A-Za-z0-9-])(?:${forms.join("|")})(?![A-Za-z0-9-])`, "i");
}

// Level-two section text, from its heading to the next one. An absent heading
// reads as an empty region, so a deleted section cannot pass by matching prose
// further down the file.
function headingSection(content, heading) {
  const start = content.indexOf(heading);
  if (start === -1) return "";
  const end = content.indexOf("\n## ", start + heading.length);
  return content.slice(start, end === -1 ? undefined : end);
}

describe("audience purity", () => {
  // The ground rules carry no frontmatter, so the body region is the file.
  const groundRules = readRoot("AGENTS.md");

  it("sweeps the ground rules free of repo, plugin and stack facts", () => {
    expect(purityFindings(bodyRegion(groundRules), "AGENTS.md")).toEqual([]);
  });

  it("names the offending class, token and file for an injected token", () => {
    const samples = [
      ["P1", "Write the sweep output under `plugins/logs/`.", "plugins/"],
      ["P2", "The verdict comes from protocol-gate.", "protocol-gate"],
      ["P3", "Run `npx vitest` before dispatch.", "npx"],
    ];
    for (const [id, sentence, token] of samples) {
      const klass = PURITY_CLASSES.find((entry) => entry.id === id);
      const findings = purityFindings(`${bodyRegion(groundRules)}\n${sentence}\n`, "AGENTS.md");
      expect(findings).toContain(`AGENTS.md carries ${id} ${klass.label} token "${token}"`);
    }
  });

  it("keeps a token fragment inside an ordinary word clean", () => {
    // "nodes" holds "node": a sweep that matched fragments would red on
    // ordinary prose and earn its own deletion.
    expect(purityFindings("Every agent tracks the nodes it hands work to.", "AGENTS.md")).toEqual([]);
  });
});

// The narrowing rule every entitlement change follows: a claim broader than the
// privilege behind it narrows to that privilege. The pin holds the rule's facts
// as normalized tokens, and holds the section free of names — no role, file or
// tool — because the rule is method shared by every project rather than a fact
// about this one.
const GOVERNING_HEADING = "## Governing Disposition";
const GOVERNING_FACTS = [
  { id: "the mismatch", pattern: /a mismatch between a broad claim and a narrow entitlement/i },
  { id: "the narrowing direction", pattern: /resolves by narrowing the broad side/i },
  { id: "the three broad sides", pattern: /expertise[\s\S]+advertisement[\s\S]+executor check/i },
  { id: "the entitlement as the boundary", pattern: /to the entitlement/i },
  { id: "privilege held in place", pattern: /privilege does not grow to meet a claim/i },
];

function governingFindings(content) {
  const section = headingSection(content, GOVERNING_HEADING);
  if (section === "") return ["AGENTS.md carries no Governing Disposition section"];
  const findings = GOVERNING_FACTS.filter((fact) => !fact.pattern.test(section)).map(
    (fact) => `AGENTS.md Governing Disposition is missing ${fact.id}`
  );
  return [...findings, ...purityFindings(section, "AGENTS.md Governing Disposition")];
}

describe("governing disposition", () => {
  const groundRules = readRoot("AGENTS.md");

  it("states the narrowing rule between dispatch shaping and focused execution", () => {
    expect(governingFindings(groundRules)).toEqual([]);
    const order = ["## Delegation Integrity", GOVERNING_HEADING, "## Focused Execution"].map((heading) =>
      groundRules.indexOf(heading)
    );
    expect(order.every((index) => index >= 0), "all three headings must be present").toBe(true);
    expect(order, "the rule reads where a rule about placement used to sit").toEqual(
      [...order].sort((a, b) => a - b)
    );
  });

  it("fails when the section is removed", () => {
    expect(governingFindings(groundRules.replace(GOVERNING_HEADING, "## Disposition Notes"))).not.toEqual([]);
  });

  it("fails when the direction reverses", () => {
    const widened = groundRules.replace(
      "resolves by narrowing the broad side",
      "resolves by widening the narrow side"
    );
    expect(governingFindings(widened)).not.toEqual([]);
  });

  it("fails when privilege grows to meet a claim", () => {
    const grown = groundRules.replace(
      "Privilege does not grow to meet a claim",
      "Privilege grows to meet a claim"
    );
    expect(governingFindings(grown)).not.toEqual([]);
  });

  it("names no role, file or tool in the rule", () => {
    const section = headingSection(groundRules, GOVERNING_HEADING);
    expect(roleNamePattern().test(section), "the rule binds every project").toBe(false);
    expect(roleNamePattern().test(`${section}\nThe Artisan narrows its claim.`), "a named role must red").toBe(
      true
    );
    expect(purityFindings(section, "AGENTS.md Governing Disposition")).toEqual([]);
  });
});

// The report is a status delivery: it states what the lifecycle reached and who
// produced what, and it points at the artifacts instead of restating them. The
// template is the shape a report is written into, so its sections are the
// contract; the two prose sites that instruct the report are measured by the
// same token list, because an instruction asking for a narrative undoes the
// template it renders into.
const REPORT_TEMPLATE = join("skills", "template-report", "SKILL.md");
const REPORT_STATUS_SECTIONS = ["## Lifecycle Result", "## Agent Outcomes", "## References"];

// Facts a section owns. A heading that survives with its fact deleted is the
// narrowing this list detects: the section would still render, and the report
// would say nothing.
const REPORT_TEMPLATE_FACTS = [
  { id: "the phase reached", section: "## Lifecycle Result", pattern: /phase reached/i },
  {
    id: "the milestone total, checked-off and failed counts",
    section: "## Lifecycle Result",
    pattern: /milestones[\s\S]*total[\s\S]*checked[- ]off[\s\S]*failed/i,
  },
  { id: "the session", section: "## Lifecycle Result", pattern: /\bsession\b/i },
  { id: "the generation", section: "## Lifecycle Result", pattern: /\bgeneration\b/i },
  { id: "the phase column", section: "## Agent Outcomes", pattern: /\bphase\b/i },
  { id: "the agent column", section: "## Agent Outcomes", pattern: /\bagent\b/i },
  { id: "the outcome vocabulary", section: "## Agent Outcomes", pattern: /succeeded[\s\S]*failed/i },
  { id: "the artifact KD path column", section: "## Agent Outcomes", pattern: /artifact KD path/i },
  { id: "the composed KD pointer", section: "## References", pattern: /composed/i },
  { id: "the review KD pointer", section: "## References", pattern: /review/i },
  { id: "the process KD pointer", section: "## References", pattern: /process/i },
  { id: "the intent KD pointer", section: "## References", pattern: /intent/i },
];

// Text that asks for a synthesis rather than a status. Matched as a normalized
// substring so a re-cased or reflowed copy still names the retired instruction.
const REPORT_SYNTHESIS_PHRASES = [
  "what was built",
  "what changed",
  "acceptance criteria",
  "summarizing lifecycle results",
];

// The shape both instructing sites state: the three status sections' facts in
// prose. Hyphens read as spaces, so "checked-off" and "checked off" are one
// token and a reworded copy is still measured.
const REPORT_SHAPE_TOKENS = [
  "phase reached",
  "milestones",
  "checked off",
  "succeeded",
  "failed",
  "agent outcomes",
  "artifact kd path",
  "references",
  "composed",
  "review",
  "process",
  "intent",
];

function normalizeReportProse(text) {
  return text.toLowerCase().replace(/[-–—]/g, " ").replace(/\s+/g, " ");
}

function reportSynthesisFindings(text, site) {
  const normalized = normalizeReportProse(text);
  return REPORT_SYNTHESIS_PHRASES.filter((phrase) => normalized.includes(normalizeReportProse(phrase))).map(
    (phrase) => `${site} still asks for "${phrase}"`
  );
}

function reportTemplateFindings(content) {
  const findings = [];
  for (const heading of REPORT_STATUS_SECTIONS) {
    if (headingSection(content, heading) === "") findings.push(`report template omits ${heading}`);
  }
  for (const fact of REPORT_TEMPLATE_FACTS) {
    const section = headingSection(content, fact.section);
    if (section !== "" && !fact.pattern.test(section)) {
      findings.push(`report template ${fact.section} omits ${fact.id}`);
    }
  }
  return [...findings, ...reportSynthesisFindings(content, "report template")];
}

function reportInstructionFindings(text, site) {
  const normalized = normalizeReportProse(text);
  const missing = REPORT_SHAPE_TOKENS.filter((token) => !normalized.includes(token)).map(
    (token) => `${site} omits ${token}`
  );
  return [...missing, ...reportSynthesisFindings(text, site)];
}

// The Overseer's phase-12 bullet, sliced from the body so a sentence elsewhere
// in the file cannot satisfy the shape on its behalf.
const OVERSEER_REPORT_BULLET = /^- \*\*Phase 12 \(REPORT\)\*\*:.*$/m;

function overseerReportBullet(content = readAgent("overseer.md")) {
  const match = bodyRegion(content).match(OVERSEER_REPORT_BULLET);
  return match ? match[0] : "";
}

function reportProseSites() {
  return [
    ["the Overseer REPORT bullet", () => overseerReportBullet()],
    ["the REPORT phase instruction", () => protocolPhases.PHASE_INSTRUCTIONS.REPORT],
  ];
}

describe("report status delivery", () => {
  const template = readRoot(REPORT_TEMPLATE);

  it("carries the three status sections, each with the facts it owns", () => {
    expect(reportTemplateFindings(template)).toEqual([]);
  });

  it("fails when a status section is deleted", () => {
    for (const heading of REPORT_STATUS_SECTIONS) {
      expect(reportTemplateFindings(template.replace(heading, "")), `${heading} must be pinned`).not.toEqual(
        []
      );
    }
  });

  it("fails when a section survives without its facts", () => {
    const hollow = template.replace(/Artifact KD path/g, "Outcome");
    expect(reportTemplateFindings(hollow)).toEqual([
      "report template ## Agent Outcomes omits the artifact KD path column",
    ]);
  });

  it("fails when ## What Changed is restored", () => {
    const restored = template.replace(
      "## References",
      "## What Changed\n\n- {{file}} — {{change}}\n\n## References"
    );
    expect(reportTemplateFindings(restored)).toContain('report template still asks for "what changed"');
  });

  it("fails when What was built, at a high level is restored", () => {
    const restored = template.replace(
      "## Lifecycle Result",
      "## Summary\n\n{{What was built, at a high level}}\n\n## Lifecycle Result"
    );
    expect(reportTemplateFindings(restored)).toContain('report template still asks for "what was built"');
  });

  it("states the same shape in the Overseer bullet and the REPORT phase instruction", () => {
    for (const [site, read] of reportProseSites()) {
      expect(reportInstructionFindings(read(), site)).toEqual([]);
    }
  });

  it("fails when the phase instruction keeps asking for a synthesis", () => {
    const retired = `Write a report KD summarizing lifecycle results. Include any corrections from the lifecycle.`;
    expect(reportInstructionFindings(retired, "instruction")).toContain(
      'instruction still asks for "summarizing lifecycle results"'
    );
  });

  it("fails when the Overseer bullet drops the outcome vocabulary", () => {
    const narrowed = overseerReportBullet().replace("succeeded", "completed");
    expect(reportInstructionFindings(narrowed, "bullet")).not.toEqual([]);
  });

  it("scopes each site to its own text", () => {
    // The template's status sections must not satisfy the prose sites: a report
    // written into the template while both instructions still ask for prose is
    // the drift this separation detects.
    expect(reportInstructionFindings(REPORT_STATUS_SECTIONS.join("\n"), "bare headings")).not.toEqual([]);
  });
});

// Residue the audit's corrections replaced. Each entry names one phrase the
// old text carried and the file that carried it; a correction replaces the
// phrase, so a surviving copy is the regression this table detects. Scoping is
// per file because a phrase can be legitimate elsewhere — the point is that the
// corrected site no longer states it, not that the words are banned everywhere.
const RESIDUE_FORBIDDEN = [
  { phrase: "always pushed forward", file: join("plugins", "protocol-gate", "index.js") },
  { phrase: "FR-15", file: join("plugins", "protocol-gate", "index.js") },
  // Operator messages: the cause the record asserted without support, and the
  // remedy the parked state forecloses.
  { phrase: "prior or abandoned lifecycles", file: join("plugins", "protocol-gate", "index.js") },
  { phrase: "land a row transition", file: join("plugins", "protocol-gate", "index.js") },
  // Plugin comments: a growth bound no code in the tree establishes, and an
  // attribution that points the framing rule at another layer.
  { phrase: "log rotation bounds growth", file: join("plugins", "delegation-gate", "index.js") },
  { phrase: "Positive framing per AGENTS.md", file: join("plugins", "protocol-gate", "phases.js") },
  // The registry-read enumeration that stopped at SWARM: the phase table scopes
  // read in VERIFY too, and a FAIL verdict reopens rows there. The corrected
  // sentence joins its phases with commas and a trailing conjunction, so this
  // phrase cannot match it.
  { phrase: "DECOMPOSE (phase 6) and SWARM (phase 7)", file: join("agents", "overseer.md") },
  // The status-only body: a phase-scope enumeration, the disk-check evidence
  // model that scoped glob reads, a plugin-surfaced issue input and a
  // store-inspection route the role has no entitlement for. The body states what
  // the role tracks and reads back; the gate keeps the phase scope, and the issue
  // records stay with their curator.
  { phrase: "permitted in DECOMPOSE (phase 6), SWARM (phase 7) and VERIFY (phase 8)", file: join("agents", "overseer.md") },
  { phrase: "The scoped disk-check evidence model applies", file: join("agents", "overseer.md") },
  { phrase: "issue files surfaced by the Knowledge Gate plugin", file: join("agents", "overseer.md") },
  { phrase: "inspect the issue stores directly", file: join("agents", "overseer.md") },
  // Ground rules that stated this repository's architecture: the layer policy,
  // the investigation walk through the repo's own paths, and an agent-exclusive
  // grant the shared principles have no business carrying.
  { phrase: "A rule lives in the layer that reaches its audience", file: "AGENTS.md" },
  { phrase: "The dedicated Grep tool searches every tree on disk", file: "AGENTS.md" },
  { phrase: "the Committer holds the git reset grant", file: "AGENTS.md" },
  // The synthesis report: the phase instruction and the template that rendered
  // it asked for a narrative of the lifecycle. Both sites state the status
  // delivery now, so a surviving copy is the old instruction coming back.
  { phrase: "Write a report KD summarizing lifecycle results", file: join("plugins", "protocol-gate", "phases.js") },
  { phrase: "What was built, at a high level", file: join("skills", "template-report", "SKILL.md") },
];

// Normalized match: case-insensitive, with whitespace collapsed and the
// markdown wrappers dropped, so a reflowed, re-cased or re-wrapped copy of a
// phrase is still that phrase. Code-span backticks and template braces carry no
// prose meaning — an edit that wraps the same words in backticks changes the
// rendering, not the fact the phrase states.
function normalizeResidueProse(text) {
  return text.toLowerCase().replace(/[{}`]/g, "").replace(/\s+/g, " ");
}

// Returns one finding per entry whose phrase survives in the content. Entries
// are filtered by file by the caller, so a phrase legal in another layer never
// reds the group.
function residueFindings(content, entries) {
  const normalized = normalizeResidueProse(content);
  return entries
    .filter((entry) => normalized.includes(normalizeResidueProse(entry.phrase)))
    .map((entry) => `${entry.file} still carries "${entry.phrase}"`);
}

describe("audit residue absent", () => {
  it("carries no listed phrase in the file that carried it", () => {
    const files = [...new Set(RESIDUE_FORBIDDEN.map((entry) => entry.file))];
    const findings = files.flatMap((file) =>
      residueFindings(readRoot(file), RESIDUE_FORBIDDEN.filter((entry) => entry.file === file))
    );
    expect(findings).toEqual([]);
  });

  it("fails when a listed phrase is reintroduced", () => {
    // The mutation case: the same detector that passes on the corrected tree
    // must fire on a copy carrying the phrase, otherwise the group is a
    // tautology that cannot report a regression.
    const [entry] = RESIDUE_FORBIDDEN;
    const source = readRoot(entry.file);
    expect(residueFindings(source, [entry])).toEqual([]);
    expect(residueFindings(`${source}\n// ${entry.phrase}\n`, [entry])).not.toEqual([]);
  });

  it("matches a re-cased or reflowed copy of a listed phrase", () => {
    const [entry] = RESIDUE_FORBIDDEN;
    const recased = entry.phrase.toUpperCase();
    const reflowed = entry.phrase.replace(/ /g, "\n\t ");
    expect(residueFindings(recased, [entry])).not.toEqual([]);
    expect(residueFindings(reflowed, [entry])).not.toEqual([]);
  });

  it("fails for every listed phrase reintroduced into the file that carried it", () => {
    // One case per table row rather than per group: a row added without a
    // working detector would otherwise pass unproven.
    for (const entry of RESIDUE_FORBIDDEN) {
      const source = readRoot(entry.file);
      expect(residueFindings(source, [entry])).toEqual([]);
      expect(residueFindings(`${source}\n// ${entry.phrase}\n`, [entry])).toEqual([
        `${entry.file} still carries "${entry.phrase}"`,
      ]);
    }
  });

  it("scopes each entry to its own file", () => {
    // A phrase listed for one file stays legal in another: the table asserts
    // the corrected sites, not a repository-wide word ban.
    const [entry] = RESIDUE_FORBIDDEN;
    const otherFile = "plugins/delegation-gate/index.js";
    expect(residueFindings(`${entry.phrase}`, [{ ...entry, file: otherFile }])).toEqual([
      `${otherFile} still carries "${entry.phrase}"`,
    ]);
    expect(residueFindings("unrelated prose", [entry])).toEqual([]);
  });
});

// The registry-read scope is a phase-table fact. The Overseer body names the
// registry as its status surface without enumerating phases, so the table is the
// one place the scope is stated and this group derives it from the shipped
// restriction strings rather than restating them: a phase that gains or loses
// the scope moves the derived set, and a phase that scopes read without
// advertising the tool is drift in the other direction.
function registryReadPhases(restrictions = protocolPhases.TOOL_RESTRICTIONS) {
  return Object.keys(protocolPhases.STATES).filter((phase) =>
    /milestone[- ]registry/i.test(restrictions[phase]?.read || "")
  );
}

describe("registry read phase set", () => {
  const PHASE_SET = ["DECOMPOSE", "SWARM", "VERIFY"];

  it("derives the milestone-registry scope from the phase table", () => {
    expect(registryReadPhases()).toEqual(PHASE_SET);
    // A phase that scopes read must also advertise read, or the restriction
    // describes a tool the phase cannot call.
    const unadvertised = registryReadPhases().filter(
      (phase) => !(protocolPhases.TOOL_ALLOWLIST[phase] || []).includes("read")
    );
    expect(unadvertised).toEqual([]);
  });

  it("fails when the phase table drops the scope VERIFY relies on", () => {
    const live = protocolPhases.TOOL_RESTRICTIONS;
    const narrowed = { ...live, VERIFY: { glob: live.VERIFY.glob } };
    expect(registryReadPhases(narrowed)).not.toEqual(PHASE_SET);
    expect(registryReadPhases(narrowed)).toEqual(["DECOMPOSE", "SWARM"]);
  });

  it("fails when a fourth phase gains the scope", () => {
    const live = protocolPhases.TOOL_RESTRICTIONS;
    const widened = { ...live, INTENT: { ...live.INTENT, read: "ONLY milestone registry KDs" } };
    expect(registryReadPhases(widened)).toEqual(["INTENT", "DECOMPOSE", "SWARM", "VERIFY"]);
  });
});

// A fact this configuration deliberately states at more than one site. Each
// pair names both sites, the token set both must carry, and a reader per site;
// one table drives one group, so a statement added at one site without the
// other is a red run rather than a silent disagreement.
//
// The completion obligation is acted on the moment a round starts, with no
// skill file open, and taught to whichever reviewer loads the gate skill next,
// so both sites state it whole rather than pointing at each other.
const REVIEW_COMPLETION_ID = "review completion obligation";

// One token per half of the obligation: the verdict is written before the
// round ends, and a review that cannot reach a finding still writes a verdict
// naming what blocked it. Each fact carries its own pattern so a reader
// extracts what a site actually says.
const REVIEW_COMPLETION_FACTS = [
  { token: "writes the REVIEW KD frontmatter verdict", pattern: /writes the REVIEW KD frontmatter verdict/i },
  { token: "before it ends", pattern: /before it ends/i },
  { token: "cannot reach a finding", pattern: /cannot reach a finding/i },
  { token: "naming the blocking reason", pattern: /naming the blocking reason/i },
];

// The DECOMPOSE pass keeps a plan internally consistent. The planner runs it
// while decomposing and its completeness step is where the obligation is
// stated; the reviewer adjudicating a contradiction reads the same obligation
// in the verdict section it writes.
const PLAN_SELF_CONSISTENCY_ID = "plan self-consistency pass";

const PLAN_SELF_CONSISTENCY_FACTS = [
  { token: "mutually unsatisfiable", pattern: /mutually unsatisfiable/i },
  { token: "read from the tree", pattern: /read from the tree/i },
  { token: "self-consistency pass", pattern: /self-consistency pass/i },
  { token: "recorded in the PLAN", pattern: /recorded in the PLAN/i },
];

// The tokens one site carries, matched by the fact's own pattern rather than
// read off the table, so a site that loses half the obligation reports the half
// it lost instead of reporting nothing.
function factTokens(facts, text) {
  return facts.filter((fact) => fact.pattern.test(text)).map((fact) => fact.token);
}

function completionTokens(text) {
  return factTokens(REVIEW_COMPLETION_FACTS, text);
}

function planSelfConsistencyTokens(text) {
  return factTokens(PLAN_SELF_CONSISTENCY_FACTS, text);
}

// The Inspector's Protocol step list, above the two protocol blocks it splits
// into. The narrower region matters: the VERIFY paragraph below the list also
// speaks of a frontmatter verdict, and a site that matched that sentence would
// stay green after the step itself left.
function inspectorProtocol(content = readAgent("inspector.md")) {
  return sectionBetween(content, "## Protocol", "At VERIFY, the REVIEW KD");
}

function gatesVerdictSection(content = readRoot(join("skills", "verification-gates", "SKILL.md"))) {
  return headingSection(content, "## Verdicts");
}

// The Pathfinder's completeness step closes the protocol list, so the region
// runs from the step to the next section. An empty region means the step left,
// which the pair reports as every token missing.
function pathfinderSelfConsistencyStep(content = readAgent("pathfinder.md")) {
  return sectionBetween(content, "8. Verify completeness", "\n## Principles");
}

function reviewVerdictAdjudication(content = readRoot(join("skills", "template-review", "SKILL.md"))) {
  return headingSection(content, "## Verdict");
}

const AGREEMENT_PAIRS = [
  {
    id: REVIEW_COMPLETION_ID,
    tokens: REVIEW_COMPLETION_FACTS.map((fact) => fact.token),
    sites: [
      ["inspector protocol", () => completionTokens(inspectorProtocol())],
      ["gate verdicts section", () => completionTokens(gatesVerdictSection())],
    ],
  },
  {
    id: EVIDENCE_SHAPE_ID,
    tokens: EVIDENCE_SHAPE_FACTS.map((fact) => fact.token),
    sites: [
      ["gate evidence clause", () => evidenceShapeTokens(gatesEvidenceClause())],
      ["review evidence clause", () => evidenceShapeTokens(reviewEvidenceClause())],
    ],
  },
  {
    id: PLAN_SELF_CONSISTENCY_ID,
    tokens: PLAN_SELF_CONSISTENCY_FACTS.map((fact) => fact.token),
    sites: [
      ["pathfinder completeness step", () => planSelfConsistencyTokens(pathfinderSelfConsistencyStep())],
      ["review verdict", () => planSelfConsistencyTokens(reviewVerdictAdjudication())],
    ],
  },
];

// One finding per token a site states and its partner does not, so a red run
// names the side that drifted rather than only the pair. Overrides are keyed
// "<pair id>:<site>" and let a mutation case edit one site in isolation.
function agreementFindings(pairs, overrides = {}) {
  return pairs.flatMap((pair) =>
    pair.sites.flatMap(([site, read]) => {
      const tokens = overrides[`${pair.id}:${site}`] || read();
      const missing = pair.tokens.filter((token) => !tokens.includes(token));
      const extra = tokens.filter((token) => !pair.tokens.includes(token));
      return [
        ...missing.map((token) => `${pair.id}: ${site} omits ${token}`),
        ...extra.map((token) => `${pair.id}: ${site} names ${token}`),
      ];
    })
  );
}

// A synthetic pair with the table's shape, read entirely from fixtures. The
// detector is exercised here independently of what the table registers, so a
// reader that agrees with its own site cannot hide a broken comparison, and the
// token-vocabulary cases below stay provable whatever the table holds.
function syntheticPair() {
  const sites = {
    left: ["ALPHA", "BETA"],
    right: ["ALPHA", "BETA"],
  };
  return [
    {
      id: "synthetic fact",
      tokens: ["ALPHA", "BETA"],
      sites: [
        ["left", () => sites.left],
        ["right", () => sites.right],
      ],
    },
  ];
}

describe("duplicated rules agree", () => {
  it("states every registered fact at both of its sites", () => {
    // A hole in the table would pass this case trivially, so every registered
    // pair is named here; the count assertion over the full set belongs to the
    // milestone that restores every pair.
    const registered = AGREEMENT_PAIRS.map((pair) => pair.id);
    for (const id of [REVIEW_COMPLETION_ID, EVIDENCE_SHAPE_ID, PLAN_SELF_CONSISTENCY_ID]) {
      expect(registered).toContain(id);
    }
    expect(agreementFindings(AGREEMENT_PAIRS)).toEqual([]);
  });

  it("fails when either site of a pair is edited alone", () => {
    for (const pair of AGREEMENT_PAIRS) {
      for (const [site, read] of pair.sites) {
        for (const token of pair.tokens) {
          const dropped = read().filter((value) => value !== token);
          expect(
            agreementFindings(AGREEMENT_PAIRS, { [`${pair.id}:${site}`]: dropped }),
            `${pair.id}: dropping ${token} from ${site} must red the pair`
          ).not.toEqual([]);
        }
      }
    }
  });

  it("reds a registered pair the moment one site drops a token", () => {
    // Falsifiable with the table empty: a dropped token at either site, and a
    // token list wider than the sites, each report the drifting side by name.
    const pair = syntheticPair();
    expect(agreementFindings(pair)).toEqual([]);
    for (const site of ["left", "right"]) {
      expect(agreementFindings(pair, { [`synthetic fact:${site}`]: ["ALPHA"] })).toEqual([
        `synthetic fact: ${site} omits BETA`,
      ]);
    }
    expect(agreementFindings(pair, { "synthetic fact:left": ["ALPHA", "BETA", "GAMMA"] })).toEqual([
      "synthetic fact: left names GAMMA",
    ]);
    const widened = pair.map((entry) => ({ ...entry, tokens: ["ALPHA", "BETA", "GAMMA"] }));
    expect(agreementFindings(widened)).toEqual([
      "synthetic fact: left omits GAMMA",
      "synthetic fact: right omits GAMMA",
    ]);
  });

  it("reds the pair when a site's prose loses the obligation", () => {
    // Both halves in one edit: the strip removes the write-before-the-end
    // clause and the reader reports the tokens that clause carried. The strip
    // is asserted to have landed, so a reworded site reds on the next line
    // rather than turning this case into a no-op.
    const live = inspectorProtocol();
    const stripped = live.replace("writes the REVIEW KD frontmatter verdict before it ends", "");
    expect(stripped, "the Inspector Protocol must carry the obligation to strip").not.toBe(live);
    expect(
      agreementFindings(AGREEMENT_PAIRS, {
        [`${REVIEW_COMPLETION_ID}:inspector protocol`]: completionTokens(stripped),
      })
    ).not.toEqual([]);
  });

  it("reds the pair when the gate skill loses the obligation", () => {
    const live = gatesVerdictSection();
    const stripped = live.replace("a review that cannot reach a finding", "an incomplete review");
    expect(stripped, "the gate verdicts section must carry the obligation to strip").not.toBe(live);
    expect(
      agreementFindings(AGREEMENT_PAIRS, {
        [`${REVIEW_COMPLETION_ID}:gate verdicts section`]: completionTokens(stripped),
      })
    ).not.toEqual([]);
  });
});
