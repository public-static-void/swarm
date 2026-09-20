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

  it("a rewrite after backtrack stays checked off while the same fail verdict is unchanged", async () => {
    const s = "m5-rearm-4";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M5", "checked-off"]]));
    const draftImpl = `---\ntitle: "IMPLEMENTATION SUMMARY: test"\nversion: 3.0.0\nstatus: draft\ntype: impl\nsession_id: "ses_test"\nauthor: Artisan\nsuperseded_by: null\n---\n\n# IMPLEMENTATION SUMMARY: test\n`;
    const reviewName = `review-fail-${s}.md`;
    createKD(reviewName, `---\ntitle: "REVIEW: test"\nversion: 1.0.0\nstatus: draft\ntype: review\nsession_id: "ses_test"\nauthor: Inspector\nsuperseded_by: null\nverdict: FAIL\n---\n\n# REVIEW: test\n\n## Verdict\n\nFAIL\n\n## Review Findings\n\n### F001: defect\n\n- **Milestone citation**: impl-M5 defect\n- **Status**: FAIL\n`);
    createKD(`impl-M5-fix-${s}-gen0.md`, draftImpl);

    // The FAIL verdict regresses VERIFY→SWARM, reopens M5, and stamps the
    // prior evidence superseded.
    await hooks["tool.execute.before"](
      { tool: "glob", sessionID: s, callID: "c1" },
      { args: { pattern: "knowledge/*.md" } }
    );
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M5: in-progress");

    // The fix cycle rewrites canonical draft evidence — the live hook
    // re-fires and checks the row off.
    await hooks["chat.params"]({ sessionID: `${s}-art`, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: `${s}-art`, callID: "c2" },
      { args: { filePath: `knowledge/impl-M5-fix-${s}-gen0.md`, content: draftImpl } }
    );
    createKD(`impl-M5-fix-${s}-gen0.md`, draftImpl);
    expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M5: checked-off");

    // Back in VERIFY with the SAME unchanged FAIL verdict: the consumed
    // verdict must not regress again — no reopen, no re-stamp of the fresh
    // evidence.
    hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
    await hooks["tool.execute.before"](
      { tool: "glob", sessionID: s, callID: "c3" },
      { args: { pattern: "knowledge/*.md" } }
    );
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
    expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M5: checked-off");
    expect(readFileSync(join(knowledgeDir, `impl-M5-fix-${s}-gen0.md`), "utf8")).toContain("status: draft");
  });
});
