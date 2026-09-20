import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Frontmatter-only supersession: reopening a milestone stamps its prior impl
// KDs as superseded in place — filenames stay canonical, so the evidence
// linkage keyed on stable names cannot orphan. Self-contained: own temp dirs
// and fixtures, no dependence on live milestone state.
describe("Protocol-Gate frontmatter supersession", () => {
  let tempRoot;
  let knowledgeDir;
  let stateDir;
  let protocolLogDir;
  let priorKnowledgeDir;
  let priorStateDir;
  let priorLogDir;
  let priorDebug;
  let hooks;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-supersede-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-supersede-log-"));
    process.env.PROTOCOL_GATE_LOG_DIR = protocolLogDir;
    process.env.PROTOCOL_GATE_DEBUG = "1";
  });

  afterAll(() => {
    if (priorKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorKnowledgeDir;
    if (priorStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
    else process.env.PROTOCOL_GATE_STATE_DIR = priorStateDir;
    if (priorLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = priorLogDir;
    if (priorDebug === undefined) delete process.env.PROTOCOL_GATE_DEBUG;
    else process.env.PROTOCOL_GATE_DEBUG = priorDebug;
    rmSync(protocolLogDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rmSync(knowledgeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    hooks = await pluginModule.server({}, {});
  });

  function createKD(filename, content = "test content") {
    writeFileSync(join(knowledgeDir, filename), content);
  }

  function implKD(sessionID, status = "draft") {
    return `---
title: "IMPLEMENTATION SUMMARY: test"
version: 1.0.0
status: ${status}
type: impl
session_id: "${sessionID}"
author: Artisan
superseded_by: null
---

# IMPLEMENTATION SUMMARY: test
`;
  }

  function registryContent(rows) {
    const yaml = rows.map(([id, state]) => `  ${id}: ${state}`).join("\n");
    const table = rows.map(([id, state]) => `| ${id} | desc | ${state} |`).join("\n");
    return `## Milestone States

\`\`\`yaml
milestones:
${yaml}
\`\`\`

## Milestone Details

| Milestone ID | Description | State |
| ------------ | ----------- | ----- |
${table}
`;
  }

  async function writeImplKD(artisan, filePath) {
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: artisan, callID: `c-${Date.now()}` },
      { args: { filePath, content: "# IMPLEMENTATION SUMMARY (fix)" } }
    );
    createKD(filePath.split("/").pop());
  }

  function knowledgeFiles() {
    return readdirSync(knowledgeDir);
  }

  it("reopen stamps prior evidence in place and fresh evidence re-completes the row with no phase override", async () => {
    const s = "m6-supersede-1";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M6", "checked-off"]]));
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s));
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);

    // Reopen invalidates the prior evidence in place: the canonical file
    // stays, its frontmatter is stamped, and no renamed copy appears.
    const reopened = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], { reopen: true, trigger: "test-reopen" });
    expect(reopened.ok).toBe(true);
    expect(existsSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md.superseded.md`))).toBe(false);
    const stale = readFileSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`), "utf8");
    expect(stale).toContain("status: superseded");
    expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M6")).toBeNull();

    // The stale file no longer re-checks off the row — the gate stays closed.
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);

    // Fresh canonical evidence re-completes the row without any override.
    await writeImplKD("m6-supersede-1-art", `knowledge/impl-M6-fix-${s}-gen0.md`);
    const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
    expect(content).toContain("  M6: checked-off");
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
    expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`)).toBeUndefined();
  });

  it("a stamped file alone never counts as completion evidence and is named loudly", async () => {
    const s = "m6-supersede-2";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M6", "in-progress"]]));
    createKD(`impl-M6-old-${s}-gen0.md`, implKD(s, "superseded"));

    expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M6")).toBeNull();
    expect(hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M6").checkedOff).toBe(false);
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
    const log = readFileSync(join(protocolLogDir, "protocol-gate.log"), "utf8");
    expect(log).toContain("STALE_EVIDENCE");
    expect(log).toContain("milestone M6");
    expect(log).toContain(`impl-M6-old-${s}-gen0.md`);
  });

  it("repeated reopens never accumulate filename suffixes", async () => {
    const s = "m6-supersede-3";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M6", "checked-off"]]));
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s));

    hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], { reopen: true, trigger: "test-reopen-1" });
    await writeImplKD("m6-supersede-3-art", `knowledge/impl-M6-fix-${s}-gen0.md`);
    expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M6: checked-off");
    hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], { reopen: true, trigger: "test-reopen-2" });

    const renamed = knowledgeFiles().filter((f) => f.endsWith(".superseded.md"));
    expect(renamed).toEqual([]);
    expect(existsSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `impl-M6-fix-${s}-gen0.md`))).toBe(true);
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
  });

  it("the remediation path restores a legacy renamed file to its canonical name and completes the row", async () => {
    const s = "m6-supersede-4";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M6", "in-progress"]]));
    createKD(`impl-M6-stale-${s}-gen1.md.superseded.md`, implKD(s));

    const result = hooks.reconcileSupersededMilestone(s, hooks.sessionPhaseMap, "M6", "overseer");
    expect(result.ok).toBe(true);
    expect(result.evidence).toContain(`impl-M6-stale-${s}-gen1.md`);
    expect(existsSync(join(knowledgeDir, `impl-M6-stale-${s}-gen1.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `impl-M6-stale-${s}-gen1.md.superseded.md`))).toBe(false);
    expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M6: checked-off");
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
  });
});
