import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Stale-evidence trap: reopening a milestone stamps its prior impl KDs as
// superseded in place while the registry row returns to in-progress. A fix-up
// write that preserves the stamp must not promote the row — the cross-check
// path never counts stamped files, so the write-hook check-off consults the
// same staleness predicate and the two agree on stamped rows. Self-contained:
// own temp dirs and fixtures, no dependence on live milestone state.
describe("Protocol-Gate stale-evidence trap", () => {
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
    tempRoot = mkdtempSync(join(tmpdir(), "pg-trap-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-trap-log-"));
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

  function readRegistry() {
    const files = readdirSync(knowledgeDir);
    const registry = files.find((f) => f.startsWith("milestones-"));
    return readFileSync(join(knowledgeDir, registry), "utf8");
  }

  // Drives the artisan impl-KD write hook exactly as the runtime does: the
  // before-hook fires first (check-off signal), then the runtime materializes
  // the file, which the cross-check path reads back from disk.
  async function artisanWrite(artisan, relPath, content) {
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: artisan, callID: `c-${Date.now()}-${Math.random()}` },
      { args: { filePath: relPath, content } }
    );
    createKD(relPath.split("/").pop(), content);
  }

  async function startSwarmWithRegistry(s, rows) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent(rows));
  }

  it("a checked-off row with only stamped evidence keeps the gate closed", async () => {
    const s = "trap-pair-1";
    await startSwarmWithRegistry(s, [["M6", "checked-off"]]);
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s, "superseded"));

    expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M6")).toBeNull();
    expect(hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M6").checkedOff).toBe(false);
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
  });

  it("an in-place write that preserves the stamp does not promote the reopened row", async () => {
    const s = "trap-stamped-write-2";
    await startSwarmWithRegistry(s, [["M6", "checked-off"]]);
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s));

    // The reopen stamps the prior evidence in place and returns the row.
    const reopened = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], { reopen: true, trigger: "test-reopen" });
    expect(reopened.ok).toBe(true);
    expect(readFileSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`), "utf8")).toContain("status: superseded");

    // The fix-up lands in place but carries the old stamp forward — the
    // write-hook check-off declines, so the registry and the cross-check
    // agree the row is still open.
    const fixBody = `${implKD(s, "superseded")}\n# Fix attempt (stamp preserved)\n`;
    await artisanWrite(`trap-stamped-write-2-art`, `knowledge/impl-M6-first-${s}-gen0.md`, fixBody);

    expect(readRegistry()).toContain("  M6: in-progress");
    expect(hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M6").checkedOff).toBe(false);
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
    const log = readFileSync(join(protocolLogDir, "protocol-gate.log"), "utf8");
    expect(log).toContain("STALE_CHECKOFF_DECLINED");
    expect(log).toContain("milestone M6");
  });

  it("a fresh canonical write promotes the reopened row and opens the gate", async () => {
    const s = "trap-fresh-write-3";
    await startSwarmWithRegistry(s, [["M6", "checked-off"]]);
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s));

    const reopened = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], { reopen: true, trigger: "test-reopen" });
    expect(reopened.ok).toBe(true);

    // Fresh evidence at a new canonical path carries a live status — both
    // paths agree the row is complete.
    const freshBody = `${implKD(s)}\n# Fix evidence\n`;
    await artisanWrite(`trap-fresh-write-3-art`, `knowledge/impl-M6-fix-${s}-gen0.md`, freshBody);

    expect(readRegistry()).toContain("  M6: checked-off");
    const crossCheck = hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M6");
    expect(crossCheck.checkedOff).toBe(true);
    expect(crossCheck.implKD).toBe(`impl-M6-fix-${s}-gen0.md`);
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
  });

  it.todo("a genuine in-place rewrite clears the stamp so the gate opens");
});
