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
  };

  // Drives the full write lifecycle including the post-write hook: the
  // before-hook fires first (check-off signal, stamp-clear deferral), then
  // the runtime materializes the file, then the after-hook settles any
  // deferred stamp clear (re-verify, clear in place, promote) and evaluates
  // the post-write SWARM→VERIFY auto-advance.
  async function artisanWriteAndLand(artisan, relPath, content) {
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    const callID = `c-${Date.now()}-${Math.random()}`;
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: artisan, callID },
      { args: { filePath: relPath, content } }
    );
    createKD(relPath.split("/").pop(), content);
    await hooks["tool.execute.after"](
      { tool: "write", sessionID: artisan, callID },
      {}
    );
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

    // The fix-up lands in place as a byte-identical re-write of the stamped
    // snapshot — no new work past the stamp — so the write-hook check-off
    // declines, and the registry and the cross-check agree the row is open.
    // (A rewrite carrying new bytes past the stamp is genuine post-stamp work
    // and clears instead — covered by the clearing cases below.)
    const stampedSnapshot = readFileSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`), "utf8");
    expect(stampedSnapshot).toContain("status: superseded");
    await artisanWrite(`trap-stamped-write-2-art`, `knowledge/impl-M6-first-${s}-gen0.md`, stampedSnapshot);

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

  it("a genuine in-place rewrite clears the stamp so the gate opens", async () => {
    const s = "trap-clear-rewrite-4";
    const artisan = "trap-clear-rewrite-4-art";
    const relPath = `knowledge/impl-M6-first-${s}-gen0.md`;
    await startSwarmWithRegistry(s, [["M6", "checked-off"]]);
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s));

    const reopened = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], { reopen: true, trigger: "test-reopen" });
    expect(reopened.ok).toBe(true);

    // The fix-up lands in place preserving the reopen stamp, but its bytes
    // differ from the stamped snapshot — genuine post-stamp work. Promotion
    // defers until the landed bytes are verified, so the row stays open
    // before the file lands.
    const fixBody = `${implKD(s, "superseded")}\n# Fix evidence: rebuilt behavior\n`;
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    const callID = "c-trap-clear-4";
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: artisan, callID },
      { args: { filePath: relPath, content: fixBody } }
    );
    expect(readRegistry()).toContain("  M6: in-progress");

    createKD(`impl-M6-first-${s}-gen0.md`, fixBody);
    await hooks["tool.execute.after"](
      { tool: "write", sessionID: artisan, callID },
      {}
    );

    // The gate cleared the stamp in place: a live draft with lineage to the
    // invalidated pass, and the fix-up body preserved below the frontmatter.
    const landed = readFileSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`), "utf8");
    expect(landed).toContain("status: draft");
    expect(landed).toContain(`superseded_by: impl-M6-first-${s}-gen0.md`);
    expect(landed).toContain("# Fix evidence: rebuilt behavior");
    expect(readRegistry()).toContain("  M6: checked-off");
    expect(hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M6").checkedOff).toBe(true);
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
    const log = readFileSync(join(protocolLogDir, "protocol-gate.log"), "utf8");
    expect(log).toContain("STAMP_CLEAR_PENDING");
    expect(log).toContain("STAMP_CLEARED");
    expect(log).toContain("milestone M6");
  });

  it("a fix-up that already carries live frontmatter records lineage and promotes", async () => {
    const s = "trap-clear-live-5";
    await startSwarmWithRegistry(s, [["M6", "checked-off"]]);
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s));

    hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], { reopen: true, trigger: "test-reopen" });

    // The fix-up rewrites the frontmatter to draft itself but carries no
    // lineage yet — the gate records superseded_by on landing, then promotes.
    const fixBody = `${implKD(s)}\n# Fix evidence: rebuilt behavior\n`;
    await artisanWriteAndLand(`trap-clear-live-5-art`, `knowledge/impl-M6-first-${s}-gen0.md`, fixBody);

    const landed = readFileSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`), "utf8");
    expect(landed).toContain("status: draft");
    expect(landed).toContain(`superseded_by: impl-M6-first-${s}-gen0.md`);
    expect(readRegistry()).toContain("  M6: checked-off");
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
    const log = readFileSync(join(protocolLogDir, "protocol-gate.log"), "utf8");
    expect(log).toContain("STAMP_LINEAGE_RECORDED");
  });

  it("the remediation path names frontmatter-stamped evidence distinctly and leaves the row open", async () => {
    const s = "trap-remediate-stamp-6";
    await startSwarmWithRegistry(s, [["M6", "in-progress"]]);
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s, "superseded"));

    const result = hooks.reconcileSupersededMilestone(s, hooks.sessionPhaseMap, "M6", "overseer");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("frontmatter-stamped-evidence");
    expect(result.evidence).toContain(`impl-M6-first-${s}-gen0.md`);
    expect(readRegistry()).toContain("  M6: in-progress");
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
    const log = readFileSync(join(protocolLogDir, "protocol-gate.log"), "utf8");
    expect(log).toContain("STAMPED_EVIDENCE");
    expect(log).toContain("milestone M6");
    expect(log).toContain(`impl-M6-first-${s}-gen0.md`);
  });

  it("FAIL reopen then genuine fix-up advances SWARM to VERIFY with zero manual phase override", async () => {
    const s = "trap-sequence-7";
    await startSwarmWithRegistry(s, [["M6", "checked-off"]]);
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s));
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);

    // FAIL verdict effect: the cited checked-off row reopens and its prior
    // evidence stamps in place — the gate closes on the stale evidence.
    hooks.reopenCheckedOffMilestones(s, hooks.sessionPhaseMap, ["M6"], "review FAIL test-reopen");
    expect(readRegistry()).toContain("  M6: in-progress");
    expect(readFileSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`), "utf8")).toContain("status: superseded");
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);

    // Genuine in-place fix-up (stamp preserved in the incoming bytes, new
    // work below the frontmatter) clears on landing and re-completes the row.
    const fixBody = `${implKD(s, "superseded")}\n# Fix evidence: addresses review findings\n`;
    await artisanWriteAndLand(`trap-sequence-7-art`, `knowledge/impl-M6-first-${s}-gen0.md`, fixBody);

    const landed = readFileSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`), "utf8");
    expect(landed).toContain("status: draft");
    expect(readRegistry()).toContain("  M6: checked-off");
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
    // Disk-advancement precedes agent routing with zero manual override: the
    // parent session advanced SWARM→VERIFY through the evidence path.
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
    expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`)).toBeUndefined();
  });
});
