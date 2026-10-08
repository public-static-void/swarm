import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Standing suite for the swarm config audit fixes. This file opens with the
// short-term memory bare-name contract: docs and tool descriptions state the
// bare invocation, the canonical registration stays bare, prompts carry no
// prefixed form, and the artisan surface round-trips a note. Later work
// extends this file with scoped-delete, residual-posture, and scribe pins.

const ROOT = process.cwd();
const SESSION = "ses_bare_guard_probe";

let tempRoot;
let shortTermDir;
let logDir;
let priorLogDir;
let priorShortTermDir;
let pluginModule;
let hooks;

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "audit-fix-bare-"));
  shortTermDir = join(tempRoot, "short-term");
  mkdirSync(shortTermDir, { recursive: true });
  priorShortTermDir = process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
  process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = shortTermDir;
  priorLogDir = process.env.KNOWLEDGE_GATE_LOG_DIR;
  logDir = mkdtempSync(join(tmpdir(), "audit-fix-bare-log-"));
  process.env.KNOWLEDGE_GATE_LOG_DIR = logDir;
  pluginModule = await import("../plugins/knowledge-gate/index.js?audit-fix-swarm-issues");
  hooks = await pluginModule.default.server({}, {});
});

afterAll(() => {
  if (priorShortTermDir === undefined) delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
  else process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = priorShortTermDir;
  if (priorLogDir === undefined) delete process.env.KNOWLEDGE_GATE_LOG_DIR;
  else process.env.KNOWLEDGE_GATE_LOG_DIR = priorLogDir;
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

function readResumeSkill() {
  return readFileSync(join(ROOT, "skills", "resume-protocol", "SKILL.md"), "utf8");
}

function readPluginSource() {
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

describe("short-term memory invocation guard", () => {
  it("states the bare write invocation in the resume skill", () => {
    const skill = readResumeSkill();
    const section = skill.slice(skill.indexOf("### Short-Term Layer"));
    expect(section).toContain("memory_note");
    expect(section).toContain("tools.memory_note");
  });

  it("carries the bare guard in both memory note descriptions", () => {
    const source = readPluginSource();
    const occurrences = source.split("tools.memory_note").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("advertises the bare invocation through the tool definition hook", async () => {
    const output = { description: "Write a short-term memory note." };
    await hooks["tool.definition"]({ toolID: "memory_note" }, output);
    expect(output.description).toContain("memory_note");
    expect(output.description).toContain("tools.memory_note");
  });
});

describe("canonical tool registration", () => {
  it("registers the write channel under the bare name", () => {
    expect(Object.keys(hooks.tool)).toContain("memory_note");
  });

  it("leaves the prefixed form unregistered", () => {
    expect(Object.keys(hooks.tool)).not.toContain("default.memory_note");
  });
});

describe("prefixed-form absence in prompts and sources", () => {
  it("keeps agent prompts, skill docs, and plugin sources free of the prefixed form", () => {
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
});

describe("bare channel round trip from the artisan surface", () => {
  it("grants the artisan role the bare memory channel", () => {
    const artisan = readFileSync(join(ROOT, "agents", "artisan.md"), "utf8");
    expect(artisan).toContain("- action: memory_note");
  });

  it("writes a note through the bare channel and reads it back", async () => {
    const written = JSON.parse(
      await hooks.tool.memory_note.execute(
        { topic: "guard probe", content: "bare channel reachable" },
        { agent: "artisan", sessionID: SESSION }
      )
    );
    expect(written.id).toMatch(/^ST-/);
    expect(written.message).toContain("written");

    const note = JSON.parse(
      await hooks.tool.memory_note_read.execute({ id: written.id }, { agent: "artisan", sessionID: SESSION })
    );
    expect(note.topic).toBe("guard probe");
    expect(note.content).toBe("bare channel reachable");
  });
});

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

function agentFiles() {
  return readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md")).sort();
}

const TEMP_SCOPED_RM_PATTERN = "rm /tmp/opencode/*";

describe("temp-scoped removal grant", () => {
  it("holds the temp-scoped removal allow for the implementation role", () => {
    const artisan = readFileSync(join(ROOT, "agents", "artisan.md"), "utf8");
    const shellRules = permissionRules(artisan).filter((r) => r.action === "shell");
    expect(shellRules).toContainEqual({
      action: "shell",
      resource: TEMP_SCOPED_RM_PATTERN,
      effect: "allow",
    });
  });

  it("keeps the general removal rule gated for all other paths", () => {
    const artisan = readFileSync(join(ROOT, "agents", "artisan.md"), "utf8");
    const shellRules = permissionRules(artisan).filter((r) => r.action === "shell");
    expect(shellRules).toContainEqual({ action: "shell", resource: "rm*", effect: "ask" });
  });

  it("holds no unscoped removal allow in any agent file", () => {
    const offenders = [];
    for (const file of agentFiles()) {
      const content = readFileSync(join(ROOT, "agents", file), "utf8");
      for (const rule of permissionRules(content)) {
        if (rule.action === "shell" && rule.resource === "rm*" && rule.effect === "allow") {
          offenders.push(`${file}: rm* allow`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the force-add deny pairing in the committer", () => {
    const committer = readFileSync(join(ROOT, "agents", "committer.md"), "utf8");
    const shellRules = permissionRules(committer).filter((r) => r.action === "shell");
    const allowIdx = shellRules.findIndex((r) => r.resource === "git add*" && r.effect === "allow");
    const denyIdx = shellRules.findIndex((r) => r.resource === "git add -f*" && r.effect === "deny");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  it("bounds the note-delete channel to short-term notes", () => {
    const source = readPluginSource();
    const deleteSection = source.slice(source.indexOf('if (toolID === "memory_note_delete")'));
    expect(deleteSection).toContain("short-term");
    expect(deleteSection).not.toContain("byproduct");
    expect(deleteSection).not.toContain("/tmp/opencode");
  });
});
