import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";
import delegationPlugin from "../../../plugins/delegation-gate/index.js";

// Consolidated protocol-gate suite (P305 + P402): 78 → 70 tests. Parallel
// one-off accepts (AC101/AC102, AC103 write+edit, AC013 gen0+genN, M4 AC017
// variants, AC019 force-advance paths, tool.definition phases, system.transform
// phases, R003 dual-KD+generation, milestone-ID parsers, AC016
// reopen+immutability, todowrite advancement pair) are merged into
// parameterized tests; the duplicated "saves state after advancement" test was
// removed (covered by AC002/AC003/AC006). The M1 GENERATION-fallback test
// relocated here from the delegation-gate suite (R306) — it reads the
// delegation-gate fallback through this suite's temp PROTOCOL_GATE_STATE_DIR.
// M4 anchored-fence tests (R310–R311/AC310) added in P402: glued heading+fence,
// well-formed whitespace-gap fixture, fail-closed for foreign content between
// heading and YAML block. One session-scoped describe with a single
// setUp/tearDown: knowledge and state dirs are real temp dirs (P302), recreated
// before each test, so no test touches the real knowledge/ or
// plugins/protocol-gate/.state (NFR004/AC307). Session IDs are unique per test
// (sid()) and the dirs are wiped between tests, so fixtures never collide.
describe("Protocol-Gate Plugin", () => {
  let tempRoot;
  let knowledgeDir;
  let stateDir;
  const logPath = join(process.cwd(), "plugins", "logs", "protocol-gate.log");
  const KEYWORDS = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
  const usedSids = new Set();
  let hooks;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-test-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
  });

  afterAll(() => {
    delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    delete process.env.PROTOCOL_GATE_STATE_DIR;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function sid(name) {
    usedSids.add(name);
    return name;
  }

  function createKD(filename, content = "test content") {
    try { mkdirSync(knowledgeDir, { recursive: true }); } catch (_) {}
    writeFileSync(join(knowledgeDir, filename), content);
  }

  // Builds the milestone registry fixture body: the machine-readable
  // `## Milestone States` YAML block (the state SSOT) plus a human-readable
  // details table — the shape the Pathfinder produces at DECOMPOSE.
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

  function createRegistry(s, rows) {
    createKD(`milestones-feature-${s}.md`, registryContent(rows));
  }

  function removeKD(filename) {
    try { rmSync(join(knowledgeDir, filename)); } catch (_) {}
  }

  function statePath(s) {
    return join(stateDir, `.protocol-state-${s}.json`);
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
    // Reset the temp dirs so each test starts from empty state (P302 — the
    // destructive wipe of the REAL .state dir is gone; only our temp dirs reset).
    rmSync(knowledgeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    hooks = await pluginModule.server({}, {});
  });

  afterEach(() => {
    // Temp dirs are recreated in beforeEach, so no per-session fixture sweep is
    // needed; the .active-session pointer lives in the temp state dir.
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
    createKD(`milestones-a${suffix}`, registryContent([["M1", "checked-off"]]));
    await todo(s, "c8");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    // M5: SWARM→VERIFY advances on the registry all-checked-off gate — the
    // milestone-scoped impl KD is the disk evidence for the checked-off row.
    createKD(`impl-M1-a${suffix}`);
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

  it("todowrite disk checks drive INTENT advancement only once an intent KD appears on disk (BUG-008 guard)", async () => {
    const s = sid("adv-1");
    await initOverseer(s);
    await todo(s, "c1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    // Second todowrite fires a disk check; with no intent KD on disk the phase
    // regresses to PROTOCOL_NOT_LOADED — todowrite content alone never drives
    // advancement past INTENT.
    await todo(s, "c2");
    expect(hooks.sessionPhaseMap.get(s)).toBeLessThanOrEqual(hooks.STATES.INTENT);

    // Re-kickoff (a real session reaches INTENT again via the keyword gate),
    // then the disk check advances INTENT → PREFLIGHT once a KD is on disk.
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
    createKD(`intent-a-${s}.md`);
    await todo(s, "c3");
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

  it("AC-R004: REPORT write deletes only the ending generation's KDs (generation-aware) and retains other generations + other sessions", async () => {
    const s = sid("reset-r004");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 2);

    createKD(`intent-old-${s}.md`);
    createKD(`intent-stale-${s}-gen1.md`);
    createKD(`intent-fresh-${s}-gen2.md`);
    createKD(`report-final-${s}-gen2.md`);
    createKD("intent-other-other-session.md"); // different session — must survive

    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c1" },
      { args: { filePath: `knowledge/report-final-${s}-gen2.md`, content: "report" } }
    );

    // Ending generation is 2 (R101): only gen2 KDs are deleted. Legacy and
    // gen1 files belong to prior lifecycles — generation-scoped reads already
    // ignore them (R104/EC-007), and deleting them would wipe a reused
    // session's history.
    expect(existsSync(join(knowledgeDir, `intent-old-${s}.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `intent-stale-${s}-gen1.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `intent-fresh-${s}-gen2.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, `report-final-${s}-gen2.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, "intent-other-other-session.md"))).toBe(true);
    removeKD("intent-other-other-session.md");
  });

  it("AC101/AC102: cleanupLifecycleKDs removes only the ending generation's variants", () => {
    const cases = [
      { generation: 0, removed: 2, survivors: ["spec-c-{s}-gen1.md", "spec-d-{s}-gen2.md"] },
      { generation: 2, removed: 1, survivors: ["intent-a-{s}.md", "intent-b-{s}-gen0.md", "spec-c-{s}-gen1.md"] },
    ];
    for (const c of cases) {
      const s = sid(`ac101-${c.generation}`);
      createKD(`intent-a-${s}.md`);
      createKD(`intent-b-${s}-gen0.md`);
      createKD(`spec-c-${s}-gen1.md`);
      createKD(`spec-d-${s}-gen2.md`);

      const removed = hooks.cleanupLifecycleKDs(s, c.generation);

      expect(removed).toBe(c.removed);
      for (const f of ["intent-a-{s}.md", "intent-b-{s}-gen0.md", "spec-c-{s}-gen1.md", "spec-d-{s}-gen2.md"]) {
        const file = f.replace("{s}", s);
        expect(existsSync(join(knowledgeDir, file))).toBe(c.survivors.includes(f));
      }
    }
  });

  it("AC103: a stray REPORT write or edit with ending generation 1 deletes only gen1 KDs — gen2 KDs survive byte-identical", async () => {
    for (const tool of ["write", "edit"]) {
      const s = sid(`ac103-${tool}`);
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.sessionPhaseMap.set(`${s}:gen`, 1);

      // Reused session: gen1 belongs to the ENDING lifecycle, gen2 to the next.
      // A stray/duplicate REPORT write must not wipe the newer lifecycle (AC103).
      const gen2Content = "gen2 payload — must survive byte-identical";
      createKD(`intent-a-${s}-gen1.md`, "gen1 content");
      createKD(`spec-b-${s}-gen1.md`, "gen1 spec");
      createKD(`intent-a-${s}-gen2.md`, gen2Content);

      await hooks["tool.execute.before"](
        { tool, sessionID: s, callID: "c1" },
        { args: { filePath: `knowledge/report-final-${s}-gen1.md`, content: "report" } }
      );

      expect(existsSync(join(knowledgeDir, `intent-a-${s}-gen1.md`))).toBe(false);
      expect(existsSync(join(knowledgeDir, `spec-b-${s}-gen1.md`))).toBe(false);
      expect(readFileSync(join(knowledgeDir, `intent-a-${s}-gen2.md`), "utf8")).toBe(gen2Content);
      expect(hooks.getCurrentGeneration(s)).toBe(2);
    }
  });

  it("AC105/EC-008: a cleanup that throws does not block the REPORT phase reset to PROTOCOL_NOT_LOADED", async () => {
    // A malformed session ID makes cleanupLifecycleKDs throw while building
    // its filename pattern — the call site's try/catch must still reset the
    // phase (R103/EC-008). The session must be an overseer session for the
    // REPORT reset to fire, so initOverseer runs with the same malformed ID.
    await initOverseer("bad(");
    hooks.sessionPhaseMap.set("bad(", hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set("bad(:sid", "bad(");

    await hooks["tool.execute.before"](
      { tool: "write", sessionID: "bad(", callID: "c1" },
      { args: { filePath: `knowledge/report-ec008-bad.md`, content: "report" } }
    );

    expect(hooks.sessionPhaseMap.get("bad(")).toBeUndefined();
    expect(hooks.getCurrentGeneration("bad(")).toBe(1);
    try { rmSync(statePath("bad(")); } catch (_) {}
  });

  it("AC106/EC-005: cleanupLifecycleKDs on a missing knowledge dir returns 0 without throwing", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "protocol-gate-ec005-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(tmpRoot);
      expect(hooks.cleanupLifecycleKDs("ghost-session", 0)).toBe(0);
      expect(hooks.cleanupLifecycleKDs("ghost-session", 2)).toBe(0);
    } finally {
      process.chdir(prevCwd);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
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

  describe("M2: /phase command prompt simplification (AC007–AC009)", () => {
    it("AC007: commands/phase.md is confirmation-only with no state-writing instructions", async () => {
      const template = readFileSync(join(process.cwd(), "commands", "phase.md"), "utf8");
      // Confirmation-only prompt — the hook applies and persists the override.
      // Case-insensitive: the sentence is capitalized at the start of a paragraph.
      expect(template.toLowerCase()).toContain("phase was manually overridden to");
      // No instruction to hand-write state or override files (R007/NFR005).
      expect(template).not.toContain(".override-");
      expect(template).not.toContain("write the override file");
      expect(template).not.toContain(".state");
    });

    it("AC008: /phase override persists to disk and survives a restart", async () => {
      const s = sid("ac008");
      await initOverseer(s);
      const output = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "SWARM" }, output);

      // The hook is the single user-facing override: validates, sets, persists.
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(output.parts[0].text).toContain("Phase set to SWARM (7) for session");
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.SWARM);

      // Simulated restart with the same session ID → the override is restored.
      hooks = await pluginModule.server({}, {});
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    });

    it("AC009: /phase jumps any distance — 0→SWARM(7) and →REPORT(12) succeed with no +3 cap", async () => {
      const s = sid("ac009");
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);

      // PROTOCOL_NOT_LOADED (0) directly to SWARM (7) — a +7 jump.
      const out7 = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "SWARM" }, out7);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(out7.parts[0].text).toContain("Phase set to SWARM (7) for session");

      // And a direct jump to REPORT (12) from SWARM (7).
      const out12 = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "12" }, out12);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.REPORT);
      expect(out12.parts[0].text).toContain("Phase set to REPORT (12) for session");
    });

    it("P010: no .override- fallback remains in plugin source or command templates", async () => {
      const pluginSrc = readFileSync(join(process.cwd(), "plugins", "protocol-gate", "index.js"), "utf8");
      const template = readFileSync(join(process.cwd(), "commands", "phase.md"), "utf8");
      expect(pluginSrc).not.toContain(".override-");
      expect(pluginSrc).not.toContain("OVERRIDE_TTL_MS");
      expect(template).not.toContain(".override-");
    });
  });

  describe("M1: file-backed phase state SSOT (AC001–AC006, NFR004)", () => {
    it("AC001: the state file is re-read on every overseer message — manual mid-session edits are honored", async () => {
      // Fresh plugin instance with a phase-7 state file → first message reads 7.
      const s = sid("ac001");
      writeFileSync(statePath(s), JSON.stringify({ phase: 7, generation: 0, sid: s, timestamp: Date.now() }));
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(7);

      // Manual edit to phase 3 mid-session → next overseer message honors it.
      writeFileSync(statePath(s), JSON.stringify({ phase: 3, generation: 0, sid: s, timestamp: Date.now() }));
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(3);
    });

    it("AC002: every phase transition persists the phase to the state file (forward, backward, override, reset)", async () => {
      const s = sid("ac002");
      await initOverseer(s);
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);

      // Forward: 0 → 12 (PROTOCOL_NOT_LOADED → REPORT), assert the file after each.
      for (let phase = 1; phase <= 12; phase++) {
        hooks.sessionPhaseMap.set(s, phase);
        hooks.sessionPhaseMap.set(`${s}:sid`, s);
        expect(hooks.saveState(s)).toBe(true);
        expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(phase);
      }

      // Backward: 12 → SWARM (7)
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      expect(hooks.saveState(s)).toBe(true);
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.SWARM);

      // Override via the /phase hook: 7 → EXPLORE (3)
      const output = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "EXPLORE" }, output);
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.EXPLORE);

      // Reset: REPORT write → phase entry deleted, file carries phase 0.
      hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: s, callID: "r1" },
        { args: { filePath: `knowledge/report-ac002-${s}.md`, content: "report" } }
      );
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    });

    it("AC003: same-session restart restores the phase without clobbering the file", async () => {
      const s = sid("ac003");
      writeFileSync(statePath(s), JSON.stringify({ phase: 5, generation: 0, sid: s, timestamp: Date.now() }));
      // Simulated restart: fresh plugin instance with an empty in-memory map.
      hooks = await pluginModule.server({}, {});
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(5);
      // The file was NOT re-initialized to phase 0 and NOT clobbered (R003).
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(5);
    });

    it("AC004: fresh session continues the pointed-to lifecycle; with no pointer it initializes fresh", async () => {
      const s = sid("ac004-a");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      expect(hooks.saveState(s)).toBe(true);
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.SWARM);

      // Fresh session ID with a valid active-session pointer → restores the pointed-to phase.
      const fresh = sid("ac004-b");
      await initOverseer(fresh);
      expect(hooks.sessionPhaseMap.get(fresh)).toBe(hooks.STATES.SWARM);
      expect(hooks.readActiveSession().sessionID).toBe(fresh);

      // Fresh session ID with no pointer and no file → PROTOCOL_NOT_LOADED,
      // writes a state file, and updates the pointer (R004).
      try { rmSync(join(stateDir, ".active-session.json")); } catch (_) {}
      const bare = sid("ac004-c");
      await initOverseer(bare);
      expect(hooks.sessionPhaseMap.get(bare)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(JSON.parse(readFileSync(statePath(bare), "utf8")).phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.readActiveSession().sessionID).toBe(bare);
    });

    it("BUGFIX (off-by-one): R004 never adopts a stale INTENT or PROTOCOL_NOT_LOADED pointer — fresh session starts at 0 and the first todowrite advances 0→1; phase ≥ 2 adoption preserved", async () => {
      // A prior process stalled at INTENT: its state file was persisted at
      // phase 1 with no intent KD on disk (R009 advances INTENT→PREFLIGHT
      // once the KD is written, so an INTENT pointer is always stale).
      const stalled = sid("adopt-intent");
      await initOverseer(stalled);
      hooks.sessionPhaseMap.set(stalled, hooks.STATES.INTENT);
      hooks.sessionPhaseMap.set(`${stalled}:sid`, stalled);
      hooks.sessionPhaseMap.set(`${stalled}:gen`, 2);
      expect(hooks.saveState(stalled)).toBe(true);
      expect(hooks.readActiveSession().sessionID).toBe(stalled);

      // Fresh session must NOT inherit the stale INTENT phase — it starts at
      // PROTOCOL_NOT_LOADED (0) so the mandatory todowrite gate still runs.
      const fresh = sid("adopt-fresh");
      await initOverseer(fresh);
      expect(hooks.sessionPhaseMap.get(fresh)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(JSON.parse(readFileSync(statePath(fresh), "utf8")).phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);

      // The FIRST todowrite performs the intended 0→1 advance — exactly one
      // round-trip, no INTENT→PROTOCOL_NOT_LOADED consistency regression.
      await todo(fresh, "c1");
      expect(hooks.sessionPhaseMap.get(fresh)).toBe(hooks.STATES.INTENT);

      // A PROTOCOL_NOT_LOADED pointer (unstarted lifecycle) is also not
      // adopted — nothing to resume, so the new session starts fresh.
      hooks.sessionPhaseMap.set(stalled, hooks.STATES.PROTOCOL_NOT_LOADED);
      hooks.sessionPhaseMap.set(`${stalled}:gen`, 2);
      expect(hooks.saveState(stalled)).toBe(true);
      const fresh0 = sid("adopt-fresh0");
      await initOverseer(fresh0);
      expect(hooks.sessionPhaseMap.get(fresh0)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);

      // A pointer at a KD-producing phase (≥ PREFLIGHT) is still adopted —
      // the legitimate R004 restart-continuation behavior is preserved.
      hooks.sessionPhaseMap.set(stalled, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${stalled}:sid`, stalled);
      expect(hooks.saveState(stalled)).toBe(true);
      const fresh7 = sid("adopt-fresh7");
      await initOverseer(fresh7);
      expect(hooks.sessionPhaseMap.get(fresh7)).toBe(hooks.STATES.SWARM);
      expect(hooks.readActiveSession().sessionID).toBe(fresh7);
    });

    it("F5 (R004): an adopted session's gate scans the pointed-to session's KDs via :sid — ALIGN resume advances and consistency does not regress", async () => {
      // Session A reached ALIGN with its full KD chain on disk (intent → spec).
      const a = sid("f5-adopt-a");
      await initOverseer(a);
      hooks.sessionPhaseMap.set(a, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${a}:sid`, a);
      hooks.sessionPhaseMap.set(`${a}:gen`, 0);
      expect(hooks.saveState(a)).toBe(true);
      expect(hooks.readActiveSession().sessionID).toBe(a);
      createKD(`intent-f5-${a}.md`);
      createKD(`preflight-f5-${a}.md`);
      createKD(`exploration-f5-${a}.md`);
      createKD(`analysis-f5-${a}.md`);
      createKD(`spec-f5-${a}.md`);

      // Session B adopts A's lifecycle via the active-session pointer (R004).
      const b = sid("f5-adopt-b");
      await initOverseer(b);
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.ALIGN);
      expect(hooks.sessionPhaseMap.get(`${b}:sid`)).toBe(a);
      expect(hooks.readActiveSession().sessionID).toBe(b);

      // B has zero KDs of its own — the gate can only see ALIGN's spec KD
      // through the stored :sid. Pre-F5, this scan used B and found nothing.
      expect(readdirSync(knowledgeDir).filter(f => f.includes(`-${b}`))).toHaveLength(0);
      expect(hooks.checkDiskAdvancement(b, hooks.STATES.ALIGN, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);

      // Consistency check confirms ALIGN is consistent via A's spec KD — the
      // missing KDs under B's own id must NOT trigger a regression.
      const didRegress = hooks.checkPhaseStateConsistency(
        b, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        hooks.saveState, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );
      expect(didRegress).toBe(false);
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.ALIGN);

      // End-to-end: a real disk-check tool call advances the adopted session
      // ALIGN → DECOMPOSE because A's spec KD is found via :sid.
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: b, callID: "g1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.DECOMPOSE);
    });

    it("F5 (R004): an adopted SWARM session reads the pointed-to milestone registry and impl-KD evidence via :sid; new impl KDs under the adopting session count too", async () => {
      // Session A stalled at SWARM with a completed milestone: registry row M1
      // checked-off and its impl KD on disk, all named under A.
      const a = sid("f5-swarm-a");
      await initOverseer(a);
      hooks.sessionPhaseMap.set(a, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${a}:sid`, a);
      hooks.sessionPhaseMap.set(`${a}:gen`, 0);
      expect(hooks.saveState(a)).toBe(true);
      createKD(`plan-f5-${a}.md`);
      createRegistry(a, [["M1", "checked-off"]]);
      createKD(`impl-M1-f5-${a}.md`);

      // Session B adopts A's SWARM lifecycle.
      const b = sid("f5-swarm-b");
      await initOverseer(b);
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.SWARM);
      expect(hooks.sessionPhaseMap.get(`${b}:sid`)).toBe(a);

      // The M5 all-checked-off gate reads A's registry AND A's impl KD through
      // :sid — pre-F5 the registry lookup was scoped to B and found nothing.
      expect(hooks.readMilestoneState(b, hooks.sessionPhaseMap, "M1")).toBe("checked-off");
      expect(hooks.findMilestoneImplKD(b, hooks.sessionPhaseMap, "M1")).toBe(`impl-M1-f5-${a}.md`);
      expect(hooks.checkDiskAdvancement(b, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);

      // A post-adoption impl KD named under B is honored as check-off evidence
      // (the resumed session writes its own KDs going forward).
      createKD(`impl-M1-f5-${b}.md`);
      expect(hooks.checkMilestoneCheckedOff(b, hooks.sessionPhaseMap, "M1").checkedOff).toBe(true);
      removeKD(`impl-M1-f5-${a}.md`);
      expect(hooks.findMilestoneImplKD(b, hooks.sessionPhaseMap, "M1")).toBe(`impl-M1-f5-${b}.md`);
    });

    it("F5 (R004): control — a fresh session matches only its own KDs; post-adoption DECOMPOSE resume finds new KDs under the adopting session's id", async () => {
      // Prior-session KDs on disk (named under A) with no pointer: a fresh
      // session C must NOT see them — zero cross-session leakage.
      const a = sid("f5-ctrl-a");
      createKD(`intent-f5-${a}.md`);
      createKD(`spec-f5-${a}.md`);
      try { rmSync(join(stateDir, ".active-session.json")); } catch (_) {}
      const c = sid("f5-ctrl-c");
      await initOverseer(c);
      expect(hooks.sessionPhaseMap.get(c)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.sessionPhaseMap.get(`${c}:sid`)).toBe(c);
      await todo(c, "c1");
      expect(hooks.sessionPhaseMap.get(c)).toBe(hooks.STATES.INTENT);
      expect(hooks.checkDiskAdvancement(c, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);
      createKD(`intent-own-${c}.md`);
      expect(hooks.checkDiskAdvancement(c, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);

      // A stalled at DECOMPOSE with plan under A but no milestones; B adopts
      // and its Pathfinder writes plan + milestones under B. The dual-KD gate
      // must see B's new KDs (current session id) alongside A's prior plan.
      const a2 = sid("f5-decomp-a");
      await initOverseer(a2);
      hooks.sessionPhaseMap.set(a2, hooks.STATES.DECOMPOSE);
      hooks.sessionPhaseMap.set(`${a2}:sid`, a2);
      hooks.sessionPhaseMap.set(`${a2}:gen`, 0);
      expect(hooks.saveState(a2)).toBe(true);
      createKD(`plan-f5-${a2}.md`);

      const b = sid("f5-decomp-b");
      await initOverseer(b);
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.DECOMPOSE);
      expect(hooks.sessionPhaseMap.get(`${b}:sid`)).toBe(a2);

      createKD(`plan-f5-${b}.md`);
      createRegistry(b, [["M1", "checked-off"]]);
      expect(hooks.checkDiskAdvancement(b, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
      // The registry located for the resumed lifecycle is B's own new file.
      expect(hooks.readMilestoneRegistry(b, hooks.sessionPhaseMap).path).toBe(join(knowledgeDir, `milestones-feature-${b}.md`));
    });

    it("AC005: forced write failure — saveState returns false and logs to stderr; no silent divergence", async () => {
      const s = sid("ac005");
      await initOverseer(s);
      // Preserve the last good file content, then make the target path unwritable
      // (a directory collides with the rename) so the write is guaranteed to fail
      // regardless of process privileges.
      const original = readFileSync(statePath(s), "utf8");
      hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
      rmSync(statePath(s));
      mkdirSync(statePath(s));

      let stderr = "";
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...rest) => { stderr += chunk; return true; };
      try {
        expect(hooks.saveState(s)).toBe(false);
        expect(stderr).toContain("saveState error");
      } finally {
        process.stderr.write = origWrite;
        // Restore the original file so cleanup and subsequent tests see a file.
        rmSync(statePath(s), { recursive: true, force: true });
        writeFileSync(statePath(s), original);
      }

      // The disk still holds the pre-transition phase — the failed transition
      // never silently diverged the file from the in-memory intent.
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    });

    it("AC006: corrupt state file — backup + log + fresh init; next valid transition writes valid JSON", async () => {
      const s = sid("ac006");
      writeFileSync(statePath(s), "{not json");
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await initOverseer(s);
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
        // The original corrupt content is preserved via a backup rename (R006).
        const backups = readdirSync(stateDir).filter(f => f.includes(s) && f.includes("corrupt"));
        expect(backups.length).toBe(1);
        expect(readFileSync(join(stateDir, backups[0]), "utf8")).toBe("{not json");
        expect(readFileSync(logPath, "utf8")).toContain("corrupt state file backed up");

        // The next valid transition overwrites the original path with valid JSON.
        await todo(s, "c1");
        const saved = JSON.parse(readFileSync(statePath(s), "utf8"));
        expect(saved.phase).toBe(hooks.STATES.INTENT);
        expect(saved.sid).toBe(s);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("P006/NFR004: session IDs with separators or traversal are rejected for file paths", async () => {
      for (const evil of ["../evil", "a/b", "a\\b", "/absolute", "..", ".", ""]) {
        expect(hooks.sanitizeSessionID(evil)).toBeNull();
      }
      expect(hooks.sanitizeSessionID("ses_123")).toBe("ses_123");
      expect(hooks.getStatePath("../evil")).toBeNull();

      // saveState fails visibly for an unsafe ID and never writes outside .state.
      const outside = join(stateDir, "..", ".protocol-state-evil.json");
      expect(existsSync(outside)).toBe(false);
      let stderr = "";
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...rest) => { stderr += chunk; return true; };
      try {
        expect(hooks.saveState("../evil")).toBe(false);
        expect(stderr).toContain("unsafe session ID");
      } finally {
        process.stderr.write = origWrite;
      }
      expect(existsSync(outside)).toBe(false);
    });
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

  it("R003: DECOMPOSE advances only when BOTH current-generation plan- and milestones- KDs exist (dual-KD gate)", async () => {
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

    // Generation scoping: a current-gen plan with a stale prior-gen registry is
    // still blocked (only the plan matches) until a current-gen registry lands.
    removeKD(`plan-both-${s}.md`);
    removeKD(`milestones-only-${s}.md`);
    hooks.sessionPhaseMap.set(`${s}:gen`, 2);
    createKD(`plan-cur-${s}-gen2.md`);
    createKD(`milestones-stale-${s}-gen1.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);
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

    it("milestone ID parsing helpers cover impl-KD filenames and prompt field variants", async () => {
      // extractMilestoneIdFromImplKD parses the milestone-scoped impl KD naming contract
      expect(hooks.extractMilestoneIdFromImplKD("impl-M4-milestone-tracking-ses_x-gen0.md")).toBe("M4");
      expect(hooks.extractMilestoneIdFromImplKD("impl-m3-foo-ses_x-gen0.md")).toBe("m3");
      // legacy unscoped impl KD — no milestone contract token
      expect(hooks.extractMilestoneIdFromImplKD("impl-fix-auth-flow-ses_123-gen2.md")).toBe("fix");
      expect(hooks.extractMilestoneIdFromImplKD("milestones-feature-ses_x.md")).toBeNull();
      expect(hooks.extractMilestoneIdFromImplKD(null)).toBeNull();

      // extractMilestoneIdFromPrompt parses field variants and returns null when absent
      expect(hooks.extractMilestoneIdFromPrompt("AGENT: artisan\nMILESTONE ID: M3\nMODE: swarm")).toBe("M3");
      expect(hooks.extractMilestoneIdFromPrompt("MILESTONE_ID: M3\nMODE: swarm")).toBe("M3");
      expect(hooks.extractMilestoneIdFromPrompt("**MILESTONE ID:** **M3**")).toBe("M3");
      expect(hooks.extractMilestoneIdFromPrompt("AGENT: artisan\nMODE: swarm")).toBeNull();
      expect(hooks.extractMilestoneIdFromPrompt(null)).toBeNull();
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

    it("R013: checks off from the impl KD filename even when the parent session is not in-memory SWARM", async () => {
      // The check-off guard is the registry's in-progress row + the impl KD on
      // disk (R012) — NOT the parent session's in-memory phase. After a restart
      // the map may not reflect SWARM, yet the milestone must still check off.
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
      expect(content).toContain("  M4: checked-off");
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

  describe("M3: persistent milestone tracking (R010–R016, AC010–AC016)", () => {
    it("AC010: system.transform injects phase-appropriate guidance — SWARM milestone registry and INTENT generation-scoped naming", async () => {
      // SWARM: the live milestone list is surfaced to the Overseer
      const s = sid("m3-vis-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"], ["M2", "checked-off"]]);

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, output);
      const system = output.system.join("\n");
      expect(system).toContain("Milestone registry (live state SSOT)");
      expect(system).toContain("M1=in-progress");
      expect(system).toContain("M2=checked-off");
      expect(system).toContain('MILESTONE ID: <id>');

      // Non-SWARM phases do not receive the milestone list
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      const output2 = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, output2);
      expect(output2.system.join("\n")).not.toContain("Milestone registry");

      // INTENT: phase guidance carries the generation-scoped KD naming
      const s2 = sid("sys-1");
      await initOverseer(s2);
      hooks.sessionPhaseMap.set(s2, hooks.STATES.INTENT);
      hooks.sessionPhaseMap.set(`${s2}:sid`, s2);
      hooks.sessionPhaseMap.set(`${s2}:gen`, 2);
      const output3 = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: s2 }, output3);
      expect(output3.system[1]).toContain(`knowledge/intent-{name}-${s2}-gen2.md`);
      expect(output3.system).toHaveLength(2); // appended, existing entries untouched
    });

    it("AC013: checks off a milestone after restart — parent session and generation derived from the impl KD filename + on-disk state", async () => {
      // Simulate a restart: the fresh plugin instance has an EMPTY
      // overseerSessions set. Only the persisted .state file and the registry
      // on disk remain — autoCheckOffMilestone must derive the parent session
      // and generation from the impl KD filename + on-disk state.
      for (const gen of [0, 3]) {
        const s = sid(`m3-restart-${gen}`);
        // Registry and impl KD carry the generation suffix for gen > 0; the
        // state file (the SSOT) records the lifecycle generation.
        const suffix = gen === 0 ? "" : `-gen${gen}`;
        createKD(`milestones-feature-${s}${suffix}.md`, registryContent([["M1", "in-progress"]]));
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(statePath(s), JSON.stringify({ phase: 7, generation: gen, sid: s }));
        expect(hooks.overseerSessions.size).toBe(0);

        const artisan = sid(`m3-restart-art-${gen}`);
        await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
        await hooks["tool.execute.before"](
          { tool: "write", sessionID: artisan, callID: "c1" },
          { args: { filePath: `knowledge/impl-M1-restart-${s}${suffix}.md`, content: "# IMPLEMENTATION SUMMARY" } }
        );

        const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}${suffix}.md`), "utf8");
        expect(content).toContain("  M1: checked-off");
      }
    });

    it("AC014: reconstructs every row state from disk after restart — no in-memory data required", async () => {
      const s = sid("m3-recon-1");
      // m1 in-progress, m2 checked-off with its impl KD on disk (the exact
      // AC014 crash/restart fixture). The in-memory map is EMPTY.
      createRegistry(s, [["M1", "in-progress"], ["M2", "checked-off"]]);
      createKD(`impl-M2-recon-${s}.md`);

      const gate = hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap);
      expect(gate.total).toBe(2);
      expect(gate.checkedOff).toBe(1);
      expect(gate.ok).toBe(false);
      expect(gate.rows).toEqual([
        { id: "M1", state: "in-progress", checkedOff: false },
        { id: "M2", state: "checked-off", checkedOff: true }
      ]);

      // Once M1's impl KD lands AND the check-off transition is recorded
      // (R012 — the KD alone never implies completion), the gate reconstructs
      // all-checked-off from disk alone.
      createKD(`impl-M1-recon-${s}.md`);
      hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M1", ["checked-off"]);
      const gate2 = hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap);
      expect(gate2.ok).toBe(true);
      expect(gate2.checkedOff).toBe(2);
    });

    it("AC014: atomic registry write leaves no tmp residue and the YAML stays valid", async () => {
      const s = sid("m3-atomic-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "pending"], ["M2", "pending"]]);

      const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M1", ["assigned", "in-progress"]);
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);

      // Atomic write: no tmp files left behind — a crash mid-write can never
      // expose a torn registry file at the target path.
      const files = readdirSync(knowledgeDir).filter(f => f.includes(".tmp-"));
      expect(files).toEqual([]);
      // Registry still parses into valid rows after the write.
      const registry = hooks.readMilestoneRegistry(s, hooks.sessionPhaseMap);
      expect(registry.rows).toEqual([
        { id: "M1", state: "in-progress" },
        { id: "M2", state: "pending" }
      ]);
      // Human-readable table preserved.
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("| M1 | desc | pending |");
    });

    it("AC016: checked-off rows re-open on re-dispatch but stay immutable otherwise (evidence preserved)", async () => {
      const s = sid("m3-reopen-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`impl-M1-reopen-${s}.md`);

      // All rows checked-off with impl KDs → the gate would allow SWARM→VERIFY.
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);

      // Inspector findings → Overseer moves back to SWARM and re-dispatches M1.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "c1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
      );
      let content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: in-progress");

      // The gate fails closed again until the fix impl KD is written.
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // Fix delivered → auto check-off re-advances the row → gate opens again.
      const artisan = sid("m3-reopen-art");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "c1" },
        { args: { filePath: `knowledge/impl-M1-fix-${s}-gen0.md`, content: "# IMPLEMENTATION SUMMARY (fix)" } }
      );
      content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);

      // A non-reopen write (e.g. markStuckMilestonesFailed) never regresses a
      // checked-off row — the completion evidence stays immutable.
      const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M1", ["failed"]);
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false);
      content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
    });
  });

  it("tool.definition respects the phase allowlist — read restricted during SWARM, non-allowlisted tools blocked elsewhere, task always passes", async () => {
    // SWARM: read is allowlisted and carries the plan/registry restriction
    const s = sid("swarm-def-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    const readOut = { description: "Test read", parameters: {} };
    await hooks["tool.definition"]({ toolID: "read" }, readOut);
    expect(readOut.description).not.toContain("⛔");
    expect(readOut.description).toContain("SWARM phase restriction: ONLY plan and milestone registry KDs");

    // A tool still outside the SWARM allowlist keeps the blocking notice
    const editOut = { description: "Test edit", parameters: {} };
    await hooks["tool.definition"]({ toolID: "edit" }, editOut);
    expect(editOut.description).toContain("⛔");

    // INTENT: edit/glob/grep get the ⛔ prefix, task always passes
    const s2 = sid("def-1");
    await initOverseer(s2);
    hooks.sessionPhaseMap.set(s2, hooks.STATES.INTENT);
    for (const tool of ["edit", "glob", "grep"]) {
      const output = { description: `Test ${tool}`, parameters: {} };
      await hooks["tool.definition"]({ toolID: tool }, output);
      expect(output.description).toContain("⛔");
    }
    const taskOut = { description: "Test task", parameters: {} };
    await hooks["tool.definition"]({ toolID: "task" }, taskOut);
    expect(taskOut.description).not.toContain("⛔");
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

  describe("M5: registry-based SWARM→VERIFY gate (R011–R014, AC016–AC024)", () => {
    it("AC017: advances SWARM→VERIFY only when ALL registry milestones are checked-off with impl KDs on disk", async () => {
      const s = sid("m5-all-off");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"]]);

      // No impl KDs on disk → blocked (registry alone is not evidence)
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // Only one of two milestones has its impl KD → still blocked
      createKD(`impl-M1-feature-${s}.md`);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // Both impl KDs on disk → all milestones genuinely checked-off → advance
      createKD(`impl-M2-feature-${s}.md`);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
    });

    it("AC016: does not advance while any registry milestone is not checked-off, even with N impl KDs on disk", async () => {
      const s = sid("m5-pending");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "in-progress"]]);

      // M2's impl KD exists but its registry row is still in-progress → blocked
      createKD(`impl-M1-feature-${s}.md`);
      createKD(`impl-M2-feature-${s}.md`);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // M3 pending with impl KD on disk → still blocked
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"], ["M3", "pending"]]);
      createKD(`impl-M3-feature-${s}.md`);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);
    });

    it("AC018: missing, empty, and unparsable registries fail closed with a log, never advance", async () => {
      const s = sid("m5-missing");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        // Missing registry → REGISTRY_MISSING
        expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

        // Empty registry (no milestone rows) → REGISTRY_EMPTY
        const empty = sid("m5-empty");
        await initOverseer(empty);
        hooks.sessionPhaseMap.set(empty, hooks.STATES.SWARM);
        hooks.sessionPhaseMap.set(`${empty}:sid`, empty);
        createKD(`milestones-empty-${empty}.md`, registryContent([]));
        expect(hooks.checkDiskAdvancement(empty, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

        // Unparsable registry (no Milestone States YAML block) → REGISTRY_MISSING
        const unparsable = sid("m5-unparsable");
        await initOverseer(unparsable);
        hooks.sessionPhaseMap.set(unparsable, hooks.STATES.SWARM);
        hooks.sessionPhaseMap.set(`${unparsable}:sid`, unparsable);
        createKD(`milestones-garbage-${unparsable}.md`, "# no milestone states block");
        expect(hooks.checkDiskAdvancement(unparsable, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("REGISTRY_MISSING");
        expect(log).toContain("REGISTRY_EMPTY");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("AC019: force-advance paths during SWARM mark the stuck milestone failed, stay in SWARM, and log SAFETY_STUCK", async () => {
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        // Path 1: 15 failed disk checks fire the force-advance safety.
        const s = sid("m5-safety-15");
        await initOverseer(s);
        hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
        hooks.sessionPhaseMap.set(`${s}:sid`, s);
        // M1 genuinely checked-off (registry row + impl KD); M2 in-progress blocks the gate
        createRegistry(s, [["M1", "checked-off"], ["M2", "in-progress"]]);
        createKD(`impl-M1-feature-${s}.md`);

        for (let i = 0; i < 14; i++) {
          await hooks["tool.execute.before"]({ tool: "glob", sessionID: s, callID: `g${i}` }, { args: { pattern: "knowledge/*.md" } });
          expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
        }
        await hooks["tool.execute.before"]({ tool: "glob", sessionID: s, callID: "g15" }, { args: { pattern: "knowledge/*.md" } });

        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
        let content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
        expect(content).toContain("  M1: checked-off");
        expect(content).toContain("  M2: failed");
        expect(readFileSync(logPath, "utf8")).toContain("SAFETY_STUCK");

        // Path 2: a pendingVerification session seeded one call short of the
        // threshold fires the same safety on its next tool call.
        const s2 = sid("m5-safety-pv");
        await initOverseer(s2);
        hooks.sessionPhaseMap.set(s2, hooks.STATES.SWARM);
        hooks.sessionPhaseMap.set(`${s2}:sid`, s2);
        createRegistry(s2, [["M1", "in-progress"]]);
        hooks.pendingVerification.set(s2, { expectedPrefixes: ["impl"], toolType: "write", timestamp: Date.now(), toolCalls: 0 });
        hooks.pendingVerificationToolCount.set(s2, 14);

        await hooks["tool.execute.before"]({ tool: "glob", sessionID: s2, callID: "pv1" }, { args: { pattern: "knowledge/*.md" } });

        expect(hooks.sessionPhaseMap.get(s2)).toBe(hooks.STATES.SWARM);
        content = readFileSync(join(knowledgeDir, `milestones-feature-${s2}.md`), "utf8");
        expect(content).toContain("  M1: failed");
        expect(readFileSync(logPath, "utf8")).toContain("SAFETY_STUCK");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("F1 AC001: a fresh milestone never trips the cap even when another milestone in the same session has consumed 5+ redispatches (M4 false-positive regression guard)", async () => {
      const s = sid("f1-ac001");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"], ["M2", "in-progress"]]);
      // M1 has genuinely burned its 5-redispatch budget; M2 has zero prior attempts.
      hooks.phaseRedispatchCount.set(`${s}:M1`, 5);

      // M2's first dispatch must be allowed — a missing key reads 0 and can
      // never satisfy `>= 5` (R003). Pre-F1 this tripped SAFETY_STUCK because
      // the cap read the lifecycle-global phase key.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "f1-ac001-1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M2\nMODE: swarm" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      // M2's own counter starts fresh and increments; M1's budget is untouched.
      expect(hooks.phaseRedispatchCount.get(`${s}:M2`)).toBe(1);
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(5);
    });

    it("F1 AC003: after exactly 5 attempts on the SAME milestone, the 6th dispatch throws SAFETY_STUCK", async () => {
      const s = sid("f1-ac003");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      for (let i = 1; i <= 5; i++) {
        await hooks["tool.execute.before"](
          { tool: "task", sessionID: s, callID: `f1-ac003-${i}` },
          { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
        );
      }
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(5);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await expect(
          hooks["tool.execute.before"](
            { tool: "task", sessionID: s, callID: "f1-ac003-6" },
            { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
          )
        ).rejects.toThrow("SAFETY_STUCK");
        // Stays in SWARM — the cap marks the milestone failed, no auto-advance.
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
        const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
        expect(content).toContain("  M1: failed");
        expect(readFileSync(logPath, "utf8")).toContain("SAFETY_STUCK");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("F1 AC006/AC004: when the cap fires for A, only A's row fails and a fresh milestone B dispatches normally", async () => {
      const s = sid("f1-ac006");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"], ["M2", "in-progress"]]);
      hooks.phaseRedispatchCount.set(`${s}:M1`, 5);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await expect(
          hooks["tool.execute.before"](
            { tool: "task", sessionID: s, callID: "f1-ac006-1" },
            { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
          )
        ).rejects.toThrow("SAFETY_STUCK");

        // AC006: only the offending milestone's row is marked failed; other
        // in-progress rows stay in-progress.
        const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
        expect(content).toContain("  M1: failed");
        expect(content).toContain("  M2: in-progress");
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }

      // AC004: milestone B is unaffected by A's exhausted budget — no throw.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "f1-ac006-2" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M2\nMODE: swarm" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M2`)).toBe(1);
    });

    it("F1 AC002: M3 and m3 increment the same normalized key; 5 mixed-case attempts trip the cap", async () => {
      const s = sid("f1-ac002");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M3", "in-progress"]]);

      // 2 upper-case + 3 lower-case dispatches — one shared, case-normalized key
      const attempts = [
        ["M3", "f1-ac002-1"],
        ["M3", "f1-ac002-2"],
        ["m3", "f1-ac002-3"],
        ["m3", "f1-ac002-4"],
        ["m3", "f1-ac002-5"]
      ];
      for (const [id, callID] of attempts) {
        await hooks["tool.execute.before"](
          { tool: "task", sessionID: s, callID },
          { args: { subagent_type: "artisan", prompt: `AGENT: artisan\nMILESTONE ID: ${id}\nMODE: swarm` } }
        );
      }
      // NFR005: the key is case-normalized to uppercase — m3 maps onto M3.
      expect(hooks.phaseRedispatchCount.get(`${s}:M3`)).toBe(5);
      expect(hooks.phaseRedispatchCount.get(`${s}:m3`)).toBeUndefined();

      // The 6th dispatch, in mixed case, still trips the shared cap.
      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: s, callID: "f1-ac002-6" },
          { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: m3\nMODE: swarm" } }
        )
      ).rejects.toThrow("SAFETY_STUCK");
    });

    it("F1 AC005: a successful check-off resets the per-milestone budget; re-dispatch starts fresh", async () => {
      const s = sid("f1-ac005");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);
      hooks.phaseRedispatchCount.set(`${s}:M1`, 5);

      // Artisan writes its milestone-scoped impl KD → auto check-off resets the budget.
      const artisan = sid("f1-ac005-art");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "f1-ac005-w" },
        { args: { filePath: `knowledge/impl-M1-feature-${s}.md`, content: "# IMPLEMENTATION SUMMARY" } }
      );
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
      // R004: the per-milestone counter is deleted on successful check-off.
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();

      // Re-dispatch (R016 re-open) starts a fresh budget — zero prior attempts.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "f1-ac005-r" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(1);
    });

    it("F1 AC007/AC008: SWARM FORCE ADVANCE stays global and clears all per-milestone keys", async () => {
      const s = sid("f1-ac008");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "in-progress"]]);
      createKD(`impl-M1-feature-${s}.md`);
      hooks.phaseRedispatchCount.set(`${s}:M1`, 3);
      hooks.phaseRedispatchCount.set(`${s}:M2`, 2);
      hooks.phaseRedispatchCount.set(`${s}:${hooks.STATES.SWARM}`, 4);

      for (let i = 0; i < 15; i++) {
        await hooks["tool.execute.before"]({ tool: "glob", sessionID: s, callID: `g${i}` }, { args: { pattern: "knowledge/*.md" } });
      }

      // AC007: FORCE ADVANCE fails ALL non-checked-off, non-failed rows; M1's
      // checked-off evidence stays immutable (global lifecycle deadlock escape).
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
      expect(content).toContain("  M2: failed");
      // R006: per-milestone keys are cleared alongside the phase key.
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:M2`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.SWARM}`)).toBeUndefined();
    });

    it("F1 AC008: regression to SWARM clears all per-milestone keys", async () => {
      const s = sid("f1-ac008-regress");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.phaseRedispatchCount.set(`${s}:M1`, 3);
      hooks.phaseRedispatchCount.set(`${s}:M2`, 2);
      hooks.phaseRedispatchCount.set(`${s}:${hooks.STATES.SWARM}`, 1);

      // Artisan re-dispatch with BACKWARD: true from VERIFY → SWARM.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "f1-ac008-r" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nBACKWARD: true\nMILESTONE ID: M1\nMODE: swarm" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:M2`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.SWARM}`)).toBeUndefined();
    });

    it("F1 AC009: non-SWARM phases keep the phase-keyed counter behavior", async () => {
      const s = sid("f1-ac009");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.CLEANUP);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "f1-ac009-1" },
        { args: { subagent_type: "committer", prompt: "AGENT: committer\nMODE: cleanup" } }
      );
      // R002: the phase key is incremented; no per-milestone key is created.
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.CLEANUP}`)).toBe(1);
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.SWARM}`)).toBeUndefined();
    });

    it("AC021: /phase override from SWARM logs SAFETY_ESCAPE — the only automatic escape hatch removed", async () => {
      const s = sid("m5-escape");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "pending"]]);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        const output = { parts: [] };
        await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "VERIFY" }, output);
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("SAFETY_ESCAPE");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("AC024: MILESTONE_COUNT is no longer extracted or stored; counts have no gating effect", async () => {
      const s = sid("m5-nomc");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "pending"]]);

      // Dispatch with a legacy MILESTONE_COUNT field — must not be stored or gate
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "c1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMILESTONE_COUNT: 3\nMODE: swarm" } }
      );
      expect(hooks.sessionPhaseMap.get(`${s}:milestones`)).toBeUndefined();
      expect(hooks.swarmDispatchCount.get(s)).toBe(1);

      // Even with dispatchCount 1 and an impl KD on disk, the pending row blocks
      createKD(`impl-M1-feature-${s}.md`);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // Registry fully checked-off advances regardless of count signals
      createRegistry(s, [["M1", "checked-off"]]);
      hooks.swarmDispatchCount.set(s, 5);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
    });
  });

  describe("M4: registry write ordering fix (R017, AC017, issue-7)", () => {
    it("AC017: a multi-milestone dispatch (repeated lines or comma list) is rejected before any registry write — registry byte-identical", async () => {
      const variants = [
        "AGENT: artisan\nMILESTONE ID: M1\nMILESTONE ID: M2\nMODE: swarm",
        "AGENT: artisan\nMILESTONE ID: M1, M2\nMODE: swarm",
      ];
      for (let i = 0; i < variants.length; i++) {
        const s = sid(`m4-card-${i}`);
        await initOverseer(s);
        hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
        hooks.sessionPhaseMap.set(`${s}:sid`, s);
        createRegistry(s, [["M1", "pending"], ["M2", "pending"]]);
        const before = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");

        await expect(
          hooks["tool.execute.before"](
            { tool: "task", sessionID: s, callID: "c1" },
            { args: { subagent_type: "artisan", prompt: variants[i] } }
          )
        ).rejects.toThrow(/MULTI_MILESTONE|Multiple milestones/);

        // No phantom row, no partial write — the registry is byte-identical.
        const after = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
        expect(after).toBe(before);
        expect(after).toContain("  M1: pending");
        expect(after).toContain("  M2: pending");
      }
    });

    it("AC017: a single-milestone dispatch still advances its row exactly once (no phantom advancement)", async () => {
      const s = sid("m4-card-3");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "pending"], ["M2", "pending"]]);

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "c1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
      );
      let content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: in-progress");
      expect(content).toContain("  M2: pending");

      // Idempotent second dispatch of the same milestone — still exactly one row advanced
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "c2" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
      );
      content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: in-progress");
      expect(content).toContain("  M2: pending");
    });

    it("collectMilestoneIds collects every MILESTONE ID field variant, mirroring delegation-gate semantics", async () => {
      expect(hooks.collectMilestoneIds("MILESTONE ID: M3\nMILESTONE ID: M4")).toEqual(["M3", "M4"]);
      expect(hooks.collectMilestoneIds("MILESTONE_ID: M3\nMODE: swarm")).toEqual(["M3"]);
      expect(hooks.collectMilestoneIds("MILESTONE.ID: M3\nMODE: swarm")).toEqual(["M3"]);
      expect(hooks.collectMilestoneIds("**MILESTONE ID:** **M3**")).toEqual(["M3"]);
      expect(hooks.collectMilestoneIds("AGENT: artisan\nMODE: swarm")).toEqual([]);
      expect(hooks.collectMilestoneIds(null)).toEqual([]);
      // A comma inside one field is a single collected entry — the call site
      // rejects it as MULTI_MILESTONE (mirrors delegation-gate's /,/.test).
      expect(hooks.collectMilestoneIds("MILESTONE ID: M1, M2")).toEqual(["M1, M2"]);
    });
  });

  describe("M4: anchored fence parsing (R310–R311, AC310)", () => {
    it("AC310a: a registry with the Milestone States heading glued to the opening ```yaml fence is located and updated", async () => {
      const s = sid("ac310-glued");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      // A glued `## Milestone States` + ```yaml line — the regression fixture
      // that made the old unanchored indexOf search silently return no-registry.
      createKD(`milestones-feature-${s}.md`, `## Milestone States\`\`\`yaml
milestones:
  M1: pending
\`\`\`

## Milestone Details

| Milestone ID | Description | State |
| ------------ | ----------- | ----- |
| M1 | desc | pending |
`);

      const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M1", ["assigned", "in-progress"]);
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: in-progress");
      // The human-readable details table stays untouched.
      expect(content).toContain("| M1 | desc | pending |");
    });

    it("AC310c: the existing well-formed registry fixture (whitespace-only gap before the opening fence) still parses and updates", async () => {
      const s = sid("ac310-wellformed");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "pending"], ["M2", "pending"]]);

      const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M1", ["assigned", "in-progress"]);
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: in-progress");
      expect(content).toContain("  M2: pending");
      expect(content).toContain("| M1 | desc | pending |");
    });

    it("AC310b: a foreign fence or embedded content between the heading and the YAML block fails closed with a byte-identical registry", async () => {
      const variants = [
        // A foreign json fence between the heading and the YAML block — the
        // old unanchored parser silently skipped it and parsed the later block.
        `## Milestone States

\`\`\`json
{"note": "embedded"}
\`\`\`

\`\`\`yaml
milestones:
  M1: pending
\`\`\`

## Milestone Details
`,
        // Plain embedded content between the heading and the YAML block.
        `## Milestone States

This registry section is malformed.

\`\`\`yaml
milestones:
  M1: pending
\`\`\`

## Milestone Details
`,
      ];
      for (let i = 0; i < variants.length; i++) {
        const s = sid(`ac310-malformed-${i}`);
        await initOverseer(s);
        hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
        hooks.sessionPhaseMap.set(`${s}:sid`, s);
        createKD(`milestones-feature-${s}.md`, variants[i]);
        const before = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");

        const result = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M1", ["assigned", "in-progress"]);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("no-registry");
        // Fails closed — no row mutation, registry file byte-identical.
        expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toBe(before);
      }
    });
  });

  it("R306 (relocated from delegation-gate M1): GENERATION falls back to the protocol-gate state file when the prompt omits GENERATION", async () => {
    // The delegation-gate GENERATION fallback reads PROTOCOL_GATE_STATE_DIR at
    // call time — this suite's temp stateDir (P302) is that dir, so the real
    // plugins/protocol-gate/.state is never touched and the two suites cannot
    // race on it (AC306).
    const delegationHooks = await delegationPlugin.server({}, {});
    const s = sid("dg-fbk");
    writeFileSync(statePath(s), JSON.stringify({ phase: 3, generation: 4, sid: s, timestamp: Date.now() }));

    const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SESSION ID: ${s}
MILESTONE ID: M1
SCOPE: Implement feature X
RESULT KD: knowledge/impl-M1-foo-${s}.md`;

    const output = { args: { prompt } };
    await delegationHooks["tool.execute.before"]({ tool: "task", sessionID: s, callID: "c1" }, output);

    expect(output.args.prompt).toContain("GENERATION: 4");
    expect(output.args.prompt).toContain("knowledge/impl-<milestone-id>-<descriptive-name>-<session_id>-gen4.md");
    expect(output.args.description).toContain("knowledge/impl-<milestone-id>-<name>-<session_id>-gen4.md");
  });
});
