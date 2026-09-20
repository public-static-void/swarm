import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// M5 (swarm/1) regression: the live check-off hook (autoCheckOffMilestone)
// matches impl-KD evidence via matchesSessionKDAnyGeneration — session-id
// match mandatory, generation wildcarded — aligned with the disk-evidence
// predicate findMilestoneImplKD. A VERIFY FAIL backtrack that skews the
// persisted generation must not block valid same-session evidence from
// re-firing the check-off. Self-contained: own temp dirs and fixtures, no
// dependence on live milestone state.
describe("Protocol-Gate matcher re-arm (swarm/1)", () => {
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
    tempRoot = mkdtempSync(join(tmpdir(), "pg-rearm-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-rearm-log-"));
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

  // The observed gen0/gen1 divergence behind Issue 64: the artisan's valid
  // canonical evidence carries an embedded generation that differs from the
  // persisted lifecycle generation after a VERIFY FAIL backtrack. The
  // registry fixture stays legacy-named (generation 0, as the
  // generation-scoped registry lookup expects); only the evidence filename
  // diverges — exactly the skew the strict live-hook matcher choked on.
  async function writeImplKD(artisan, filePath) {
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: artisan, callID: `c-${Date.now()}` },
      { args: { filePath, content: "# IMPLEMENTATION SUMMARY (fix)" } }
    );
    createKD(filePath.split("/").pop());
  }

  it("reopen → canonical rewrite with skewed generation re-checks off with no /phase override", async () => {
    const s = "m5-rearm-1";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    // Post-reopen state: the row is back in-progress awaiting fresh evidence.
    createKD(`milestones-feature-${s}.md`, registryContent([["M5", "in-progress"]]));

    // Canonical rewrite whose embedded generation (gen1) diverges from the
    // persisted lifecycle generation (gen0) — the strict matcher stalls here.
    await writeImplKD("m5-rearm-1-art", `knowledge/impl-M5-fix-${s}-gen1.md`);

    const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
    expect(content).toContain("  M5: checked-off");
    expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`)).toBeUndefined();
  });

  it("foreign-session evidence never checks off a row (session-id match stays mandatory)", async () => {
    const s = "m5-rearm-2";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M5", "in-progress"]]));

    await writeImplKD("m5-rearm-2-art", "knowledge/impl-M5-fix-ses_foreign-gen0.md");

    const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
    expect(content).toContain("  M5: in-progress");
  });

  it("the strict writer still guards transitions: a non-in-progress row never checks off", async () => {
    const s = "m5-rearm-3";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M5", "planned"]]));

    await writeImplKD("m5-rearm-3-art", `knowledge/impl-M5-fix-${s}-gen0.md`);

    const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
    expect(content).toContain("  M5: planned");
  });
});
