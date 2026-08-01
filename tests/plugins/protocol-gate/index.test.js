import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Consolidated protocol-gate suite. One session-scoped describe with a single
// setUp/tearDown: state files are wiped before each test, and every KD/state
// fixture created for a tracked session ID is removed after each test. Session
// IDs are unique per test (sid()) so cleanup never touches real knowledge/ KDs.
describe("Protocol-Gate Plugin", () => {
  const knowledgeDir = join(process.cwd(), "knowledge");
  const stateDir = join(process.cwd(), "plugins", "protocol-gate", ".state");
  const logPath = join(process.cwd(), "plugins", "logs", "protocol-gate.log");
  const KEYWORDS = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
  const usedSids = new Set();
  let hooks;

  function sid(name) {
    usedSids.add(name);
    return name;
  }

  function createKD(filename, content = "test content") {
    try { mkdirSync(knowledgeDir, { recursive: true }); } catch (_) {}
    writeFileSync(join(knowledgeDir, filename), content);
  }

  // Writes a milestone registry fixture with the machine-readable
  // `## Milestone States` YAML block plus a human-readable details table —
  // the shape the Pathfinder produces at DECOMPOSE (template-milestones).
  function createRegistry(s, rows) {
    const yaml = rows.map(([id, state]) => `  ${id}: ${state}`).join("\n");
    const table = rows.map(([id, state]) => `| ${id} | desc | ${state} |`).join("\n");
    createKD(`milestones-feature-${s}.md`, `## Milestone States

\`\`\`yaml
milestones:
${yaml}
\`\`\`

## Milestone Details

| Milestone ID | Description | State |
| ------------ | ----------- | ----- |
${table}
`);
  }

  function removeKD(filename) {
    try { rmSync(join(knowledgeDir, filename)); } catch (_) {}
  }

  function statePath(s) {
    return join(stateDir, `.protocol-state-${s}.json`);
  }

  function overridePath(s) {
    return join(stateDir, `.override-${s}.json`);
  }

  async function initOverseer(s) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
  }

  // todowrite with all 12 lifecycle keywords — the lifecycle kickoff signal.
  async function todo(s, callID) {
    await hooks["tool.execute.before"](
      { tool: "todowrite", sessionID: s, callID },
      { args: { todos: KEYWORDS.map(k => ({ content: k })) } }
    );
  }

  beforeEach(async () => {
    // Wipe protocol state so no loadState leak from prior tests
    try {
      const files = readdirSync(stateDir);
      for (const f of files) {
        if (f.endsWith(".json")) {
          try { rmSync(join(stateDir, f)); } catch (_) {}
        }
      }
    } catch (_) {}
    hooks = await pluginModule.server({}, {});
  });

  afterEach(() => {
    // Remove session-scoped fixtures (KDs + state + override files) only
    for (const s of usedSids) {
      try {
        const files = readdirSync(knowledgeDir);
        for (const f of files) {
          if (f.endsWith(`-${s}.md`) || f.includes(`-${s}-gen`)) {
            try { rmSync(join(knowledgeDir, f)); } catch (_) {}
          }
        }
      } catch (_) {}
      try { rmSync(statePath(s)); } catch (_) {}
      try { rmSync(overridePath(s)); } catch (_) {}
    }
    usedSids.clear();
  });

  // Drives a full 12-phase lifecycle in one session via todowrite disk checks.
  // KDs are created with the -gen{gen} suffix (legacy naming when gen === 0).
  // When fromIntent is true the session is already at INTENT (e.g. after a
  // /phase recovery) and the opening todowrite is skipped.
  async function runLifecycle(s, gen, fromIntent = false) {
    const suffix = gen === 0 ? `-${s}.md` : `-${s}-gen${gen}.md`;
    if (!fromIntent) {
      await todo(s, "c1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    }
    createKD(`intent-a${suffix}`);
    await todo(s, "c2");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
    createKD(`preflight-a${suffix}`);
    await todo(s, "c3"); // PREFLIGHT skip consumed
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
    await todo(s, "c4");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    createKD(`exploration-a${suffix}`);
    await todo(s, "c5");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INVESTIGATE);
    createKD(`analysis-a${suffix}`);
    await todo(s, "c6");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.ALIGN);
    createKD(`spec-a${suffix}`);
    await todo(s, "c7");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.DECOMPOSE);
    createKD(`plan-a${suffix}`);
    createKD(`milestones-a${suffix}`);
    await todo(s, "c8");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    hooks.swarmDispatchCount.set(s, 1);
    createKD(`impl-a${suffix}`);
    await todo(s, "c9");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
    createKD(`review-a${suffix}`);
    await todo(s, "c10");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXTRACT);
    createKD(`composed-a${suffix}`);
    await todo(s, "c11");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EVOLVE);
    createKD(`process-a${suffix}`);
    await todo(s, "c12");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.CLEANUP);
    createKD(`cleanup-a${suffix}`);
    await todo(s, "c13");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.REPORT);
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c14" },
      { args: { filePath: `knowledge/report-a${suffix}`, content: "report" } }
    );
    expect(hooks.sessionPhaseMap.has(s)).toBe(false);
  }

  it("exports a PluginModule with server() returning the expected hooks", async () => {
    expect(pluginModule.id).toBe("protocol-gate");
    expect(typeof pluginModule.server).toBe("function");
    for (const hook of ["chat.params", "permission.ask", "tool.execute.before", "command.execute.before", "tool.definition", "experimental.chat.system.transform"]) {
      expect(typeof hooks[hook]).toBe("function");
    }
  });

  it("tracks overseer sessions at PROTOCOL_NOT_LOADED and ignores non-overseer sessions", async () => {
    const overseer = sid("init-1");
    const artisan = sid("init-2");
    await initOverseer(overseer);
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});

    expect(hooks.sessionPhaseMap.get(overseer)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    expect(hooks.overseerSessions.has(overseer)).toBe(true);
    expect(hooks.sessionPhaseMap.has(artisan)).toBe(false);
    expect(hooks.overseerSessions.has(artisan)).toBe(false);
  });

  it("transitions PROTOCOL_NOT_LOADED → INTENT on todowrite with all keywords; rejects incomplete todowrites", async () => {
    const s = sid("kw-1");
    await initOverseer(s);

    // The keyword gate applies only at lifecycle kickoff (PROTOCOL_NOT_LOADED).
    // A partial todowrite at kickoff is rejected without mutating the phase.
    await expect(
      hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: s, callID: "c1" },
        { args: { todos: [{ content: "INTENT" }, { content: "REPORT" }] } }
      )
    ).rejects.toThrow("Missing lifecycle keywords");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);

    await todo(s, "c2");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
  });

  it("does not advance past INTENT when no KD exists on disk (todowrite content alone never drives advancement)", async () => {
    const s = sid("jump-1");
    await initOverseer(s);
    await todo(s, "c1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    // Second todowrite fires a disk check; with no intent KD on disk the phase
    // stays at INTENT (or regresses to PROTOCOL_NOT_LOADED) — never beyond.
    await todo(s, "c2");
    expect(hooks.sessionPhaseMap.get(s)).toBeLessThanOrEqual(hooks.STATES.INTENT);
  });

  it("advances INTENT → PREFLIGHT only after an intent KD appears on disk (BUG-008 guard)", async () => {
    const s = sid("adv-1");
    await initOverseer(s);
    await todo(s, "c1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    createKD(`intent-a-${s}.md`);
    await todo(s, "c2");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
  });

  it("captures the session ID from an intent KD filename on write; without it no disk advancement happens", async () => {
    const s = sid("sess-1");
    await initOverseer(s);
    await todo(s, "c1");
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);

    // Write an intent KD whose filename carries the session ID
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c2" },
      { args: { filePath: `knowledge/intent-feature-${s}.md` } }
    );
    expect(hooks.sessionPhaseMap.get(`${s}:sid`)).toBe(s);

    // A session with no captured ID cannot advance via disk check
    const bare = sid("sess-2");
    await initOverseer(bare);
    hooks.sessionPhaseMap.set(bare, hooks.STATES.INTENT);
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: bare, callID: "c3" },
      { args: { filePath: "knowledge/intent-foo.md" } }
    );
    expect(hooks.sessionPhaseMap.get(bare)).toBe(hooks.STATES.INTENT);
  });

  it("restricts INTENT-phase writes to knowledge/intent-*.md and reads to knowledge/intent-*, templates, and skills", async () => {
    const s = sid("io-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);

    await expect(
      hooks["tool.execute.before"](
        { tool: "write", sessionID: s, callID: "c1" },
        { args: { filePath: "knowledge/intent-ok.md" } }
      )
    ).resolves.toBeUndefined();

    await expect(
      hooks["tool.execute.before"](
        { tool: "write", sessionID: s, callID: "c2" },
        { args: { filePath: "knowledge/spec-foo.md" } }
      )
    ).rejects.toThrow("Write to knowledge/intent-*.md");

    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c3" },
        { args: { filePath: "knowledge/intent-ok.md" } }
      )
    ).resolves.toBeUndefined();

    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c4" },
        { args: { filePath: "src/main.js" } }
      )
    ).rejects.toThrow("Read from template, skill, or knowledge/intent-*.md");
  });

  it("normalizes backslash and absolute Windows paths to project-relative knowledge/ paths (AC001–AC003)", async () => {
    const s = sid("win-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);

    // Backslash path, forward-slash path, and absolute Windows path all pass
    // INTENT write validation (phase stays INTENT — no session ID captured)
    for (const filePath of [
      `knowledge\\intent-foo.md`,
      "knowledge/intent-foo.md",
      "C:\\Users\\foo\\project\\knowledge\\intent-1.md",
    ]) {
      await expect(
        hooks["tool.execute.before"](
          { tool: "write", sessionID: s, callID: "c1" },
          { args: { filePath } }
        )
      ).resolves.toBeUndefined();
    }
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
  });

  it("honors backward transitions with BACKWARD: true and rejects wrong-agent dispatches (WRONG_AGENT)", async () => {
    const s = sid("bt-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.EVOLVE);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    // Scribe from EVOLVE → EXTRACT (backward transition)
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: s, callID: "c1" },
      { args: { prompt: "AGENT: scribe\nBACKWARD: true\nMODE: extract" } }
    );
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXTRACT);

    // Wrong-agent dispatch from EXPLORE without BACKWARD flag throws
    const s2 = sid("bt-2");
    await initOverseer(s2);
    hooks.sessionPhaseMap.set(s2, hooks.STATES.EXPLORE);
    hooks.sessionPhaseMap.set(`${s2}:sid`, s2);
    await expect(
      hooks["tool.execute.before"](
        { tool: "task", sessionID: s2, callID: "c1" },
        { args: { subagent_type: "artisan" } }
      )
    ).rejects.toThrow();
  });

  it("records in-flight dispatches for matching agents and regresses for mismatched agents (BUG-010 boundary)", async () => {
    // Matching agent (explorer in EXPLORE): no consistency regression
    const s1 = sid("disp-1");
    await initOverseer(s1);
    hooks.sessionPhaseMap.set(s1, hooks.STATES.EXPLORE);
    hooks.sessionPhaseMap.set(`${s1}:sid`, s1);
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: s1, callID: "c1" },
      { args: { subagent_type: "explorer", prompt: "AGENT: explorer\nExplore codebase" } }
    );
    expect(hooks.sessionPhaseMap.get(s1)).toBe(hooks.STATES.EXPLORE);
    expect(hooks.inFlightDispatches.get(s1)).toEqual(["exploration"]);

    // Mismatched agent (explorer in INVESTIGATE): consistency check regresses
    // to the phase matching the last KD on disk
    const s2 = sid("disp-2");
    await initOverseer(s2);
    hooks.sessionPhaseMap.set(s2, hooks.STATES.INVESTIGATE);
    hooks.sessionPhaseMap.set(`${s2}:sid`, s2);
    createKD(`exploration-explore-${s2}.md`);
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: s2, callID: "c1" },
      { args: { subagent_type: "explorer", prompt: "AGENT: explorer" } }
    );
    expect(hooks.sessionPhaseMap.get(s2)).toBe(hooks.STATES.EXPLORE);
  });

  it("saves state after advancement and restores it via loadState on restart; corrupt state files are ignored", async () => {
    const s = sid("persist-1");
    await initOverseer(s);
    await todo(s, "c1");
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c2" },
      { args: { filePath: `knowledge/intent-feature-${s}.md` } }
    );

    // State file persisted for the session
    const saved = JSON.parse(readFileSync(statePath(s), "utf8"));
    expect(saved.phase).toBe(hooks.STATES.INTENT);
    expect(saved.sid).toBe(s);

    // Fresh server instance restores phase + session ID from disk
    hooks = await pluginModule.server({}, {});
    await initOverseer(s);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    expect(hooks.sessionPhaseMap.get(`${s}:sid`)).toBe(s);

    // Corrupt state file must not crash loadState — session falls back to
    // PROTOCOL_NOT_LOADED
    const corrupt = sid("persist-2");
    writeFileSync(statePath(corrupt), "{not json");
    await initOverseer(corrupt);
    expect(hooks.sessionPhaseMap.get(corrupt)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
  });

  it("AC-R001: generation increments monotonically across lifecycle ends", async () => {
    const s = sid("gen-r001");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    // First lifecycle end via the edit handler
    await hooks["tool.execute.before"](
      { tool: "edit", sessionID: s, callID: "c1" },
      { args: { filePath: `knowledge/report-first-${s}.md` } }
    );
    expect(hooks.getCurrentGeneration(s)).toBe(1);
    expect(hooks.sessionPhaseMap.get(s)).toBeUndefined();
    expect(JSON.parse(readFileSync(statePath(s), "utf8")).generation).toBe(1);

    // Second lifecycle end via the write handler
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c2" },
      { args: { filePath: `knowledge/report-second-${s}.md`, content: "report" } }
    );
    expect(hooks.getCurrentGeneration(s)).toBe(2);
    expect(hooks.sessionPhaseMap.get(s)).toBeUndefined();
    expect(JSON.parse(readFileSync(statePath(s), "utf8")).generation).toBe(2);
  });

  it("AC-R002/EC-007: stale prior-generation and gen-less KDs cannot advance a gen-2 lifecycle", async () => {
    const s = sid("gen-r002");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 2);

    // Only stale gen-1 or gen-less KDs on disk → no advancement
    createKD(`intent-stale-${s}-gen1.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);
    createKD(`intent-genless-${s}.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

    // A current-generation gen-2 KD advances
    createKD(`intent-fresh-${s}-gen2.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
  });

  it("AC-R003: legacy state files without generation fall back to generation 0 with session-ID matching", async () => {
    const s = sid("gen-r003");
    writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.INTENT, timestamp: Date.now() }));
    await initOverseer(s);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    expect(hooks.getCurrentGeneration(s)).toBe(0);

    createKD(`intent-legacy-${s}.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
  });

  it("AC-R004: REPORT write deletes all session KDs (legacy + gen variants) and retains other sessions' KDs", async () => {
    const s = sid("reset-r004");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 2);

    createKD(`intent-old-${s}.md`);
    createKD(`intent-stale-${s}-gen1.md`);
    createKD(`intent-fresh-${s}-gen2.md`);
    createKD(`report-final-${s}.md`);
    createKD("intent-other-other-session.md"); // different session — must survive

    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c1" },
      { args: { filePath: `knowledge/report-final-${s}.md`, content: "report" } }
    );

    expect(existsSync(join(knowledgeDir, `intent-old-${s}.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, `intent-stale-${s}-gen1.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, `intent-fresh-${s}-gen2.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, `report-final-${s}.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, "intent-other-other-session.md"))).toBe(true);
    removeKD("intent-other-other-session.md");
  });

  it("AC-R005: after REPORT the phase entry is deleted so a manual state edit is honored on the next message", async () => {
    const s = sid("reset-r005");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    await hooks["tool.execute.before"](
      { tool: "edit", sessionID: s, callID: "c1" },
      { args: { filePath: `knowledge/report-recovery-${s}.md` } }
    );
    expect(hooks.sessionPhaseMap.has(s)).toBe(false);
    expect(hooks.getCurrentGeneration(s)).toBe(1);

    // Manual recovery: user edits the state file to force a phase
    writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.INTENT, generation: 1, sid: s, timestamp: Date.now() }));
    await initOverseer(s);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    expect(hooks.sessionPhaseMap.get(`${s}:sid`)).toBe(s);
  });

  it("AC-R006: /phase sets and persists a named or numeric phase; invalid values are rejected", async () => {
    const s = sid("phase-r006");
    await initOverseer(s);
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "INTENT" }, output);

    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    expect(output.parts[0].text).toContain("Phase set to INTENT (1) for session");
    expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.INTENT);

    for (const bad of ["99", "INVALID"]) {
      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: bad }, out);
      expect(out.parts[0].text).toContain("invalid phase");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    }
  });

  it("consumes /phase override files on chat.params; expired and malformed overrides are dropped", async () => {
    const s = sid("phase-file");
    writeFileSync(overridePath(s), JSON.stringify({ phase: hooks.STATES.EXPLORE, sessionID: s, createdAt: new Date().toISOString() }));
    await initOverseer(s);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(existsSync(overridePath(s))).toBe(false);

    // Expired override (6+ min old) is not applied
    const ttl = sid("phase-ttl");
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    writeFileSync(overridePath(ttl), JSON.stringify({ phase: hooks.STATES.REPORT, sessionID: ttl, createdAt: old }));
    await initOverseer(ttl);
    expect(hooks.sessionPhaseMap.get(ttl)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    expect(existsSync(overridePath(ttl))).toBe(false);

    // Malformed override is removed without applying
    const bad = sid("phase-bad");
    writeFileSync(overridePath(bad), "{not json");
    await initOverseer(bad);
    expect(hooks.sessionPhaseMap.get(bad)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    expect(existsSync(overridePath(bad))).toBe(false);
  });

  it("AC-R008: a second lifecycle stays at INTENT — stale prior-lifecycle KDs never advance it prematurely", async () => {
    const s = sid("wf-r008");
    await initOverseer(s);
    await runLifecycle(s, 0);
    expect(hooks.getCurrentGeneration(s)).toBe(1);

    // Stale prior-lifecycle KDs appear on disk (e.g. a race after cleanup)
    createKD(`intent-stale-legacy-${s}.md`);
    createKD(`intent-stale-gen0-${s}-gen0.md`);
    createKD(`preflight-stale-${s}-gen0.md`);

    await initOverseer(s);
    await todo(s, "s1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

    // A valid gen-1 intent KD advances the second lifecycle normally
    createKD(`intent-second-${s}-gen1.md`);
    await todo(s, "s2");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
  });

  it("AC-R009: three lifecycle restarts — generation matches the cycle number and no stale KDs remain", async () => {
    const s = sid("gen-r009");
    await initOverseer(s);
    for (let cycle = 1; cycle <= 3; cycle++) {
      await runLifecycle(s, cycle - 1);
      expect(hooks.getCurrentGeneration(s)).toBe(cycle);
      const leftover = readdirSync(knowledgeDir).filter(f => f.includes(`-${s}`));
      expect(leftover).toHaveLength(0);
      await initOverseer(s);
      expect(hooks.getCurrentGeneration(s)).toBe(cycle);
    }
  });

  it("AC-R010: recovery from a stuck PREFLIGHT via /phase INTENT — lifecycle completes to REPORT", async () => {
    const s = sid("rec-r010");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.PREFLIGHT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "INTENT" }, output);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    await expect(
      hooks["tool.execute.before"](
        { tool: "write", sessionID: s, callID: "r1" },
        { args: { filePath: `knowledge/intent-rec-${s}.md`, content: "## Raw Request\nfix phase\n## Triage Notes\nnone\n## Next Steps\nimplement\n## Process Friction\nnone" } }
      )
    ).resolves.toBeUndefined();
    createKD(`intent-rec-${s}.md`);

    await runLifecycle(s, 0, true);
    expect(hooks.getCurrentGeneration(s)).toBe(1);
  });

  it("BUG-009: VERIFY advances to EXTRACT with only a review KD or only an audit KD (OR fix)", async () => {
    for (const prefix of ["review", "audit"]) {
      const s = sid(`ror-${prefix}`);
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createKD(`${prefix}-ror-${s}.md`);

      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXTRACT);
    }
  });

  it("R003: DECOMPOSE advances only when BOTH plan- and milestones- KDs exist (dual-KD gate)", async () => {
    const s = sid("decomp-dual");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.DECOMPOSE);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    // plan- alone: no advancement (EC03 — registry missing at DECOMPOSE)
    createKD(`plan-only-${s}.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

    // milestones- alone: no advancement (plan is the primary DECOMPOSE artifact)
    removeKD(`plan-only-${s}.md`);
    createKD(`milestones-only-${s}.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

    // both plan- + milestones-: advancement
    createKD(`plan-both-${s}.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
  });

  it("R003: stale-generation milestones registry does not advance DECOMPOSE (generation scoping)", async () => {
    const s = sid("decomp-gen");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.DECOMPOSE);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 2);

    // Current-gen plan but stale gen-1 registry → blocked (only the plan matches)
    createKD(`plan-cur-${s}-gen2.md`);
    createKD(`milestones-stale-${s}-gen1.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

    // Current-gen registry completes the pair → advancement
    createKD(`milestones-cur-${s}-gen2.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
  });

  it("M2: SWARM phase reads are restricted to plan and milestone registry KDs (dispatcher visibility)", async () => {
    const s = sid("swarm-read-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    // plan- and milestones- KDs are readable — the Overseer can see the plan
    // and milestone state to drive per-milestone artisan dispatches.
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c1" },
        { args: { filePath: `knowledge/plan-feature-${s}.md` } }
      )
    ).resolves.toBeUndefined();

    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c2" },
        { args: { filePath: `knowledge/milestones-feature-${s}.md` } }
      )
    ).resolves.toBeUndefined();

    // Absolute path form is normalized to project-relative and accepted
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c3" },
        { args: { filePath: `/home/user/project/knowledge/plan-feature-${s}.md` } }
      )
    ).resolves.toBeUndefined();

    // Other KDs and non-KD files stay blocked during SWARM
    for (const bad of [
      `knowledge/impl-feature-${s}.md`,
      `knowledge/spec-feature-${s}.md`,
      `knowledge/review-feature-${s}.md`,
      "src/main.js",
      "opencode.json",
    ]) {
      await expect(
        hooks["tool.execute.before"](
          { tool: "read", sessionID: s, callID: "c4" },
          { args: { filePath: bad } }
        )
      ).rejects.toThrow("Read from knowledge/plan-*.md or knowledge/milestones-*.md");
    }
  });

  describe("M3: per-milestone dispatch — registry state wiring", () => {
    it("transitions the dispatched milestone pending → assigned → in-progress in the registry YAML block", async () => {
      const s = sid("m3-reg-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "pending"], ["M2", "pending"]]);

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "c1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M2\nMODE: swarm" } }
      );

      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      // The machine-readable YAML block is the state SSOT — it is updated...
      expect(content).toContain("  M2: in-progress");
      expect(content).toContain("  M1: pending");
      // ...while the human-readable details table stays untouched.
      expect(content).toContain("| M2 | desc | pending |");
    });

    it("advances the completed milestone in-progress → checked-off in the registry YAML block", async () => {
      const s = sid("m4-reg-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M4", "in-progress"], ["M5", "pending"]]);

      const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M4", ["checked-off"]);
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M4: checked-off");
      expect(content).toContain("  M5: pending");
      // human-readable details table stays untouched
      expect(content).toContain("| M4 | desc | in-progress |");
    });

    it("rejects checked-off from pending — only in-progress milestones can complete", async () => {
      const s = sid("m4-reg-2");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M4", "pending"]]);

      const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M4", ["checked-off"]);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("invalid-transition");
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M4: pending");
    });

    it("leaves an already checked-off row untouched (idempotent)", async () => {
      const s = sid("m4-reg-3");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M4", "checked-off"]]);

      const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M4", ["checked-off"]);
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false);
    });

    it("extractMilestoneIdFromImplKD parses the milestone-scoped impl KD naming contract", async () => {
      expect(hooks.extractMilestoneIdFromImplKD("impl-M4-milestone-tracking-ses_x-gen0.md")).toBe("M4");
      expect(hooks.extractMilestoneIdFromImplKD("impl-m3-foo-ses_x-gen0.md")).toBe("m3");
      // legacy unscoped impl KD — no milestone contract token
      expect(hooks.extractMilestoneIdFromImplKD("impl-fix-auth-flow-ses_123-gen2.md")).toBe("fix");
      expect(hooks.extractMilestoneIdFromImplKD("milestones-feature-ses_x.md")).toBeNull();
      expect(hooks.extractMilestoneIdFromImplKD(null)).toBeNull();
    });

    it("findMilestoneImplKD locates the milestone-scoped impl KD on disk (generation-scoped)", async () => {
      const s = sid("m4-find-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createKD(`impl-M4-feature-${s}.md`);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M4")).toBe(`impl-M4-feature-${s}.md`);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M5")).toBeNull();

      // generation scoping: stale prior-generation impl KD does not count
      hooks.sessionPhaseMap.set(`${s}:gen`, 2);
      createKD(`impl-M4-stale-${s}-gen1.md`);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M4")).toBeNull();
      createKD(`impl-M4-fresh-${s}-gen2.md`);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M4")).toBe(`impl-M4-fresh-${s}-gen2.md`);
    });

    it("checkMilestoneCheckedOff cross-checks the registry row against its impl KD on disk", async () => {
      const s = sid("m4-xchk-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);

      // checked-off row WITHOUT its impl KD → treated as not checked off (M5 gate semantics)
      createRegistry(s, [["M4", "checked-off"]]);
      const missing = hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M4");
      expect(missing.checkedOff).toBe(false);
      expect(missing.implKDOnDisk).toBe(false);
      expect(missing.state).toBe("checked-off");

      // checked-off row WITH its impl KD → genuinely checked off
      createKD(`impl-M4-feature-${s}.md`);
      const present = hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M4");
      expect(present.checkedOff).toBe(true);
      expect(present.implKDOnDisk).toBe(true);
      expect(present.implKD).toBe(`impl-M4-feature-${s}.md`);

      // in-progress row → not checked off even with an impl KD on disk
      createRegistry(s, [["M4", "in-progress"]]);
      const inProgress = hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M4");
      expect(inProgress.checkedOff).toBe(false);
    });

    it("marks a milestone checked-off when the artisan writes its milestone-scoped impl KD", async () => {
      const overseer = sid("m4-auto-1");
      await initOverseer(overseer);
      hooks.sessionPhaseMap.set(overseer, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${overseer}:sid`, overseer);
      createRegistry(overseer, [["M4", "in-progress"]]);

      const artisan = sid("m4-auto-art");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "c1" },
        { args: { filePath: `knowledge/impl-M4-feature-${overseer}.md`, content: "# IMPLEMENTATION SUMMARY" } }
      );

      const content = readFileSync(join(knowledgeDir, `milestones-feature-${overseer}.md`), "utf8");
      expect(content).toContain("  M4: checked-off");
    });

    it("does not check off when the impl KD uses the legacy unscoped naming", async () => {
      const overseer = sid("m4-auto-2");
      await initOverseer(overseer);
      hooks.sessionPhaseMap.set(overseer, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${overseer}:sid`, overseer);
      createRegistry(overseer, [["M4", "in-progress"]]);

      const artisan = sid("m4-auto-art2");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "c1" },
        { args: { filePath: `knowledge/impl-feature-${overseer}.md`, content: "# IMPLEMENTATION SUMMARY" } }
      );

      const content = readFileSync(join(knowledgeDir, `milestones-feature-${overseer}.md`), "utf8");
      expect(content).toContain("  M4: in-progress");
    });

    it("does not touch the registry when no overseer session is in SWARM", async () => {
      const overseer = sid("m4-auto-3");
      await initOverseer(overseer);
      hooks.sessionPhaseMap.set(overseer, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${overseer}:sid`, overseer);
      createRegistry(overseer, [["M4", "in-progress"]]);

      const artisan = sid("m4-auto-art3");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "c1" },
        { args: { filePath: `knowledge/impl-M4-feature-${overseer}.md`, content: "# IMPLEMENTATION SUMMARY" } }
      );

      const content = readFileSync(join(knowledgeDir, `milestones-feature-${overseer}.md`), "utf8");
      expect(content).toContain("  M4: in-progress");
    });

    it("leaves the registry untouched when the dispatch carries no MILESTONE ID", async () => {
      const s = sid("m3-reg-2");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "pending"], ["M2", "pending"]]);

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "c1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMODE: swarm" } }
      );

      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M2: pending");
      expect(hooks.swarmDispatchCount.get(s)).toBe(1);
    });

    it("extractMilestoneIdFromPrompt parses field variants and returns null when absent", async () => {
      expect(hooks.extractMilestoneIdFromPrompt("AGENT: artisan\nMILESTONE ID: M3\nMODE: swarm")).toBe("M3");
      expect(hooks.extractMilestoneIdFromPrompt("MILESTONE_ID: M3\nMODE: swarm")).toBe("M3");
      expect(hooks.extractMilestoneIdFromPrompt("**MILESTONE ID:** **M3**")).toBe("M3");
      expect(hooks.extractMilestoneIdFromPrompt("AGENT: artisan\nMODE: swarm")).toBeNull();
      expect(hooks.extractMilestoneIdFromPrompt(null)).toBeNull();
    });

    it("updateMilestoneRegistry skips without throwing when no registry file exists", async () => {
      const s = sid("m3-reg-3");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);

      const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M3", ["assigned", "in-progress"]);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("no-registry");
    });
  });

  it("M2: SWARM allowlist includes read and tool.definition shows the read restriction", async () => {
    const s = sid("swarm-def-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    // read is in the SWARM allowlist and carries the plan/registry restriction
    const readOut = { description: "Test read", parameters: {} };
    await hooks["tool.definition"]({ toolID: "read" }, readOut);
    expect(readOut.description).not.toContain("⛔");
    expect(readOut.description).toContain("SWARM phase restriction: ONLY plan and milestone registry KDs");

    // A tool still outside the SWARM allowlist keeps the blocking notice
    const editOut = { description: "Test edit", parameters: {} };
    await hooks["tool.definition"]({ toolID: "edit" }, editOut);
    expect(editOut.description).toContain("⛔");
  });

  it("enforces checkpoint-KD ownership: artisan blocked, committer allowed (R100)", async () => {
    const overseer = sid("ck-ses");
    await initOverseer(overseer);
    hooks.sessionPhaseMap.set(overseer, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${overseer}:sid`, overseer);

    const artisan = sid("ck-art");
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    await expect(
      hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "c1" },
        { args: { filePath: `knowledge/checkpoint-test-${overseer}.md`, content: "# Checkpoint" } }
      )
    ).rejects.toThrow("CHECKPOINT VIOLATION");

    const committer = sid("ck-com");
    await hooks["chat.params"]({ sessionID: committer, agent: "committer" }, {});
    await expect(
      hooks["tool.execute.before"](
        { tool: "write", sessionID: committer, callID: "c2" },
        { args: { filePath: `knowledge/checkpoint-test-${overseer}.md`, content: "# Checkpoint" } }
      )
    ).resolves.toBeUndefined();
  });

  it("blocks non-allowlisted tools in tool.definition while task always passes", async () => {
    const s = sid("def-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);

    // INTENT allowlist is todowrite, write, read, skill, bash — every other
    // tool (except task) gets the ⛔ blocking prefix.
    for (const tool of ["edit", "glob", "grep"]) {
      const output = { description: `Test ${tool}`, parameters: {} };
      await hooks["tool.definition"]({ toolID: tool }, output);
      expect(output.description).toContain("⛔");
    }
    const taskOut = { description: "Test task", parameters: {} };
    await hooks["tool.definition"]({ toolID: "task" }, taskOut);
    expect(taskOut.description).not.toContain("⛔");
  });

  it("injects phase guidance with generation-scoped naming into system.transform during INTENT", async () => {
    const s = sid("sys-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 2);
    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: s }, output);

    expect(output.system[1]).toContain(`knowledge/intent-{name}-${s}-gen2.md`);
    expect(output.system).toHaveLength(2); // appended, existing entries untouched
  });

  it("AC-R007: debug logs capture generation increment, stale-KD cleanup, and generation-scoped disk checks", async () => {
    try { rmSync(logPath); } catch (_) {}
    process.env.PROTOCOL_GATE_DEBUG = "1";
    try {
      const s = sid("dbg-r007");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);

      createKD(`intent-stale-${s}.md`);
      await hooks["tool.execute.before"](
        { tool: "edit", sessionID: s, callID: "c1" },
        { args: { filePath: `knowledge/report-debug-${s}.md` } }
      );
      expect(hooks.getCurrentGeneration(s)).toBe(1);

      const output = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "INTENT" }, output);

      hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.sessionPhaseMap.set(`${s}:gen`, 2);
      createKD(`intent-stale2-${s}-gen1.md`);
      createKD(`intent-match-${s}-gen2.md`);
      hooks.checkDiskAdvancement(s, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount);

      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("Generation 0 → 1");
      expect(log).toContain("Cleanup of 1 stale KDs");
      expect(log).toContain("Phase override: INTENT (1)");
      expect(log).toContain("generation mismatch (file=1, current=2)");
      expect(log).toContain("Disk check INTENT:");
    } finally {
      delete process.env.PROTOCOL_GATE_DEBUG;
      try { rmSync(logPath); } catch (_) {}
    }
  });
});
