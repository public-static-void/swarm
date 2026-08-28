import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";
import delegationPlugin from "../../../plugins/delegation-gate/index.js";

// Consolidated protocol-gate suite: 78 → 70 tests. Parallel
// one-off accepts (VERIFY dual-KD, cleanup write+edit, generation-0/n,
// milestone report-survivor, force-advance paths, tool.definition phases,
// system.transform phases, dual-KD+generation, milestone-ID parsers,
// milestone reopen+immutability, todowrite advancement pair) are merged into
// parameterized tests; the duplicated "saves state after advancement" test was
// removed as covered by the state-persistence cases. The GENERATION-fallback
// test relocated here from the delegation-gate suite — it reads the
// delegation-gate fallback through this suite's temp PROTOCOL_GATE_STATE_DIR.
// Anchored-fence tests added: glued heading+fence,
// well-formed whitespace-gap fixture, fail-closed for foreign content between
// heading and YAML block. One session-scoped describe with a single
// setUp/tearDown: knowledge and state dirs are real temp dirs, recreated
// before each test, so no test touches the real knowledge/ or
// plugins/protocol-gate/.state. Session IDs are unique per test
// (sid()) and the dirs are wiped between tests, so fixtures never collide.
describe("Protocol-Gate Plugin", () => {
  let tempRoot;
  let knowledgeDir;
  let stateDir;
  let delegationLogDir;
  let priorDelegationLogDir;
  let priorDelegationDebug;
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
    // Log isolation: the relocated cross-plugin test invokes the
    // delegation-gate server() + hooks, whose debug writes would append to the
    // real plugins/logs/delegation-gate.log whenever DELEGATION_GATE_DEBUG is
    // set (.env sets it). Point DELEGATION_GATE_LOG_DIR at a per-run temp dir
    // BEFORE the first delegationPlugin.server() call so the delegation-gate
    // module cache binds to the temp path — the same seam the delegation-gate
    // suite uses. The debug flag is asserted here so the redirect is
    // proven deterministically, not only when the flag happens to be absent.
    priorDelegationLogDir = process.env.DELEGATION_GATE_LOG_DIR;
    priorDelegationDebug = process.env.DELEGATION_GATE_DEBUG;
    delegationLogDir = mkdtempSync(join(tmpdir(), "pg-dg-log-"));
    process.env.DELEGATION_GATE_LOG_DIR = delegationLogDir;
    process.env.DELEGATION_GATE_DEBUG = "1";
  });

  afterAll(() => {
    delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    delete process.env.PROTOCOL_GATE_STATE_DIR;
    if (priorDelegationLogDir === undefined) delete process.env.DELEGATION_GATE_LOG_DIR;
    else process.env.DELEGATION_GATE_LOG_DIR = priorDelegationLogDir;
    if (priorDelegationDebug === undefined) delete process.env.DELEGATION_GATE_DEBUG;
    else process.env.DELEGATION_GATE_DEBUG = priorDelegationDebug;
    rmSync(delegationLogDir, { recursive: true, force: true });
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

  // Builds a REVIEW KD with the machine-readable verdict frontmatter field the
  // VERIFY gate reads (P012). The optional findings body carries milestone
  // citations (`impl-<milestone-id>-` tokens / M\d+ ids) — the provenance the
  // scoped-reopen + malformed-FAIL rules parse (P014/P015). The findings
  // section uses the TEMPLATE-CONFORMANT `## Review Findings` header
  // (skills/template-review/SKILL.md, inspector.md) — regression guard: if the
  // citation parser drifts back to only accepting the legacy `## Findings`
  // header, the FAIL fixtures below yield zero citations and the scoped-reopen
  // tests fail. Content beyond the frontmatter and Review Findings section is
  // irrelevant to the gate.
  function reviewKD(verdict, findings = "") {
    return `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: ${verdict}
---

# REVIEW: test

## Verdict

${verdict}

## Review Findings

${findings}
`;
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
    // Reset the temp dirs so each test starts from empty state — the
    // destructive wipe of the REAL .state dir is gone; only our temp dirs reset.
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
    // SWARM→VERIFY advances on the registry all-checked-off gate — the
    // milestone-scoped impl KD is the disk evidence for the checked-off row.
    createKD(`impl-M1-a${suffix}`);
    await todo(s, "c9");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
    // VERIFY→EXTRACT advances on a single fresh PASS review KD (the merged
    // review+audit surface; legacy audit- KDs are inert), so create it before c10.
    createKD(`review-a${suffix}`, reviewKD("PASS"));
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
    for (const hook of ["chat.params", "chat.message", "permission.ask", "tool.execute.before", "command.execute.before", "tool.definition", "experimental.chat.system.transform"]) {
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

  it("todowrite disk checks drive INTENT advancement only once an intent KD appears on disk", async () => {
    const s = sid("adv-1");
    await initOverseer(s);
    await todo(s, "c1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    // Second todowrite fires a disk check; with no intent KD on disk the phase
    // stays in INTENT — the old special case regressed INTENT to
    // PROTOCOL_NOT_LOADED here — todowrite content alone never drives
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

  it("fresh-instance restart at INTENT stays INTENT on todowrite re-issue, allows the intent KD write, then advances to PREFLIGHT", async () => {
    const s = sid("n3-restart");
    // Simulated restart: state file restored at INTENT with no
    // intent KD on disk — the live symptom where the first INTENT KD write
    // was blocked ("Wrong phase. Available tools in PROTOCOL_NOT_LOADED:
    // todowrite") after the consistency check regressed INTENT away.
    writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.INTENT, generation: 0, sid: s, timestamp: Date.now() }));
    hooks = await pluginModule.server({}, {});
    await initOverseer(s);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    // A todowrite re-issue (non-creating disk-check call) with no intent
    // KD on disk keeps INTENT — no regression to PROTOCOL_NOT_LOADED.
    await todo(s, "c1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    // The intent KD write succeeds — not blocked by the
    // PROTOCOL_NOT_LOADED allowlist (which only permits todowrite). The hook
    // validates before the runtime creates the file; createKD materializes it
    // (mirrors the runLifecycle createKD + todo pattern).
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c2" },
      { args: { filePath: `knowledge/intent-a-${s}.md`, content: "intent" } }
    );
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    createKD(`intent-a-${s}.md`);

    // The next disk check sees the intent KD on disk and advances
    // INTENT → PREFLIGHT.
    await todo(s, "c3");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
  });

  it("restart catch-up — restored at PREFLIGHT with preflight + exploration KDs advances exactly one phase per disk-check call", async () => {
    const s = sid("ac019-restart");
    // Pre-restart artifacts: state at PREFLIGHT plus the KDs the gate will
    // catch up over — written BEFORE the simulated restart so they read as
    // pre-existing disk evidence.
    writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.PREFLIGHT, generation: 0, sid: s, timestamp: Date.now() }));
    createKD(`preflight-a-${s}.md`);
    createKD(`exploration-a-${s}.md`);
    // Simulated restart: fresh plugin instance restores the state file.
    hooks = await pluginModule.server({}, {});
    await initOverseer(s);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);

    // Call 1: disk-evidence catch-up — exactly one hop (PREFLIGHT → EXPLORE),
    // never a multi-phase skip (one-phase-per-call policy).
    await todo(s, "c1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);

    // Call 2: exactly one more hop (EXPLORE → INVESTIGATE).
    await todo(s, "c2");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INVESTIGATE);
  });

  it("restart catch-up — restored at INTENT with only the intent KD advances to PREFLIGHT then stops (no PREFLIGHT KD, skip flag consumed)", async () => {
    const s = sid("ac020-intent");
    writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.INTENT, generation: 0, sid: s, timestamp: Date.now() }));
    createKD(`intent-a-${s}.md`);
    hooks = await pluginModule.server({}, {});
    await initOverseer(s);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    // Call 1: the pre-existing intent KD drives INTENT → PREFLIGHT (one hop).
    await todo(s, "c1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);

    // Call 2: no PREFLIGHT KD on disk — the phase does NOT advance; the
    // entering-PREFLIGHT skip flag is consumed by this call either way.
    await todo(s, "c2");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
  });

  it("a gen-0 KD present at a gen-1 restart does not advance the phase", async () => {
    const s = sid("ac021-gen0");
    // Restart at INTENT in generation 1; only a gen-0 (legacy-named) intent KD
    // exists — stale prior-lifecycle evidence must not drive advancement.
    writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.INTENT, generation: 1, sid: s, timestamp: Date.now() }));
    createKD(`intent-stale-${s}.md`); // gen-0 naming — no -gen1 suffix
    hooks = await pluginModule.server({}, {});
    await initOverseer(s);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    // A disk-check call sees no gen-1 KD → no advancement.
    await todo(s, "c1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

    // A current-generation gen-1 KD advances as usual — the gate is scoped,
    // not stuck.
    createKD(`intent-fresh-${s}-gen1.md`);
    await todo(s, "c2");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
  });

  it("RESTART_CATCH_UP logged for catch-up advancement after a simulated restart (PROTOCOL_GATE_DEBUG=1)", async () => {
    try { rmSync(logPath); } catch (_) {}
    process.env.PROTOCOL_GATE_DEBUG = "1";
    try {
      const s = sid("ac016-catchup");
      writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.PREFLIGHT, generation: 0, sid: s, timestamp: Date.now() }));
      createKD(`preflight-a-${s}.md`);
      createKD(`exploration-a-${s}.md`);
      // Deterministic "pre-existing" fixture: backdate both KDs so their mtime
      // provably predates the restore timestamp recorded at reconcile.
      // Without this, KD creation and reconcile can land in the same
      // millisecond — statSync().mtimeMs (float) can then be >= the truncated
      // integer Date.now() captured as restoredAt, and the evidenceMtime <
      // restoredAt comparison skips the RESTART_CATCH_UP diagnostic (flake).
      const aged = new Date(Date.now() - 10000);
      utimesSync(join(knowledgeDir, `preflight-a-${s}.md`), aged, aged);
      utimesSync(join(knowledgeDir, `exploration-a-${s}.md`), aged, aged);
      hooks = await pluginModule.server({}, {});
      await initOverseer(s);

      await todo(s, "c1"); // catch-up hop PREFLIGHT → EXPLORE on pre-existing KD
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("RESTART_CATCH_UP: PREFLIGHT → EXPLORE on pre-existing KD (restore ");
      expect(log).toContain(", KD mtime ");
    } finally {
      delete process.env.PROTOCOL_GATE_DEBUG;
      try { rmSync(logPath); } catch (_) {}
    }
  });

  it("no RESTART_CATCH_UP line for mid-session advancement (evidence KD written after phase entry, no restart)", async () => {
    try { rmSync(logPath); } catch (_) {}
    process.env.PROTOCOL_GATE_DEBUG = "1";
    try {
      const s = sid("ac017-mid");
      // Fresh init — no state file at startup, so no restore timestamp is
      // recorded: the diagnostic is skipped for every mid-session hop.
      await initOverseer(s);
      await todo(s, "c1"); // PROTOCOL_NOT_LOADED → INTENT (todowrite kickoff)
      createKD(`intent-a-${s}.md`);
      await todo(s, "c2"); // INTENT → PREFLIGHT (mid-session advancement)

      const log = readFileSync(logPath, "utf8");
      expect(log).not.toContain("RESTART_CATCH_UP");
      expect(log).toContain("Disk advancement: INTENT → PREFLIGHT");
    } finally {
      delete process.env.PROTOCOL_GATE_DEBUG;
      try { rmSync(logPath); } catch (_) {}
    }
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

  it("restricts INTENT-phase writes to knowledge/intent-*.md and reads to skill files and intent KDs", async () => {
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
    ).rejects.toThrow("Read from skill files or knowledge/intent-*.md only");
  });

  it("INTENT-phase read allows skill files and intent KDs, rejects delegation-gate template JSON", async () => {
    const s = sid("ac003");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);

    // Auto-loaded KD-format template skill resolves
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c1" },
        { args: { filePath: "skills/template-intent/SKILL.md" } }
      )
    ).resolves.toBeUndefined();

    // Current session intent KD resolves
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c2" },
        { args: { filePath: `knowledge/intent-feature-${s}.md` } }
      )
    ).resolves.toBeUndefined();

    // Delegation template JSON is auto-injected by delegation-gate, never read
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c3" },
        { args: { filePath: "plugins/delegation-gate/templates/investigate.json" } }
      )
    ).rejects.toThrow("Read from skill files or knowledge/intent-*.md only");
  });

  it("REPORT-phase read allows skill files and knowledge KDs, rejects delegation-gate template JSON", async () => {
    const s = sid("ac004");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);

    // Auto-loaded KD-format template skill resolves (skill-file check added)
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c1" },
        { args: { filePath: "skills/template-report/SKILL.md" } }
      )
    ).resolves.toBeUndefined();

    // Knowledge KD resolves (needed to compose the report)
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c2" },
        { args: { filePath: "knowledge/report-compose.md" } }
      )
    ).resolves.toBeUndefined();

    // Delegation template JSON is auto-injected by delegation-gate, never read
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c3" },
        { args: { filePath: "plugins/delegation-gate/templates/investigate.json" } }
      )
    ).rejects.toThrow("Read from skill files or knowledge KDs only");
  });

  it("normalizes backslash and absolute Windows paths to project-relative knowledge/ paths", async () => {
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

  it("records in-flight dispatches for matching agents and regresses for mismatched agents", async () => {
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

  it("generation increments monotonically across lifecycle ends", async () => {
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

  it("stale prior-generation and gen-less KDs cannot advance a gen-2 lifecycle", async () => {
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

  it("legacy state files without generation fall back to generation 0 with session-ID matching", async () => {
    const s = sid("gen-r003");
    writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.INTENT, timestamp: Date.now() }));
    await initOverseer(s);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
    expect(hooks.getCurrentGeneration(s)).toBe(0);

    createKD(`intent-legacy-${s}.md`);
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
  });

  it("REPORT write deletes only the ending generation's KDs (generation-aware) and retains other generations + other sessions", async () => {
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

    // Ending generation is 2: only gen2 KDs are deleted. Legacy and
    // gen1 files belong to prior lifecycles — generation-scoped reads already
    // ignore them, and deleting them would wipe a reused
    // session's history.
    expect(existsSync(join(knowledgeDir, `intent-old-${s}.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `intent-stale-${s}-gen1.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `intent-fresh-${s}-gen2.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, `report-final-${s}-gen2.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, "intent-other-other-session.md"))).toBe(true);
    removeKD("intent-other-other-session.md");
  });

  it("report-survivor — the triggering report written AFTER the lifecycle-end hook survives while sibling ending-generation KDs are deleted", async () => {
    const s = sid("survivor-r011");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 2);

    // Sibling ending-generation KDs (a PROCESS KD carrying preserved memory
    // payloads is the motivating case) plus a PRE-EXISTING report file —
    // the same sequence as the generation-aware deletion test.
    createKD(`intent-fresh-${s}-gen2.md`);
    createKD(`process-payload-${s}-gen2.md`);
    createKD(`report-final-${s}-gen2.md`);
    createKD(`intent-stale-${s}-gen1.md`); // prior generation — must survive
    createKD("intent-other-other-session.md"); // other session — must survive

    // The hook runs BEFORE the runtime write (tool.execute.before): cleanup
    // deletes every ending-generation KD, including the pre-existing report.
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c1" },
      { args: { filePath: `knowledge/report-final-${s}-gen2.md`, content: "report" } }
    );
    expect(hooks.sessionPhaseMap.has(s)).toBe(false);
    expect(hooks.getCurrentGeneration(s)).toBe(3);
    expect(existsSync(join(knowledgeDir, `report-final-${s}-gen2.md`))).toBe(false);

    // Simulate the post-hook runtime write — the report file lands AFTER
    // cleanup, so it survives. This is the incidental hook-ordering behavior
    // the test locks in; the related issue documents why it is not a durability
    // guarantee for non-report KDs.
    createKD(`report-final-${s}-gen2.md`, "report");
    expect(existsSync(join(knowledgeDir, `report-final-${s}-gen2.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `intent-fresh-${s}-gen2.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, `process-payload-${s}-gen2.md`))).toBe(false);
    expect(existsSync(join(knowledgeDir, `intent-stale-${s}-gen1.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, "intent-other-other-session.md"))).toBe(true);
    removeKD("intent-other-other-session.md");
  });

  it("cleanupLifecycleKDs removes only the ending generation's variants", () => {
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

  it("cleanupLifecycleKDs also removes the session's short-term store; long-term memory untouched", () => {
    const s = sid("cleanup-short-term");
    const shortTermDir = join(knowledgeDir, "short-term", s, "artisan");
    mkdirSync(shortTermDir, { recursive: true });
    writeFileSync(join(shortTermDir, "note-001.json"), "{}");
    createKD(`intent-cleanup-${s}.md`);
    createKD(`intent-cleanup-${s}-gen2.md`);

    const removed = hooks.cleanupLifecycleKDs(s, 2);
    expect(removed).toBe(1); // only the ending-generation KD
    expect(existsSync(join(knowledgeDir, `intent-cleanup-${s}.md`))).toBe(true);
    expect(existsSync(join(knowledgeDir, `intent-cleanup-${s}-gen2.md`))).toBe(false);
    // The session short-term store is gone (R020/R006); long-term memory/
    // (never created here) is untouched by the cleanup.
    expect(existsSync(join(knowledgeDir, "short-term", s))).toBe(false);
    expect(existsSync(join(knowledgeDir, "memory"))).toBe(false);
  });

  it("cleanupLifecycleKDs clears the session's generic and project-scoped scratch stores too", () => {
    const s = sid("cleanup-multi-store-short-term");
    const genericDir = join(knowledgeDir, "generic", "short-term", s, "scribe");
    const projectDir = join(knowledgeDir, "projects", "myapp", "short-term", s, "artisan");
    mkdirSync(genericDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(genericDir, "note-001.json"), "{}");
    writeFileSync(join(projectDir, "note-001.json"), "{}");
    // A different project's session namespace must survive
    const otherProjectDir = join(knowledgeDir, "projects", "myapp", "short-term", "ses-other", "artisan");
    mkdirSync(otherProjectDir, { recursive: true });
    writeFileSync(join(otherProjectDir, "note-001.json"), "{}");

    hooks.cleanupLifecycleKDs(s, 0);

    expect(existsSync(join(knowledgeDir, "generic", "short-term", s))).toBe(false);
    expect(existsSync(join(knowledgeDir, "projects", "myapp", "short-term", s))).toBe(false);
    expect(existsSync(otherProjectDir)).toBe(true);
  });

  it("a stray REPORT write or edit with ending generation 1 deletes only gen1 KDs — gen2 KDs survive byte-identical", async () => {
    for (const tool of ["write", "edit"]) {
      const s = sid(`ac103-${tool}`);
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.sessionPhaseMap.set(`${s}:gen`, 1);

      // Reused session: gen1 belongs to the ENDING lifecycle, gen2 to the next.
      // A stray/duplicate REPORT write must not wipe the newer lifecycle.
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

  it("a cleanup that throws does not block the REPORT phase reset to PROTOCOL_NOT_LOADED", async () => {
    // A malformed session ID makes cleanupLifecycleKDs throw while building
    // its filename pattern — the call site's try/catch must still reset the
    // phase. The session must be an overseer session for the
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

  it("cleanupLifecycleKDs on a missing knowledge dir returns 0 without throwing", () => {
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

  it("after REPORT the phase entry is deleted so a manual state edit is honored on the next message", async () => {
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

  it("/phase sets and persists a named or numeric phase; invalid values are rejected", async () => {
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

  describe("/phase command prompt simplification", () => {
    it("commands/phase.md is confirmation-only with no state-writing instructions", async () => {
      const template = readFileSync(join(process.cwd(), "commands", "phase.md"), "utf8");
      // Confirmation-only prompt — the hook applies and persists the override.
      // Case-insensitive: the sentence is capitalized at the start of a paragraph.
      expect(template.toLowerCase()).toContain("phase was manually overridden to");
      // No instruction to hand-write state or override files.
      expect(template).not.toContain(".override-");
      expect(template).not.toContain("write the override file");
      expect(template).not.toContain(".state");
    });

    it("/phase override persists to disk and survives a restart", async () => {
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

    it("/phase jumps any distance — 0→SWARM(7) and →REPORT(12) succeed with no +3 cap", async () => {
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

    it("no .override- fallback remains in plugin source or command templates", async () => {
      const pluginSrc = readFileSync(join(process.cwd(), "plugins", "protocol-gate", "index.js"), "utf8");
      const template = readFileSync(join(process.cwd(), "commands", "phase.md"), "utf8");
      expect(pluginSrc).not.toContain(".override-");
      expect(pluginSrc).not.toContain("OVERRIDE_TTL_MS");
      expect(template).not.toContain(".override-");
    });
  });

  describe("file-backed phase state SSOT", () => {
    it("the state file is re-read on every overseer message — manual mid-session edits are honored", async () => {
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

    it("every phase transition persists the phase to the state file (forward, backward, override, reset)", async () => {
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

    it("same-session restart restores the phase without clobbering the file", async () => {
      const s = sid("ac003");
      writeFileSync(statePath(s), JSON.stringify({ phase: 5, generation: 0, sid: s, timestamp: Date.now() }));
      // Simulated restart: fresh plugin instance with an empty in-memory map.
      hooks = await pluginModule.server({}, {});
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(5);
      // The file was NOT re-initialized to phase 0 and NOT clobbered.
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(5);
    });

    it("a fresh session never adopts the pointed-to lifecycle — a pointer at SWARM still initializes PROTOCOL_NOT_LOADED", async () => {
      const s = sid("ac004-a");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.sessionPhaseMap.set(`${s}:gen`, 0);
      expect(hooks.saveState(s)).toBe(true);
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.SWARM);
      // The active-session pointer now references session A at SWARM.
      expect(hooks.readActiveSession().sessionID).toBe(s);

      // Fresh session ID with a valid active-session pointer at a KD-producing
      // phase (≥ PREFLIGHT): the pointer is inert. The new session
      // initializes PROTOCOL_NOT_LOADED with its own sid, never SWARM.
      const fresh = sid("ac004-b");
      await initOverseer(fresh);
      expect(hooks.sessionPhaseMap.get(fresh)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.sessionPhaseMap.get(`${fresh}:sid`)).toBe(fresh);
      expect(JSON.parse(readFileSync(statePath(fresh), "utf8")).phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      // The pointer moves to the fresh session (an active-lifecycle marker).
      expect(hooks.readActiveSession().sessionID).toBe(fresh);

      // Fresh session ID with no pointer and no file → PROTOCOL_NOT_LOADED,
      // writes a state file, and updates the pointer on fresh init.
      try { rmSync(join(stateDir, ".active-session.json")); } catch (_) {}
      const bare = sid("ac004-c");
      await initOverseer(bare);
      expect(hooks.sessionPhaseMap.get(bare)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(JSON.parse(readFileSync(statePath(bare), "utf8")).phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.readActiveSession().sessionID).toBe(bare);
    });

    it("a fresh session never adopts ANY pointed-to phase — INTENT, PROTOCOL_NOT_LOADED, or a KD-producing phase (≥ PREFLIGHT); the todowrite kickoff always runs", async () => {
      // A prior process stalled at INTENT: its state file was persisted at
      // phase 1 with no intent KD on disk (INTENT→PREFLIGHT only advances
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

      // A pointer at a KD-producing phase (≥ PREFLIGHT) is ALSO not adopted —
      // the restart-continuation behavior was removed entirely.
      hooks.sessionPhaseMap.set(stalled, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${stalled}:sid`, stalled);
      expect(hooks.saveState(stalled)).toBe(true);
      const fresh7 = sid("adopt-fresh7");
      await initOverseer(fresh7);
      expect(hooks.sessionPhaseMap.get(fresh7)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.sessionPhaseMap.get(`${fresh7}:sid`)).toBe(fresh7);
      expect(hooks.readActiveSession().sessionID).toBe(fresh7);
    });

    it("a fresh session never advances or regresses off another session's KDs — the pointer is inert and the lookup set is single-session", async () => {
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

      // Session B is fresh — the pointer is inert: B starts at
      // PROTOCOL_NOT_LOADED with its own sid, and its lookup set is [B] only.
      const b = sid("f5-adopt-b");
      await initOverseer(b);
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.sessionPhaseMap.get(`${b}:sid`)).toBe(b);
      expect(hooks.getKDLookupSIDs(hooks.sessionPhaseMap, b)).toEqual([b]);
      expect(hooks.readActiveSession().sessionID).toBe(b);

      // B has zero KDs of its own — A's KDs (named under A) must not advance
      // B's phase. checkDiskAdvancement reads only B's lookup set.
      await todo(b, "c1");
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.INTENT);
      expect(hooks.checkDiskAdvancement(b, hooks.STATES.INTENT, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // B at ALIGN (user /phase) with no KDs of its own: the consistency check
      // walks backward and finds no earlier-phase KD under B — no regression.
      hooks.sessionPhaseMap.set(b, hooks.STATES.ALIGN);
      const didRegress = hooks.checkPhaseStateConsistency(
        b, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        hooks.saveState, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );
      expect(didRegress).toBe(false);
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.ALIGN);

      // A real disk-check tool call does NOT advance B — A's spec KD is never
      // found via B's single-session lookup.
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: b, callID: "g1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.ALIGN);
    });

    it("a fresh session at SWARM reads only its OWN registry and impl-KD evidence — a prior lifecycle's files never count", async () => {
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

      // Session B is fresh — no adoption. B starts at PROTOCOL_NOT_LOADED
      // with its own sid; A's registry/impl KDs never enter B's lookup set.
      const b = sid("f5-swarm-b");
      await initOverseer(b);
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.sessionPhaseMap.get(`${b}:sid`)).toBe(b);

      // Place B at SWARM (user /phase): the all-checked-off gate sees no
      // registry under B → fails closed, no advancement off A's files.
      hooks.sessionPhaseMap.set(b, hooks.STATES.SWARM);
      expect(hooks.readMilestoneState(b, hooks.sessionPhaseMap, "M1")).toBeNull();
      expect(hooks.findMilestoneImplKD(b, hooks.sessionPhaseMap, "M1")).toBeNull();
      expect(hooks.checkDiskAdvancement(b, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // B's own registry + impl KD (named under B) satisfy the gate normally.
      createRegistry(b, [["M1", "checked-off"]]);
      createKD(`impl-M1-f5-${b}.md`);
      expect(hooks.readMilestoneState(b, hooks.sessionPhaseMap, "M1")).toBe("checked-off");
      expect(hooks.findMilestoneImplKD(b, hooks.sessionPhaseMap, "M1")).toBe(`impl-M1-f5-${b}.md`);
      expect(hooks.checkMilestoneCheckedOff(b, hooks.sessionPhaseMap, "M1").checkedOff).toBe(true);
      expect(hooks.checkDiskAdvancement(b, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
    });

    it("control — a fresh session matches only its own KDs; a session at DECOMPOSE needs its OWN plan + milestones", async () => {
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

      // A stalled at DECOMPOSE with plan under A but no milestones. Session B
      // is fresh — it never adopts A's DECOMPOSE phase. When B is placed at
      // DECOMPOSE (user /phase), the dual-KD gate requires B's OWN plan +
      // milestones: A's plan under A never counts.
      const a2 = sid("f5-decomp-a");
      await initOverseer(a2);
      hooks.sessionPhaseMap.set(a2, hooks.STATES.DECOMPOSE);
      hooks.sessionPhaseMap.set(`${a2}:sid`, a2);
      hooks.sessionPhaseMap.set(`${a2}:gen`, 0);
      expect(hooks.saveState(a2)).toBe(true);
      createKD(`plan-f5-${a2}.md`);

      const b = sid("f5-decomp-b");
      await initOverseer(b);
      expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.sessionPhaseMap.get(`${b}:sid`)).toBe(b);

      hooks.sessionPhaseMap.set(b, hooks.STATES.DECOMPOSE);
      // A's plan alone (named under A) does not satisfy B's dual-KD gate.
      expect(hooks.checkDiskAdvancement(b, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      createKD(`plan-f5-${b}.md`);
      createRegistry(b, [["M1", "checked-off"]]);
      expect(hooks.checkDiskAdvancement(b, hooks.STATES.DECOMPOSE, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
      // The registry located for B's lifecycle is B's own file.
      expect(hooks.readMilestoneRegistry(b, hooks.sessionPhaseMap).path).toBe(join(knowledgeDir, `milestones-feature-${b}.md`));
    });

    it("forced write failure — saveState returns false and logs to log file; no silent divergence", async () => {
      const s = sid("ac005");
      await initOverseer(s);
      // Preserve the last good file content, then make the target path unwritable
      // (a directory collides with the rename) so the write is guaranteed to fail
      // regardless of process privileges.
      const original = readFileSync(statePath(s), "utf8");
      hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
      rmSync(statePath(s));
      mkdirSync(statePath(s));

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        expect(hooks.saveState(s)).toBe(false);
        expect(readFileSync(logPath, "utf8")).toContain("saveState error");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
        // Restore the original file so cleanup and subsequent tests see a file.
        rmSync(statePath(s), { recursive: true, force: true });
        writeFileSync(statePath(s), original);
      }

      // The disk still holds the pre-transition phase — the failed transition
      // never silently diverged the file from the in-memory intent.
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    });

    it("corrupt state file — backup + log + fresh init; next valid transition writes valid JSON", async () => {
      const s = sid("ac006");
      writeFileSync(statePath(s), "{not json");
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await initOverseer(s);
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
        // The original corrupt content is preserved via a backup rename.
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

    it("session IDs with separators or traversal are rejected for file paths", async () => {
      for (const evil of ["../evil", "a/b", "a\\b", "/absolute", "..", ".", ""]) {
        expect(hooks.sanitizeSessionID(evil)).toBeNull();
      }
      expect(hooks.sanitizeSessionID("ses_123")).toBe("ses_123");
      expect(hooks.getStatePath("../evil")).toBeNull();

      // saveState fails visibly for an unsafe ID and never writes outside .state.
      const outside = join(stateDir, "..", ".protocol-state-evil.json");
      expect(existsSync(outside)).toBe(false);
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        expect(hooks.saveState("../evil")).toBe(false);
        expect(readFileSync(logPath, "utf8")).toContain("unsafe session ID");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      expect(existsSync(outside)).toBe(false);
    });

    it("a stale :sid in the state file is healed to the current session and persisted without the stale sid", async () => {
      // Legacy adoption-chain artifact: a state file whose sid points at a
      // different (finished) session. The current session must never read or
      // advance off that prior lifecycle's KDs.
      const s = sid("r002-heal");
      writeFileSync(statePath(s), JSON.stringify({ phase: 5, generation: 0, sid: "old-session", timestamp: Date.now() }));
      await initOverseer(s);

      // Phase restores from the valid own file, but the sid is healed to s.
      expect(hooks.sessionPhaseMap.get(s)).toBe(5);
      expect(hooks.sessionPhaseMap.get(`${s}:sid`)).toBe(s);
      // The heal is persisted — the stale sid is gone from the file.
      const persisted = JSON.parse(readFileSync(statePath(s), "utf8"));
      expect(persisted.sid).toBe(s);
      expect(persisted.phase).toBe(5);
      // The lookup set is single-session: the old sid can never leak in.
      expect(hooks.getKDLookupSIDs(hooks.sessionPhaseMap, s)).toEqual([s]);
    });

    it("the active-session pointer is deleted at lifecycle end and saveState never re-creates it for a finished session", async () => {
      const s = sid("r003-pointer");
      await initOverseer(s);
      // Session is active mid-lifecycle — the pointer exists as an audit marker.
      expect(hooks.readActiveSession().sessionID).toBe(s);

      // Drive to REPORT and write the report KD → lifecycle end.
      hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.sessionPhaseMap.set(`${s}:gen`, 0);
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: s, callID: "r1" },
        { args: { filePath: `knowledge/report-r003-${s}.md`, content: "report" } }
      );

      // Phase entry gone; state file carries phase 0 + the incremented
      // generation; the pointer is DELETED and was not re-created by saveState.
      expect(hooks.sessionPhaseMap.has(s)).toBe(false);
      expect(existsSync(join(stateDir, ".active-session.json"))).toBe(false);
      expect(hooks.readActiveSession()).toBeNull();
      const afterReset = JSON.parse(readFileSync(statePath(s), "utf8"));
      expect(afterReset.phase).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(afterReset.generation).toBe(1);
      expect(afterReset.sid).toBeUndefined();

      // A fresh session with no own file still gets its own pointer (active
      // lifecycle audit marker) — fresh init, not adoption.
      const fresh = sid("r003-fresh");
      await initOverseer(fresh);
      expect(hooks.readActiveSession().sessionID).toBe(fresh);
      expect(hooks.sessionPhaseMap.get(fresh)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);

      // The finished session's restart restores PROTOCOL_NOT_LOADED from its
      // phase-0 file WITHOUT re-creating a pointer (the heal path only
      // persists on a stale sid; phase 0 + no sid writes nothing).
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.sessionPhaseMap.get(`${s}:sid`)).toBe(s);
      expect(hooks.readActiveSession().sessionID).toBe(fresh);
    });

    it("a phase-0 state file (post-REPORT marker) restores PROTOCOL_NOT_LOADED with the persisted generation", async () => {
      const s = sid("p005-phase0");
      // Completed-lifecycle marker: phase 0, generation 3, no sid.
      writeFileSync(statePath(s), JSON.stringify({ phase: 0, generation: 3, timestamp: Date.now() }));
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
      expect(hooks.sessionPhaseMap.get(`${s}:sid`)).toBe(s);
      expect(hooks.getCurrentGeneration(s)).toBe(3);
      // The file is not clobbered — the generation counter survives restarts.
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).generation).toBe(3);
    });
  });

  it("a second lifecycle stays at INTENT — stale prior-lifecycle KDs never advance it prematurely", async () => {
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

  it("three lifecycle restarts — generation matches the cycle number and no stale KDs remain", async () => {
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

  it("recovery from a stuck PREFLIGHT via /phase INTENT — lifecycle completes to REPORT", async () => {
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

  // Review-only VERIFY surface (R010/R013): a single fresh PASS review KD
  // advances VERIFY→EXTRACT — the audit is a section of the review KD, not a
  // separate KD. Legacy audit- KDs are inert (never verdict KDs, never gate
  // evidence). A single KD must hold VERIFY without consistency-regressing to
  // SWARM (the regression-side ORs in checkPhaseStateConsistency are
  // preserved), or the unbounded VERIFY⇄SWARM loop returns.
  it("VERIFY advances to EXTRACT on a single fresh review KD; legacy audit- KDs are inert", async () => {
    const s = sid("verify-review-only");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    let callID = 0;
    const hookGlob = () => hooks["tool.execute.before"](
      { tool: "glob", sessionID: s, callID: `c${++callID}` },
      { args: { pattern: "knowledge/*.md" } }
    );
    const gate = () => hooks.checkDiskAdvancement(s, hooks.STATES.VERIFY, hooks.sessionPhaseMap, hooks.swarmDispatchCount);

    // audit- alone: inert — not a verdict KD, so no advancement and no
    // consistency regression to SWARM across repeated hook invocations.
    createKD(`audit-only-${s}.md`);
    expect(gate()).toBe(false);
    await hookGlob();
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
    await hookGlob();
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);

    // A single fresh review KD advances (merged review+audit surface).
    createKD(`review-pass-${s}.md`, reviewKD("PASS"));
    expect(gate()).toBe(true);
    try { rmSync(logPath); } catch (_) {}
    process.env.PROTOCOL_GATE_DEBUG = "1";
    try {
      await hookGlob();
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXTRACT);
      expect(readFileSync(logPath, "utf8")).toContain("Disk check VERIFY: review=true → true");
    } finally {
      delete process.env.PROTOCOL_GATE_DEBUG;
      try { rmSync(logPath); } catch (_) {}
    }

    // Generation scoping: a prior-gen review is inert (only current-gen
    // matches); a current-gen review advances regardless of any audit KD.
    const s2 = sid("verify-review-gen");
    await initOverseer(s2);
    hooks.sessionPhaseMap.set(s2, hooks.STATES.VERIFY);
    hooks.sessionPhaseMap.set(`${s2}:sid`, s2);
    hooks.sessionPhaseMap.set(`${s2}:gen`, 2);
    createKD(`review-stale-${s2}-gen1.md`, reviewKD("PASS"));
    expect(hooks.checkDiskAdvancement(s2, hooks.STATES.VERIFY, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);
    createKD(`review-cur-${s2}-gen2.md`, reviewKD("PASS"));
    expect(hooks.checkDiskAdvancement(s2, hooks.STATES.VERIFY, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
  });

  it("DECOMPOSE advances only when BOTH current-generation plan- and milestones- KDs exist (dual-KD gate)", async () => {
    const s = sid("decomp-dual");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.DECOMPOSE);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    // plan- alone: no advancement (registry missing at DECOMPOSE)
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

  it("SWARM phase reads are restricted to milestone registry KDs (dispatcher visibility)", async () => {
    const s = sid("swarm-read-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    // milestones- KDs are readable — the Overseer can see milestone state to
    // drive per-milestone artisan dispatches.
    await expect(
      hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c2" },
        { args: { filePath: `knowledge/milestones-feature-${s}.md` } }
      )
    ).resolves.toBeUndefined();

    // Plan KDs (relative and absolute), other KDs, and non-KD files stay
    // blocked during SWARM
    for (const bad of [
      `knowledge/plan-feature-${s}.md`,
      `/home/user/project/knowledge/plan-feature-${s}.md`,
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
      ).rejects.toThrow("Read from knowledge/milestones-*.md");
    }
  });

  describe("per-milestone dispatch — registry state wiring", () => {
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

    it("findMilestoneImplKD locates the milestone-scoped impl KD on disk (filename-generation evidence, session match mandatory)", async () => {
      const s = sid("m4-find-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createKD(`impl-M4-feature-${s}.md`);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M4")).toBe(`impl-M4-feature-${s}.md`);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M5")).toBeNull();

      // Deliberate contract update (Issue 64): the FILENAME's embedded
      // generation is the evidence, so the legacy suffix keeps counting under
      // a later persisted generation. Staleness within the session is handled
      // by supersede-on-reopen and REPORT cleanup, not by generation-scoping
      // here.
      hooks.sessionPhaseMap.set(`${s}:gen`, 2);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M4")).toBe(`impl-M4-feature-${s}.md`);

      // The session-id match stays mandatory: another session's impl KD for
      // the same milestone id is never evidence.
      const other = sid("m4-find-other");
      createKD(`impl-M4-cross-${other}-gen2.md`);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M4")).toBe(`impl-M4-feature-${s}.md`);

      // A filename whose embedded generation differs from the persisted one
      // satisfies the lookup on its own — the observed gen0/gen1 divergence
      // must not block the gate after reconciliation.
      removeKD(`impl-M4-feature-${s}.md`);
      createKD(`impl-M4-next-${s}-gen1.md`);
      expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M4")).toBe(`impl-M4-next-${s}-gen1.md`);
    });

    it("checkMilestoneCheckedOff cross-checks the registry row against its impl KD on disk", async () => {
      const s = sid("m4-xchk-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);

      // checked-off row WITHOUT its impl KD → treated as not checked off (all-checked-off gate semantics)
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

    it("checks off from the impl KD filename even when the parent session is not in-memory SWARM", async () => {
      // The check-off guard is the registry's in-progress row + the impl KD on
      // disk — NOT the parent session's in-memory phase. After a restart
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

  describe("persistent milestone tracking", () => {
    it("system.transform injects phase-appropriate guidance — SWARM milestone registry and INTENT generation-scoped naming", async () => {
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

    it("checks off a milestone after restart — parent session and generation derived from the impl KD filename + on-disk state", async () => {
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

    it("reconstructs every row state from disk after restart — no in-memory data required", async () => {
      const s = sid("m3-recon-1");
      // m1 in-progress WITHOUT its impl KD, m2 checked-off with its impl KD on
      // disk. The in-memory map is EMPTY. A stuck row without evidence is
      // never promoted — the gate stays blocked on M1 alone.
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

      // Once M1's impl KD lands, reconciliation promotes the row from disk
      // evidence alone — no manual registry write, no in-memory data. The
      // gate reconstructs all-checked-off from disk (reconcile-or-fail-loud,
      // Issue 64: the old contract required a manual check-off call here).
      createKD(`impl-M1-recon-${s}.md`);
      const gate2 = hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap);
      expect(gate2.ok).toBe(true);
      expect(gate2.checkedOff).toBe(2);
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: checked-off");
    });

    it("atomic registry write leaves no tmp residue and the YAML stays valid", async () => {
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

    it("checked-off rows re-open on re-dispatch but stay immutable otherwise (evidence preserved)", async () => {
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
      // The before-hook fires the check-off; the write tool itself lands the
      // impl KD right after — both halves of the write operation.
      const artisan = sid("m3-reopen-art");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "c1" },
        { args: { filePath: `knowledge/impl-M1-fix-${s}-gen0.md`, content: "# IMPLEMENTATION SUMMARY (fix)" } }
      );
      createKD(`impl-M1-fix-${s}-gen0.md`);
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

    it("a SWARM re-dispatch of a checked-off milestone names the re-dispatch trigger in a loud diagnostic", async () => {
      const s = sid("m3-reopen-diag");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`impl-M1-reopen-${s}.md`);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "task", sessionID: s, callID: "c1" },
          { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
        );
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("REOPEN:");
        expect(log).toContain("M1");
        expect(log).toContain("re-dispatch");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: in-progress");
    });
  });

  it("tool.definition respects the phase allowlist — read restricted during SWARM, non-allowlisted tools blocked elsewhere, task always passes", async () => {
    // SWARM: read is allowlisted and carries the milestone-registry restriction
    const s = sid("swarm-def-1");
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);

    const readOut = { description: "Test read", parameters: {} };
    await hooks["tool.definition"]({ toolID: "read" }, readOut);
    expect(readOut.description).not.toContain("⛔");
    expect(readOut.description).toContain("SWARM phase restriction: ONLY milestone registry KDs");

    // A tool still outside the SWARM allowlist keeps the blocking notice
    const editOut = { description: "Test edit", parameters: {} };
    await hooks["tool.definition"]({ toolID: "edit" }, editOut);
    expect(editOut.description).toContain("⛔");

    // INTENT: glob/grep get the ⛔ prefix; edit is allowlisted and
    // carries a scoped restriction instead; task always passes.
    const s2 = sid("def-1");
    await initOverseer(s2);
    hooks.sessionPhaseMap.set(s2, hooks.STATES.INTENT);
    for (const tool of ["glob", "grep"]) {
      const output = { description: `Test ${tool}`, parameters: {} };
      await hooks["tool.definition"]({ toolID: tool }, output);
      expect(output.description).toContain("⛔");
    }
    const intentEditOut = { description: "Test edit", parameters: {} };
    await hooks["tool.definition"]({ toolID: "edit" }, intentEditOut);
    expect(intentEditOut.description).not.toContain("⛔");
    expect(intentEditOut.description).toContain("INTENT phase restriction: ONLY knowledge/intent-*.md");
    const taskOut = { description: "Test task", parameters: {} };
    await hooks["tool.definition"]({ toolID: "task" }, taskOut);
    expect(taskOut.description).not.toContain("⛔");
  });

  it("enforces checkpoint-KD ownership: artisan blocked, committer allowed", async () => {
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

  it("debug logs capture generation increment, stale-KD cleanup, and generation-scoped disk checks", async () => {
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

  describe("registry-based SWARM→VERIFY gate", () => {
    it("advances SWARM→VERIFY only when ALL registry milestones are checked-off with impl KDs on disk", async () => {
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

    it("blocks rows without impl-KD evidence; evidence-backed stuck rows reconcile at gate evaluation (Issue 64)", async () => {
      const s = sid("m5-pending");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "in-progress"]]);

      // M2 is stuck in-progress WITHOUT its impl KD → no evidence, no
      // promotion — the gate stays blocked.
      createKD(`impl-M1-feature-${s}.md`);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M2: in-progress");

      // M3 pending without evidence → still blocked.
      createRegistry(s, [["M1", "checked-off"], ["M2", "in-progress"], ["M3", "pending"]]);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // Evidence lands for both stuck rows → reconciliation promotes them at
      // the next evaluation and the gate opens without manual repair.
      createKD(`impl-M2-feature-${s}.md`);
      createKD(`impl-M3-feature-${s}.md`);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M2: checked-off");
      expect(content).toContain("  M3: checked-off");
    });

    it("missing, empty, and unparsable registries fail closed with a log, never advance", async () => {
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

    it("force-advance paths during SWARM mark the stuck milestone failed, stay in SWARM, and log SAFETY_STUCK", async () => {
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

    it("a fresh milestone never trips the cap even when another milestone in the same session has consumed 5+ redispatches (false-positive regression guard)", async () => {
      const s = sid("f1-ac001");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"], ["M2", "in-progress"]]);
      // M1 has genuinely burned its 5-redispatch budget; M2 has zero prior attempts.
      hooks.phaseRedispatchCount.set(`${s}:M1`, 5);

      // M2's first dispatch must be allowed — a missing key reads 0 and can
      // never satisfy `>= 5`. Before the fix this tripped SAFETY_STUCK because
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

    it("after exactly 5 attempts on the SAME milestone, the 6th dispatch throws SAFETY_STUCK", async () => {
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

    it("when the cap fires for A, only A's row fails and a fresh milestone B dispatches normally", async () => {
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

        // Only the offending milestone's row is marked failed; other
        // in-progress rows stay in-progress.
        const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
        expect(content).toContain("  M1: failed");
        expect(content).toContain("  M2: in-progress");
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }

      // Milestone B is unaffected by A's exhausted budget — no throw.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "f1-ac006-2" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M2\nMODE: swarm" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M2`)).toBe(1);
    });

    it("M3 and m3 increment the same normalized key; 5 mixed-case attempts trip the cap", async () => {
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
      // The key is case-normalized to uppercase — m3 maps onto M3.
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

    it("a successful check-off resets the per-milestone budget; re-dispatch starts fresh", async () => {
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
      // The per-milestone counter is deleted on successful check-off.
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();

      // Re-dispatch re-open starts a fresh budget — zero prior attempts.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "f1-ac005-r" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(1);
    });

    it("SWARM FORCE ADVANCE stays global and clears all per-milestone keys", async () => {
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

      // FORCE ADVANCE fails ALL non-checked-off, non-failed rows; M1's
      // checked-off evidence stays immutable (global lifecycle deadlock escape).
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
      expect(content).toContain("  M2: failed");
      // Per-milestone keys are cleared alongside the phase key.
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:M2`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.SWARM}`)).toBeUndefined();
    });

    it("regression to SWARM clears all per-milestone keys", async () => {
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

    it("non-SWARM phases keep the phase-keyed counter behavior", async () => {
      const s = sid("f1-ac009");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.CLEANUP);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "f1-ac009-1" },
        { args: { subagent_type: "committer", prompt: "AGENT: committer\nMODE: cleanup" } }
      );
      // The phase key is incremented; no per-milestone key is created.
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.CLEANUP}`)).toBe(1);
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.SWARM}`)).toBeUndefined();
    });

    it("/phase override from SWARM logs SAFETY_ESCAPE — the only automatic escape hatch removed", async () => {
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

    it("/phase SAFETY_ESCAPE from SWARM clears per-milestone keys but preserves phase counters", async () => {
      const s = sid("m2-escape-clear");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.phaseRedispatchCount.set(`${s}:M1`, 3);
      hooks.phaseRedispatchCount.set(`${s}:M2`, 2);
      hooks.phaseRedispatchCount.set(`${s}:${hooks.STATES.SWARM}`, 4);

      // User override escapes the stuck SWARM — the only automatic escape hatch.
      const output = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "VERIFY" }, output);

      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      // An escaped-and-continued lifecycle restarts each
      // milestone with a fresh budget, while the numeric phase counter stays.
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:M2`)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.SWARM}`)).toBe(4);
    });

    it("same-phase /phase override (SWARM → SWARM) clears nothing", async () => {
      const s = sid("m2-same-phase");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.phaseRedispatchCount.set(`${s}:M1`, 2);
      hooks.phaseRedispatchCount.set(`${s}:${hooks.STATES.SWARM}`, 3);

      // A same-phase override is not an escape — budgets and counters are preserved.
      const output = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "SWARM" }, output);

      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(2);
      expect(hooks.phaseRedispatchCount.get(`${s}:${hooks.STATES.SWARM}`)).toBe(3);
    });

    it("MILESTONE_COUNT is no longer extracted or stored; counts have no gating effect", async () => {
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

      // Even with dispatchCount 1, a pending row without its impl KD blocks —
      // count signals have no gating effect either way.
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);

      // Evidence lands — reconciliation promotes the pending row and the gate
      // opens on disk truth alone; dispatchCount 1 has no gating effect.
      createKD(`impl-M1-feature-${s}.md`);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);

      // Registry fully checked-off advances regardless of count signals
      createRegistry(s, [["M1", "checked-off"]]);
      hooks.swarmDispatchCount.set(s, 5);
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
    });
  });

  describe("SWARM→VERIFY reconciliation + loud auto-checkoff diagnostics (Issue 64)", () => {
    // Captures the loud channel (now file-based) — reads from the log file gated
    // behind PROTOCOL_GATE_DEBUG. Always clean up in finally.
    function readLoudLog() {
      try { return readFileSync(logPath, "utf8"); } catch (_) { return ""; }
    }

    it("promotes an evidence-backed stuck row at gate evaluation and advances — including a filename generation that differs from the persisted generation", async () => {
      const s = sid("m1-rec-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.sessionPhaseMap.set(`${s}:gen`, 1);
      // Registry + M2 evidence carry the persisted generation suffix.
      createKD(`milestones-feature-${s}-gen1.md`, registryContent([["M1", "in-progress"], ["M2", "checked-off"]]));
      createKD(`impl-M2-feat-${s}-gen1.md`);
      // M1's impl KD embeds gen 0 while the lifecycle persists generation 1 —
      // the observed gen0/gen1 divergence must still count as evidence.
      createKD(`impl-M1-feat-${s}-gen0.md`);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
        expect(readLoudLog()).toContain(`RECONCILE_CHECKOFF: milestone M1 promoted in-progress → checked-off (impl KD impl-M1-feat-${s}-gen0.md)`);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      // The promotion is persisted — the registry row itself now reads checked-off.
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}-gen1.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
    });

    it("reconciliation is idempotent — re-evaluation with all rows checked-off emits nothing further and leaves the registry stable", async () => {
      const s = sid("m1-rec-2");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "pending"], ["M2", "checked-off"]]);
      createKD(`impl-M1-idem-${s}.md`);
      createKD(`impl-M2-idem-${s}.md`);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
        expect(readLoudLog()).toContain("RECONCILE_CHECKOFF: milestone M1 promoted pending → checked-off");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }

      const before = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      // Second call — should not emit further RECONCILE_CHECKOFF.
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
        expect(readLoudLog()).not.toContain("RECONCILE_CHECKOFF");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toBe(before);
    });

    it("never promotes a stuck row without disk evidence — the gate stays blocked and the blocked-row diagnostic still names it", async () => {
      const s = sid("m1-rec-3");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"], ["M2", "checked-off"]]);
      createKD(`impl-M2-feat-${s}.md`);

      const gate = hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap);
      expect(gate.ok).toBe(false);
      expect(gate.checkedOff).toBe(1);
      // The registry row was never promoted.
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: in-progress");

      // The blocked-row diagnostic still names the stuck row (warn channel).
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap);
        expect(readFileSync(logPath, "utf8")).toContain("blocked by: M1");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("never promotes across session ids — another session's impl KD is not evidence for this lifecycle's stuck row", async () => {
      const s = sid("m1-rec-4");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "failed"]]);

      const other = sid("m1-rec-other");
      createKD(`impl-M1-cross-${other}.md`);

      expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: failed");
    });

    it("AUTO_CHECKOFF_FAILED fires on the loud channel (invalid-transition fixture)", async () => {
      const s = sid("m1-diag-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      // A pending row cannot complete directly — the check-off transition from
      // pending is invalid, which is exactly the silent-failure shape Issue 64
      // buried (Defect A window: impl KD written before the dispatch flip).
      createRegistry(s, [["M1", "pending"]]);

      const artisan = sid("m1-diag-1-art");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "write", sessionID: artisan, callID: "c1" },
          { args: { filePath: `knowledge/impl-M1-early-${s}.md`, content: "# IMPLEMENTATION SUMMARY" } }
        );
        const log = readLoudLog();
        expect(log).toContain("AUTO_CHECKOFF_FAILED");
        expect(log).toContain("invalid-transition");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      // The registry row is untouched by the failed attempt.
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: pending");
    });

    it("AUTO_CHECKOFF_UNMATCHED fires on the loud channel when no parent candidate matches the filename", async () => {
      const s = sid("m1-diag-2");
      await initOverseer(s);

      const artisan = sid("m1-diag-2-art");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      const orphan = `knowledge/impl-M9-orphan-ses_foreign0000000000-gen7.md`;
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "write", sessionID: artisan, callID: "c1" },
          { args: { filePath: orphan, content: "# IMPLEMENTATION SUMMARY" } }
        );
        expect(readLoudLog()).toContain(`AUTO_CHECKOFF_UNMATCHED: ${orphan}`);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("a re-opened milestone's stale impl KDs are superseded — the reopened row is not instantly re-checked-off, and fresh evidence re-completes it", async () => {
      const s = sid("m1-supersede-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`impl-M1-first-${s}.md`);
      expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);

      // Inspector findings → Overseer re-dispatches M1 → the row re-opens and
      // its prior completion evidence is superseded ON DISK.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "c1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm" } }
      );
      let content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: in-progress");
      expect(existsSync(join(knowledgeDir, `impl-M1-first-${s}.md`))).toBe(false);
      expect(existsSync(join(knowledgeDir, `impl-M1-first-${s}.md.superseded.md`))).toBe(true);

      // The stale evidence no longer re-checks-off the row — the gate stays closed.
      expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);

      // Fresh fix evidence → auto check-off completes the row → gate opens.
      // The before-hook fires the check-off; the write tool itself lands the
      // impl KD right after — both halves of the write operation.
      const artisan = sid("m1-supersede-1-art");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "c2" },
        { args: { filePath: `knowledge/impl-M1-fix-${s}-gen0.md`, content: "# IMPLEMENTATION SUMMARY (fix)" } }
      );
      createKD(`impl-M1-fix-${s}-gen0.md`);
      content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
      expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
    });

    it("a stuck row whose only same-session impl evidence is superseded file(s) emits SUPERSEDED_EVIDENCE and stays unpromoted", async () => {
      const s = sid("m1-superseded-ev");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      // M1 is genuinely done; M2 is stuck and its stale completion evidence was
      // renamed by supersede-on-reopen — the only impl-M2-* files on disk carry
      // the .superseded.md suffix (generation-scoped and legacy variants).
      createRegistry(s, [["M1", "checked-off"], ["M2", "in-progress"]]);
      createKD(`impl-M1-feature-${s}.md`);
      createKD(`impl-M2-old-${s}-gen1.md.superseded.md`);
      createKD(`impl-M2-legacy-${s}.md.superseded.md`);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
        const log = readLoudLog();
        expect(log).toContain("SUPERSEDED_EVIDENCE");
        expect(log).toContain(`impl-M2-old-${s}-gen1.md.superseded.md`);
        expect(log).toContain(`impl-M2-legacy-${s}.md.superseded.md`);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      // The row stays unpromoted — superseded evidence is provenance, proof of completion.
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M2: in-progress");
    });

    it("live impl evidence alongside superseded files promotes the row via the live file with zero SUPERSEDED_EVIDENCE", async () => {
      const s = sid("m1-live-plus-superseded");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);
      createKD(`impl-M1-old-${s}.md.superseded.md`);
      createKD(`impl-M1-fix-${s}.md`);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
        const log = readLoudLog();
        expect(log).toContain("RECONCILE_CHECKOFF");
        expect(log).not.toContain("SUPERSEDED_EVIDENCE");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: checked-off");
    });

    it("the session-KD predicate keeps rejecting .superseded.md filenames across both naming eras", () => {
      const s = sid("m1-pred-pin");
      expect(hooks.matchesSessionKDAnyGeneration(`impl-M2-x-${s}-gen1.md.superseded.md`, s)).toBe(false);
      expect(hooks.matchesSessionKDAnyGeneration(`impl-M2-x-${s}.md.superseded.md`, s)).toBe(false);
      // Control: the un-superseded forms still match.
      expect(hooks.matchesSessionKDAnyGeneration(`impl-M2-x-${s}-gen1.md`, s)).toBe(true);
      expect(hooks.matchesSessionKDAnyGeneration(`impl-M2-x-${s}.md`, s)).toBe(true);
    });

    it("checks off a milestone when the writing session's agent is not recorded (unknown-agent silent skip)", async () => {
      // The writing session never calls chat.params with an agent, so it is
      // absent from sessionAgentMap — the write-path trigger must still fire
      // the check-off (the registry state machine is the guard, not the agent).
      const overseer = sid("m1-unknown-1");
      await initOverseer(overseer);
      hooks.sessionPhaseMap.set(overseer, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${overseer}:sid`, overseer);
      createRegistry(overseer, [["M1", "in-progress"]]);

      const writer = sid("m1-unknown-1-w");
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: writer, callID: "c1" },
        { args: { filePath: `knowledge/impl-M1-feature-${overseer}.md`, content: "# IMPLEMENTATION SUMMARY" } }
      );

      const content = readFileSync(join(knowledgeDir, `milestones-feature-${overseer}.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
    });

    it("emits a file-only AUTO_CHECKOFF_NON_ARTISAN diagnostic for an unknown writer and never writes to stderr", async () => {
      const overseer = sid("m1-nonart-1");
      await initOverseer(overseer);
      hooks.sessionPhaseMap.set(overseer, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${overseer}:sid`, overseer);
      createRegistry(overseer, [["M1", "in-progress"]]);

      const writer = sid("m1-nonart-1-w");
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "write", sessionID: writer, callID: "c1" },
          { args: { filePath: `knowledge/impl-M1-feature-${overseer}.md`, content: "# IMPLEMENTATION SUMMARY" } }
        );
        const log = readLoudLog();
        expect(log).toContain(`AUTO_CHECKOFF_NON_ARTISAN: agent=unknown path=knowledge/impl-M1-feature-${overseer}.md`);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
        stderrSpy.mockRestore();
      }
      // The diagnostic is emit-always — the check-off still proceeds.
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${overseer}.md`), "utf8")).toContain("  M1: checked-off");
    });

    it("emits AUTO_CHECKOFF_UNMATCHED on a generation-mismatched write yet the gate still promotes the row", async () => {
      // The lifecycle persists generation 1; the impl KD filename embeds gen 0.
      // The write-path trigger's strict-generation match fails (AUTO_CHECKOFF_UNMATCHED),
      // but the gate's any-generation reconciliation still promotes the row.
      const s = sid("m1-genmis-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.sessionPhaseMap.set(`${s}:gen`, 1);
      // Persist generation 1 on disk (the state file is the SSOT the write-path
      // trigger reads) so the gen0 impl KD filename is a genuine mismatch.
      writeFileSync(statePath(s), JSON.stringify({ phase: hooks.STATES.SWARM, generation: 1, sid: s, timestamp: Date.now() }));
      createKD(`milestones-feature-${s}-gen1.md`, registryContent([["M1", "in-progress"]]));

      const writer = sid("m1-genmis-1-w");
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "write", sessionID: writer, callID: "c1" },
          { args: { filePath: `knowledge/impl-M1-feat-${s}-gen0.md`, content: "# IMPLEMENTATION SUMMARY" } }
        );
        expect(readLoudLog()).toContain(`AUTO_CHECKOFF_UNMATCHED: knowledge/impl-M1-feat-${s}-gen0.md`);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      // The registry row is untouched by the write-path miss (strict gen).
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}-gen1.md`), "utf8")).toContain("  M1: in-progress");
      // The write tool lands the impl KD on disk after the before-hook.
      createKD(`impl-M1-feat-${s}-gen0.md`);

      // The gate's any-generation reconciliation still promotes the row.
      expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}-gen1.md`), "utf8")).toContain("  M1: checked-off");
    });
  });

  describe("gate disk-check tool-set widening — read/bash trigger reconciliation", () => {
    function readLoudLog() {
      try { return readFileSync(logPath, "utf8"); } catch (_) { return ""; }
    }

    it("an Overseer read call in SWARM triggers reconciliation and promotes a stuck row", async () => {
      const s = sid("m2-read-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);
      createKD(`impl-M1-feature-${s}.md`);

      // The read tool-hook path: the Overseer reads the milestone registry KD
      // in SWARM (permitted by the SWARM read restriction) — the disk check now
      // runs on read calls (widened DISK_CHECK_TOOLS).
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c1" },
        { args: { filePath: `knowledge/milestones-feature-${s}.md` } }
      );

      // Reconciliation promoted the stuck row.
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: checked-off");
      // All milestones checked-off → the gate advanced SWARM → VERIFY.
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
    });

    it("DISK_CHECK_TOOLS includes bash and the gate promotes a stuck row at unit level", async () => {
      // Static assertion — the widened tool set is exported for tests.
      expect(hooks.DISK_CHECK_TOOLS).toContain("bash");
      expect(hooks.DISK_CHECK_TOOLS).toContain("read");

      // Behavioral: the exact function the disk check invokes promotes the
      // stuck row. The full tool-hook bash path is unreachable in SWARM — the
      // SWARM allowlist excludes bash and the allowlist check runs before the
      // disk check (BR-3; widening the allowlist is out of scope).
      const s = sid("m2-bash-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);
      createKD(`impl-M1-feature-${s}.md`);

      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(true);
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: checked-off");
    });

    it("a read call with no impl-KD evidence does not advance the phase", async () => {
      const s = sid("m2-nospur-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      // No impl KD on disk — the all-checked-off verdict is not met, so the
      // widened read path must not advance the phase.
      expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, hooks.swarmDispatchCount)).toBe(false);
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: s, callID: "c1" },
        { args: { filePath: `knowledge/milestones-feature-${s}.md` } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: in-progress");
    });

    it("a live non-superseded same-session impl KD auto-advances on the next gate evaluation without a re-affirm dispatch", async () => {
      const s = sid("m2-live-1");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);
      // The expected-path impl KD: impl-<milestone_id>-<name>-<session_id>[-gen{N}].md
      createKD(`impl-M1-feature-${s}.md`);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        // Next gate evaluation — an Overseer read tool-hook call (widened tool set).
        await hooks["tool.execute.before"](
          { tool: "read", sessionID: s, callID: "c1" },
          { args: { filePath: `knowledge/milestones-feature-${s}.md` } }
        );
        const log = readLoudLog();
        expect(log).toContain("RECONCILE_CHECKOFF");
        expect(log).not.toContain("SUPERSEDED_EVIDENCE");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      // The registry YAML block reads checked-off — no re-affirm dispatch needed.
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: checked-off");
    });
  });

  describe("empty-result redispatch reconciliation", () => {
    // The before-hook charges the redispatch budget at the increment site and
    // records the dispatch in lastTaskDispatch; the tool.execute.after hook
    // restores the charge when no expected RESULT KD lands on disk
    // (empty-result detection). All tests drive the hooks directly — the same
    // pattern the redispatch suite uses — and assert against the exported
    // phaseRedispatchCount / lastTaskDispatch maps.

    it("an empty-result dispatch restores the counter to its pre-dispatch value; the next dispatch of the same milestone is not capped", async () => {
      const s = sid("t14-01");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      // First dispatch charges the M1 budget and records the dispatch.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "t14-01-1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm\nRESULT KD: knowledge/impl-M1-feature.md" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(1);
      expect(hooks.lastTaskDispatch.get(s)).toBeDefined();

      // The dispatch returns empty — no expected KD lands on disk. The
      // after-hook must restore the counter to its pre-dispatch value.
      await hooks["tool.execute.after"](
        { tool: "task", sessionID: s, callID: "t14-01-1" },
        { output: "", title: "" }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();
      expect(hooks.lastTaskDispatch.get(s)).toBeUndefined();

      // A second dispatch of the same milestone is not capped (regression
      // guard — the empty result did not burn a slot).
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "t14-01-2" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm\nRESULT KD: knowledge/impl-M1-feature.md" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(1);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    });

    it("a successful dispatch leaves the counter at its check-off/phase value", async () => {
      // Part A — SWARM: the impl-KD check-off resets the per-milestone key;
      // the after-hook leaves that reset state alone.
      const s = sid("t14-02-swarm");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "t14-02-1" },
        { args: { subagent_type: "artisan", prompt: `AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm\nRESULT KD: knowledge/impl-M1-feature-${s}.md` } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(1);

      // Artisan produces the expected impl KD → auto check-off deletes the key.
      const artisan = sid("t14-02-art");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "t14-02-w" },
        { args: { filePath: `knowledge/impl-M1-feature-${s}.md`, content: "# IMPLEMENTATION SUMMARY" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();

      // After-hook sees the expected KD on disk — the counter stays reset.
      await hooks["tool.execute.after"](
        { tool: "task", sessionID: s, callID: "t14-02-1" },
        { output: "done", title: "impl" }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();
      expect(hooks.lastTaskDispatch.get(s)).toBeUndefined();

      // Part B — non-SWARM (CLEANUP): no check-off, so the increment survives
      // the after-hook when the expected cleanup KD exists on disk.
      const s2 = sid("t14-02-cleanup");
      await initOverseer(s2);
      hooks.sessionPhaseMap.set(s2, hooks.STATES.CLEANUP);
      hooks.sessionPhaseMap.set(`${s2}:sid`, s2);

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s2, callID: "t14-02-c2" },
        { args: { subagent_type: "committer", prompt: "AGENT: committer\nMODE: cleanup\nRESULT KD: knowledge/cleanup-feature.md" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s2}:${hooks.STATES.CLEANUP}`)).toBe(1);
      createKD("cleanup-feature.md");
      await hooks["tool.execute.after"](
        { tool: "task", sessionID: s2, callID: "t14-02-c2" },
        { output: "done", title: "cleanup" }
      );
      expect(hooks.phaseRedispatchCount.get(`${s2}:${hooks.STATES.CLEANUP}`)).toBe(1);
      expect(hooks.lastTaskDispatch.get(s2)).toBeUndefined();
    });

    it("the after-hook is a no-op for non-task tools and non-overseer sessions", async () => {
      const s = sid("t14-03");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      // Charge a dispatch, then fire the after-hook with a non-task tool — the
      // recorded entry and the counter must stay untouched.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "t14-03-1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm\nRESULT KD: knowledge/impl-M1-feature.md" } }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(1);
      await hooks["tool.execute.after"](
        { tool: "glob", sessionID: s, callID: "t14-03-g" },
        { output: "", title: "" }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(1);
      expect(hooks.lastTaskDispatch.get(s)).toBeDefined();

      // A non-overseer (subagent) session's task after-hook never reconciles —
      // mirror of the :1779 gate; subagent→subagent task calls never touch the
      // overseer counter. Seed the map directly since the before-hook never
      // records for non-overseer sessions.
      const sub = sid("t14-03-sub");
      await hooks["chat.params"]({ sessionID: sub, agent: "artisan" }, {});
      hooks.lastTaskDispatch.set(sub, { redispatchKey: `${sub}:M1`, resultKd: null, prefixes: ["impl"], phase: hooks.STATES.SWARM, agentName: "artisan", callID: "t14-03-s" });
      hooks.phaseRedispatchCount.set(`${sub}:M1`, 1);
      await hooks["tool.execute.after"](
        { tool: "task", sessionID: sub, callID: "t14-03-s" },
        { output: "", title: "" }
      );
      expect(hooks.phaseRedispatchCount.get(`${sub}:M1`)).toBe(1);
      expect(hooks.lastTaskDispatch.get(sub)).toBeDefined();
    });

    it("the after-hook returns without changes when no dispatch is recorded for the session", async () => {
      const s = sid("t14-04");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      hooks.phaseRedispatchCount.set(`${s}:M1`, 3);

      await hooks["tool.execute.after"](
        { tool: "task", sessionID: s, callID: "t14-04-1" },
        { output: "", title: "" }
      );
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBe(3);
      expect(hooks.lastTaskDispatch.get(s)).toBeUndefined();
    });

    it("lastTaskDispatch entries are removed after reconciliation in both the KD-present and KD-absent paths", async () => {
      // KD-absent path (empty result) — entry removed, counter restored.
      const s = sid("t14-05-empty");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "t14-05-e1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm\nRESULT KD: knowledge/impl-M1-feature.md" } }
      );
      expect(hooks.lastTaskDispatch.get(s)).toBeDefined();
      await hooks["tool.execute.after"](
        { tool: "task", sessionID: s, callID: "t14-05-e1" },
        { output: "", title: "" }
      );
      expect(hooks.lastTaskDispatch.get(s)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s}:M1`)).toBeUndefined();

      // KD-present path (success) — entry removed, counter keeps its value.
      const s2 = sid("t14-05-kd");
      await initOverseer(s2);
      hooks.sessionPhaseMap.set(s2, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s2}:sid`, s2);
      createRegistry(s2, [["M1", "in-progress"]]);
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s2, callID: "t14-05-k1" },
        { args: { subagent_type: "artisan", prompt: "AGENT: artisan\nMILESTONE ID: M1\nMODE: swarm\nRESULT KD: knowledge/impl-M1-feature.md" } }
      );
      expect(hooks.lastTaskDispatch.get(s2)).toBeDefined();
      createKD("impl-M1-feature.md");
      await hooks["tool.execute.after"](
        { tool: "task", sessionID: s2, callID: "t14-05-k1" },
        { output: "done", title: "impl" }
      );
      expect(hooks.lastTaskDispatch.get(s2)).toBeUndefined();
      expect(hooks.phaseRedispatchCount.get(`${s2}:M1`)).toBe(1);
    });
  });

  describe("structural git-stage guard", () => {
    // The stage guard runs in toolExecuteBefore for tool ===
    // "bash" BEFORE the overseer/non-overseer split so it covers every session
    // — no lifecycle phase or overseer initialization is needed for these
    // tests. It rejects git add invocations that carry a force flag or an
    // explicit path under the gitignored knowledge/ set, and passes everything
    // else through.

    async function bash(s, callID, command) {
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: s, callID },
        { args: { command } }
      );
    }

    it("rejects `git add` with a force flag and a knowledge path (GITIGNORED_STAGE_REJECTED)", async () => {
      const s = sid("t43-01");
      await expect(bash(s, "t43-01-1", "git add -f knowledge/impl-foo.md")).rejects.toMatchObject({ code: "GITIGNORED_STAGE_REJECTED" });
      await expect(bash(s, "t43-01-2", "git add --force knowledge/impl-foo.md")).rejects.toMatchObject({ code: "GITIGNORED_STAGE_REJECTED" });
      await expect(bash(s, "t43-01-3", "git add plugins/foo.js -f")).rejects.toMatchObject({ code: "GITIGNORED_STAGE_REJECTED" });
    });

    it("rejects `git add` of an explicit knowledge/ path (GITIGNORED_STAGE_REJECTED)", async () => {
      const s = sid("t43-02");
      await expect(bash(s, "t43-02-1", "git add knowledge/impl-foo.md")).rejects.toMatchObject({ code: "GITIGNORED_STAGE_REJECTED" });
      await expect(bash(s, "t43-02-2", "git add ./knowledge/issues/issue-1.md")).rejects.toMatchObject({ code: "GITIGNORED_STAGE_REJECTED" });
      await expect(bash(s, "t43-02-3", "git add knowledge/")).rejects.toMatchObject({ code: "GITIGNORED_STAGE_REJECTED" });
    });

    it("passes through `git add <tracked-path>`", async () => {
      const s = sid("t43-03");
      await expect(bash(s, "t43-03-1", "git add plugins/protocol-gate/index.js")).resolves.toBeUndefined();
    });

    it("passes through `git add .`, `git add -A`, and non-add git commands", async () => {
      const s = sid("t43-04");
      await expect(bash(s, "t43-04-1", "git add .")).resolves.toBeUndefined();
      await expect(bash(s, "t43-04-2", "git add -A")).resolves.toBeUndefined();
      await expect(bash(s, "t43-04-3", "git status")).resolves.toBeUndefined();
      await expect(bash(s, "t43-04-4", "git ls-files")).resolves.toBeUndefined();
    });

    it("the guard is a no-op for non-bash tools", async () => {
      const s = sid("t43-05");
      await expect(
        hooks["tool.execute.before"]({ tool: "write", sessionID: s, callID: "t43-05-1" }, { args: { filePath: "knowledge/impl-foo.md", content: "x" } })
      ).resolves.toBeUndefined();
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: s, callID: "t43-05-2" }, { args: { subagent_type: "committer", prompt: "AGENT: committer\nMODE: checkpoint" } })
      ).resolves.toBeUndefined();
    });
  });

  describe("registry write ordering fix", () => {
    it("a multi-milestone dispatch (repeated lines or comma list) is rejected before any registry write — registry byte-identical", async () => {
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

    it("a single-milestone dispatch still advances its row exactly once (no phantom advancement)", async () => {
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

  describe("anchored fence parsing", () => {
    it("a registry with the Milestone States heading glued to the opening ```yaml fence is located and updated", async () => {
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

    it("the existing well-formed registry fixture (whitespace-only gap before the opening fence) still parses and updates", async () => {
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

    it("a foreign fence or embedded content between the heading and the YAML block fails closed with a byte-identical registry", async () => {
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

  describe("verdict-aware VERIFY gate", () => {
    // Delegates to the shared reviewKD builder — FAIL fixtures pass milestone
    // citations in the Findings section (the scoped-reopen provenance).
    function verdictKD(verdict, findings = "") {
      return reviewKD(verdict, findings);
    }

    it("a FAIL review KD auto-regresses VERIFY→SWARM without BACKWARD: true", async () => {
      const s = sid("f1-ac101");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`review-fail-${s}.md`, verdictKD("FAIL", "impl-M1-short-term-store has a defect"));

      // The next lifecycle tool call evaluates the gate — no BACKWARD flag,
      // no explicit dispatch, in any prompt.
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(hooks.verdictRegressedKDs.get(s).kdFilename).toBe(`review-fail-${s}.md`);
    });

    it("re-evaluating the same FAIL review KD without a new fix cycle does not regress again", async () => {
      const s = sid("f1-ac102");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`review-fail-${s}.md`, verdictKD("FAIL", "impl-M1 defect"));

      // First evaluation regresses VERIFY→SWARM.
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      const regressedAt = hooks.verdictRegressedKDs.get(s).regressedAt;

      // A later re-advance to VERIFY re-evaluates the SAME filename — the
      // fix-cycle guard suppresses a second regression when no new impl KD
      // landed after regressedAt (no infinite FAIL→SWARM→VERIFY loop).
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c2" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      // Guard still records the same KD with the same regressedAt.
      const guard = hooks.verdictRegressedKDs.get(s);
      expect(guard.kdFilename).toBe(`review-fail-${s}.md`);
      expect(guard.regressedAt).toBe(regressedAt);
    });

    it("FAIL regression reopens ONLY the cited checked-off milestone rows and the SWARM gate stays closed", async () => {
      const s = sid("f1-ac103");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"], ["M3", "checked-off"]]);
      createKD(`impl-M1-feature-${s}.md`);
      createKD(`impl-M2-feature-${s}.md`);
      createKD(`impl-M3-feature-${s}.md`);
      // All rows checked-off with impl KDs on disk — the SWARM→VERIFY gate
      // would advance if the lifecycle were still in SWARM.
      expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);

      // FAIL review cites ONLY M1 and M2 — M3 must stay checked-off.
      createKD(`review-fail-${s}.md`, verdictKD("FAIL", "- impl-M1-short-term-store has a defect\n- impl-M2-resume-hint has a defect"));
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);

      // Only cited rows re-open to in-progress; the unrelated checked-off row
      // is untouched — the gate fails closed until fresh impl KDs land.
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      expect(content).toContain("  M1: in-progress");
      expect(content).toContain("  M2: in-progress");
      expect(content).toContain("  M3: checked-off");
      expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(false);
    });

    it("a FUNDAMENTAL verdict blocks VERIFY advancement and escalates without regressing", async () => {
      const s = sid("f1-ac104");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      // TEST-ONLY: the FUNDAMENTAL_ESCALATION line below is asserted test output for the
      // review-fund-<sid>.md fixture — verify against the test source before treating it
      // as a lifecycle anomaly.
      createKD(`review-fund-${s}.md`, verdictKD("FUNDAMENTAL"));

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c1" },
          { args: { pattern: "knowledge/*.md" } }
        );
        // Blocked — stays in VERIFY, never regresses.
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
        expect(hooks.verdictRegressedKDs.has(s)).toBe(false);
        // Escalation signal names the KD.
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("FUNDAMENTAL_ESCALATION");
        expect(log).toContain(`review-fund-${s}.md`);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("a fresh PASS review KD advances on the merged surface; a MISSING verdict blocks", async () => {
      // Fresh PASS advances — single review KD, no audit KD required (R010).
      const pass = sid("f1-ac105-pass");
      await initOverseer(pass);
      hooks.sessionPhaseMap.set(pass, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${pass}:sid`, pass);
      createKD(`review-pass-${pass}.md`, verdictKD("PASS"));
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: pass, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(pass)).toBe(hooks.STATES.EXTRACT);

      // MISSING (no verdict field) blocks — never treated as PASS (P012).
      const missing = sid("f1-ac105-missing");
      await initOverseer(missing);
      hooks.sessionPhaseMap.set(missing, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${missing}:sid`, missing);
      createKD(`review-legacy-${missing}.md`, "test content");
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: missing, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(missing)).toBe(hooks.STATES.VERIFY);
    });

    it("more than 3 FAIL regression cycles surface CYCLE_LIMIT_EXCEEDED instead of looping", async () => {
      const s = sid("f1-ac106");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      for (let i = 1; i <= 3; i++) {
        createKD(`review-cycle${i}-${s}.md`, verdictKD("FAIL", "impl-M1 defect"));
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: `c${i}` },
          { args: { pattern: "knowledge/*.md" } }
        );
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
        // Drive the phase back to VERIFY for the next fix cycle.
        hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      }
      // The manual phase set back to VERIFY is NOT a forward advance,
      // so the per-target-phase cycle counter is never reset — it sits at the
      // cap before the 4th regression fires the hard stop.
      expect(hooks.cycleMap.get(s)[hooks.STATES.SWARM]).toBe(3);

      // The 4th distinct FAIL KD exceeds the 3-cycle cap.
      createKD(`review-cycle4-${s}.md`, verdictKD("FAIL", "impl-M1 defect"));
      const err = await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c4" },
        { args: { pattern: "knowledge/*.md" } }
      ).then(() => null, e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("CYCLE_LIMIT_EXCEEDED");
    });

    it("the newest review KD wins; a missing verdict blocks advancement (MISSING)", async () => {
      const s = sid("f1-ec01");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);
      createKD(`review-older-${s}.md`, verdictKD("FAIL", "impl-M1 defect"));
      createKD(`review-newer-${s}.md`, "no verdict frontmatter");
      // Make the newer KD decisively newest via mtime so the filename
      // tie-break is not load-bearing (newest wins).
      utimesSync(join(knowledgeDir, `review-newer-${s}.md`), new Date(), new Date(Date.now() + 5000));

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c1" },
          { args: { pattern: "knowledge/*.md" } }
        );
        // Newest has no verdict → MISSING → blocked (never treated as PASS);
        // the older FAIL verdict does not fire because newest wins.
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
        expect(readFileSync(logPath, "utf8")).toContain("VERDICT_MISSING");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("the REVIEW template carries the verdict frontmatter field", async () => {
      const tpl = readFileSync(join(process.cwd(), "skills/template-review/SKILL.md"), "utf8");
      expect(tpl).toMatch(/^verdict\s*:\s*\{\{PASS \| FAIL \| FUNDAMENTAL\}\}\s*$/m);
    });
  });

  describe("M2 protocol-gate fixes (cycle reset / superseded evidence / SWARM watchdog)", () => {
    // Captures the loud channel (file-based, gated behind PROTOCOL_GATE_DEBUG).
    function readLoudLog() {
      try { return readFileSync(logPath, "utf8"); } catch (_) { return ""; }
    }

    it("the per-target-phase cycle counter resets on a successful forward advance — a 4th regression after the advance does not throw CYCLE_LIMIT_EXCEEDED", async () => {
      const s = sid("r004-reset");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      // Three FAIL regressions to SWARM — the cap is not yet exceeded.
      for (let i = 1; i <= 3; i++) {
        createKD(`review-cycle${i}-${s}.md`, reviewKD("FAIL", "impl-M1 defect"));
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: `c${i}` },
          { args: { pattern: "knowledge/*.md" } }
        );
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
        // Drive the phase back to VERIFY for the next fix cycle.
        hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      }
      expect(hooks.cycleMap.get(s)[hooks.STATES.SWARM]).toBe(3);

      // A genuine SWARM→VERIFY forward advance (all milestones checked-off
      // with impl KDs on disk) resets the SWARM cycle counter.
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`impl-M1-fix-${s}.md`);
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "adv" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      expect(hooks.cycleMap.get(s)[hooks.STATES.SWARM]).toBeUndefined();

      // A 4th regression after the successful advance does not throw — the
      // counter restarted at 1.
      createKD(`review-cycle4-${s}.md`, reviewKD("FAIL", "impl-M1 defect"));
      const err = await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c4" },
        { args: { pattern: "knowledge/*.md" } }
      ).then(() => null, e => e);
      expect(err).toBeNull();
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(hooks.cycleMap.get(s)[hooks.STATES.SWARM]).toBe(1);
    });

    it("a SWARM phase whose only impl evidence is superseded files does not regress to DECOMPOSE", async () => {
      const s = sid("r005-superseded");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      // Earlier-phase evidence (plan KD) so a regression WOULD fire without
      // the fix — a missing SWARM KD would walk back to DECOMPOSE.
      createKD(`plan-evidence-${s}.md`);
      // The only impl evidence for the current session is superseded files
      // (generation-scoped and legacy variants).
      createKD(`impl-M1-old-${s}.md.superseded.md`);
      createKD(`impl-M2-old-${s}-gen1.md.superseded.md`);

      const regressed = hooks.checkPhaseStateConsistency(
        s, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        hooks.saveState, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );
      expect(regressed).toBe(false);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);

      // Control: without the superseded evidence the same scan regresses to
      // DECOMPOSE — proving the superseded probe is what prevents regression.
      const s2 = sid("r005-control");
      await initOverseer(s2);
      hooks.sessionPhaseMap.set(s2, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s2}:sid`, s2);
      createKD(`plan-evidence-${s2}.md`);
      const regressedControl = hooks.checkPhaseStateConsistency(
        s2, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        hooks.saveState, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );
      expect(regressedControl).toBe(true);
      expect(hooks.sessionPhaseMap.get(s2)).toBe(hooks.STATES.DECOMPOSE);
    });

    it("the shared .superseded.md evidence predicates stay unchanged (MEM-212)", () => {
      const s = sid("r005-pred");
      // matchesSessionKD (generation-scoped) rejects superseded filenames.
      expect(hooks.matchesSessionKD(`impl-M2-x-${s}-gen1.md.superseded.md`, s, 1)).toBe(false);
      expect(hooks.matchesSessionKD(`impl-M2-x-${s}.md.superseded.md`, s, 0)).toBe(false);
      // matchesSessionKDAnyGeneration rejects superseded filenames.
      expect(hooks.matchesSessionKDAnyGeneration(`impl-M2-x-${s}-gen1.md.superseded.md`, s)).toBe(false);
      expect(hooks.matchesSessionKDAnyGeneration(`impl-M2-x-${s}.md.superseded.md`, s)).toBe(false);
      // Control: the un-superseded forms still match.
      expect(hooks.matchesSessionKD(`impl-M2-x-${s}-gen1.md`, s, 1)).toBe(true);
      expect(hooks.matchesSessionKD(`impl-M2-x-${s}.md`, s, 0)).toBe(true);
      expect(hooks.matchesSessionKDAnyGeneration(`impl-M2-x-${s}-gen1.md`, s)).toBe(true);
      expect(hooks.matchesSessionKDAnyGeneration(`impl-M2-x-${s}.md`, s)).toBe(true);
    });

    it("a blocked SWARM dispatch is recoverable via the watchdog without a manual /phase override", async () => {
      const s = sid("r006-watchdog");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        // Three blocked dispatches (wrong agent) — each throws WRONG_AGENT.
        for (let i = 1; i <= 3; i++) {
          const err = await hooks["tool.execute.before"](
            { tool: "task", sessionID: s, callID: `b${i}` },
            { args: { subagent_type: "inspector", prompt: "DISPATCH TO: inspector\nMODE: verify" } }
          ).then(() => null, e => e);
          expect(err).toBeInstanceOf(Error);
          expect(err.code).toBe("WRONG_AGENT");
        }
        // The watchdog fired at the threshold — loud diagnostic + counter reset.
        const log = readLoudLog();
        expect(log).toContain("SAFETY_STUCK");
        expect(log).toContain("blocked SWARM dispatches");
        expect(hooks.blockedDispatchCount.get(s)).toBeUndefined();
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("logs stalled SWARM dispatches to the log file without emitting to stderr", async () => {
      const s = sid("ac2-warn");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        // Path C: 10 tool calls without the expected KD → warn() "SWARM stalled".
        hooks.pendingVerification.set(s, { expectedPrefixes: ["impl"], toolType: "task", timestamp: Date.now(), toolCalls: 0 });
        hooks.pendingVerificationToolCount.set(s, 9);
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c10" },
          { args: { pattern: "knowledge/*.md" } }
        );
        let log = readLoudLog();
        expect(log).toContain("SWARM stalled");
        expect(log).toContain("10 tool calls");
        expect(log).toContain("impl");

        // Path A: 15 tool calls → pendingVerification force-advance marks the
        // stuck milestone failed and warn() "SWARM_STALLED" lists it.
        hooks.pendingVerification.set(s, { expectedPrefixes: ["impl"], toolType: "task", timestamp: Date.now(), toolCalls: 0 });
        hooks.pendingVerificationToolCount.set(s, 14);
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c15" },
          { args: { pattern: "knowledge/*.md" } }
        );
        log = readLoudLog();
        expect(log).toContain("SWARM_STALLED");
        expect(log).toContain("M1");
        expect(log).toContain("15 tool calls");
        expect(log).toContain("gate stays in SWARM");

        // Diagnostics are file-only — no stderr emission bleeds into the prompt.
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });
  });

  describe("issue-46: verdict freshness and fix-cycle regression (P012/P013)", () => {
    it("a: FAIL regresses after a prior same-KD regression when a fix cycle landed", async () => {
      const s = sid("i46a");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`impl-M1-v1-${s}.md`);
      const reviewName = `review-fail-${s}.md`;
      createKD(reviewName, reviewKD("FAIL", "impl-M1 defect"));

      // First evaluation regresses VERIFY→SWARM and records the guard.
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      const firstGuard = hooks.verdictRegressedKDs.get(s);
      expect(firstGuard.kdFilename).toBe(reviewName);

      // Re-advance to VERIFY. A fix cycle lands AFTER regressedAt.
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      createKD(`impl-M1-v2-${s}.md`);
      utimesSync(join(knowledgeDir, `impl-M1-v2-${s}.md`), new Date(), new Date(Date.now() + 5000));

      // The same FAIL KD regresses again — the landed fix cycle makes the
      // stale FAIL verdict current once more.
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c2" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(hooks.verdictRegressedKDs.get(s).regressedAt).toBeGreaterThan(firstGuard.regressedAt);
    });

    it("b: a stale PASS verdict KD does not advance VERIFY; a fresh PASS advances", async () => {
      const s = sid("i46b");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"]]);
      // The review lands BEFORE the fix: the PASS is stale relative to the
      // newest impl KD (a fix cycle landed after the review).
      const reviewName = `review-pass-${s}.md`;
      createKD(reviewName, reviewKD("PASS"));
      createKD(`impl-M1-after-${s}.md`);
      utimesSync(join(knowledgeDir, `impl-M1-after-${s}.md`), new Date(), new Date(Date.now() + 5000));

      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY); // stale PASS blocked

      // A fresh review (newer than the newest impl KD) advances.
      utimesSync(join(knowledgeDir, reviewName), new Date(), new Date(Date.now() + 10000));
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c2" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXTRACT);
    });

    it("c: a MISSING verdict is blocked (never treated as PASS)", async () => {
      const s = sid("i46c");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createKD(`review-noverdict-${s}.md`, "test content");
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      expect(hooks.verdictRegressedKDs.has(s)).toBe(false);
    });

    it("d: /phase forward advance is blocked while the newest verdict is FAIL", async () => {
      const s = sid("i46d");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "in-progress"]]);
      // Pin the override at VERIFY, then a FRESH FAIL review lands after the
      // override's since marker.
      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "VERIFY" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "impl-M1 defect"));

      // No forward advance while the newest verdict is FAIL — the override
      // evaluates the verdict after freshness, and the FAIL regresses to SWARM.
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    });
  });

  describe("issue-49: scoped milestone reopen + malformed-FAIL (P014/P015)", () => {
    // Parses the registry's machine-readable YAML block back into row states.
    function regressedRegistryRows(s) {
      const content = readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
      const rows = {};
      const re = /^\s*([A-Za-z0-9_-]+):\s*([A-Za-z-]+)\s*$/gm;
      let m;
      while ((m = re.exec(content)) !== null) rows[m[1]] = m[2];
      return rows;
    }

    it("a: single-milestone FAIL reopens only the cited row", async () => {
      const s = sid("i49a");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"], ["M3", "checked-off"]]);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "impl-M2-resume-hint is broken"));
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      const rows = regressedRegistryRows(s);
      expect(rows.M2).toBe("in-progress");
      expect(rows.M1).toBe("checked-off");
      expect(rows.M3).toBe("checked-off");
    });

    it("b: multi-milestone FAIL reopens only the cited rows", async () => {
      const s = sid("i49b");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"], ["M3", "checked-off"], ["M4", "checked-off"]]);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "M2 and M3 fail: impl-M2-resume-hint, impl-M3-promotion"));
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      const rows = regressedRegistryRows(s);
      expect(rows.M2).toBe("in-progress");
      expect(rows.M3).toBe("in-progress");
      expect(rows.M1).toBe("checked-off");
      expect(rows.M4).toBe("checked-off");
    });

    it("c: unprovenanced FAIL is MALFORMED — no regress, no reopen, no advance", async () => {
      const s = sid("i49c");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"]]);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "no milestone tokens here"));
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c1" },
          { args: { pattern: "knowledge/*.md" } }
        );
        // Blocked in VERIFY: no regression, no reopen, no forward advance.
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
        expect(hooks.verdictRegressedKDs.has(s)).toBe(false);
        const rows = regressedRegistryRows(s);
        expect(rows.M1).toBe("checked-off");
        expect(rows.M2).toBe("checked-off");
        expect(readFileSync(logPath, "utf8")).toContain("MALFORMED_FAIL");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("a citation-driven reopen names the citing review KD in a loud diagnostic", async () => {
      const s = sid("i49-reopen-diag");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "impl-M1-short-term-store has a defect"));

      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c1" },
          { args: { pattern: "knowledge/*.md" } }
        );
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("REOPEN:");
        expect(log).toContain("M1");
        expect(log).toContain(`review-fail-${s}.md`);
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
      expect(regressedRegistryRows(s).M1).toBe("in-progress");
    });

    it("d: unrelated checked-off rows stay checked-off across repeated FAIL evaluations", async () => {
      const s = sid("i49d");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"]]);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "impl-M1 defect"));
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      let rows = regressedRegistryRows(s);
      expect(rows.M1).toBe("in-progress");
      expect(rows.M2).toBe("checked-off");

      // A fix cycle lands and the same FAIL KD re-evaluates (regresses again
      // per P013) — still only the cited row re-opens.
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      createKD(`impl-M1-fix-${s}.md`);
      utimesSync(join(knowledgeDir, `impl-M1-fix-${s}.md`), new Date(), new Date(Date.now() + 5000));
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c2" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      rows = regressedRegistryRows(s);
      expect(rows.M1).toBe("in-progress"); // still only the cited row
      expect(rows.M2).toBe("checked-off");
    });

    describe("template-conformant Review Findings header regression", () => {
      // The citation parser previously matched only the legacy `## Findings`
      // header while the merged template and inspector mandate
      // `## Review Findings` — a template-conformant FAIL review parsed as
      // zero citations → MALFORMED → no regression, no reopen. The reviewKD()
      // fixture above now uses the canonical header (all FAIL tests are
      // implicit regressions); these tests pin the parser contract explicitly,
      // both for the canonical and the legacy header.

      it("the citation parser accepts the template-conformant `## Review Findings` header", async () => {
        const s = sid("f001-parser-canonical");
        await initOverseer(s);
        // Template-shaped body — Verdict → Review Findings → Audit section
        // order (skills/template-review/SKILL.md:22/43/64) — with both citation
        // token shapes the scoped-reopen rule parses (M\d+ and impl-<id>-).
        const content = `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: FAIL
---

# REVIEW: test

## Verdict

FAIL

## Review Findings

### F001: defect

- **Milestone citation**: M2 and impl-M3-promotion

## Audit

### Scope

audited
`;
        const citations = hooks.extractMilestoneCitationsFromReviewKD(content);
        expect(citations).toEqual(expect.arrayContaining(["M2", "M3"]));
      });

      it("the citation parser keeps accepting the legacy `## Findings` header (backward compat)", async () => {
        const s = sid("f001-parser-legacy");
        await initOverseer(s);
        const content = `## Findings

impl-M1-short-term-store is broken and M2 too
`;
        const citations = hooks.extractMilestoneCitationsFromReviewKD(content);
        expect(citations).toEqual(expect.arrayContaining(["M1", "M2"]));
      });

      it("a template-conformant merged FAIL review (Review Findings + Audit sections) regresses and reopens exactly the cited rows", async () => {
        const s = sid("f001-gate-template");
        await initOverseer(s);
        hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
        hooks.sessionPhaseMap.set(`${s}:sid`, s);
        createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"], ["M3", "checked-off"]]);
        // Full template shape: the traceability matrix lives INSIDE Review
        // Findings (template SKILL.md:57-62) and the Audit section follows —
        // the section slicing must stop at `## Audit` and still cite M2.
        createKD(
          `review-fail-${s}.md`,
          `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: FAIL
---

# REVIEW: test

## Verdict

FAIL

## Review Findings

### F001: defect

- **Milestone citation**: M2

### Traceability Matrix

| Req ID | Plan Step | Artifact | Test/Check | Status |
| ------ | --------- | -------- | ---------- | ------ |
| R001   | P001      | x        | test       | PASS   |

## Audit

### Scope

audited
`
        );
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c1" },
          { args: { pattern: "knowledge/*.md" } }
        );
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
        const rows = regressedRegistryRows(s);
        expect(rows.M2).toBe("in-progress");
        expect(rows.M1).toBe("checked-off");
        expect(rows.M3).toBe("checked-off");
      });

      it("gate-level backward compat: a legacy `## Findings` FAIL review still regresses and reopens cited rows", async () => {
        const s = sid("f001-gate-legacy");
        await initOverseer(s);
        hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
        hooks.sessionPhaseMap.set(`${s}:sid`, s);
        createRegistry(s, [["M1", "checked-off"]]);
        createKD(
          `review-fail-${s}.md`,
          `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: FAIL
---

# REVIEW: test

## Verdict

FAIL

## Findings

impl-M1-short-term-store has a defect
`
        );
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c1" },
          { args: { pattern: "knowledge/*.md" } }
        );
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
        expect(regressedRegistryRows(s).M1).toBe("in-progress");
      });

      it("the citation parser ignores milestone tokens inside the Traceability Matrix (PASS-row provenance is not a FAIL citation)", async () => {
        const s = sid("f001-matrix-guard");
        await initOverseer(s);
        // Template shape (skills/template-review/SKILL.md:57-62): the matrix
        // sits INSIDE Review Findings and its PASS-row Artifact cells carry
        // milestone tokens — those are provenance, not FAIL citations, and
        // must not enter the reopen set.
        const content = `## Review Findings

### F001: defect

- **Milestone citation**: M2

### Traceability Matrix

| Req ID | Plan Step | Artifact                 | Test/Check | Status |
| ------ | --------- | ------------------------ | ---------- | ------ |
| R001   | P001      | impl-M1-short-term-store | test       | PASS   |

## Audit

### Scope

audited
`;
        const citations = hooks.extractMilestoneCitationsFromReviewKD(content);
        expect(citations).toEqual(["M2"]);
      });

      it("a FAIL review with milestone tokens in PASS-row matrix cells reopens only the cited row", async () => {
        const s = sid("f001-gate-matrix-guard");
        await initOverseer(s);
        hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
        hooks.sessionPhaseMap.set(`${s}:sid`, s);
        createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"], ["M3", "checked-off"]]);
        createKD(
          `review-fail-${s}.md`,
          `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: FAIL
---

# REVIEW: test

## Verdict

FAIL

## Review Findings

### F001: defect

- **Milestone citation**: M2

### Traceability Matrix

| Req ID | Plan Step | Artifact                 | Test/Check | Status |
| ------ | --------- | ------------------------ | ---------- | ------ |
| R001   | P001      | impl-M1-short-term-store | test       | PASS   |
| R002   | P001      | impl-M3-promotion        | test       | PASS   |

## Audit

### Scope

audited
`
        );
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c1" },
          { args: { pattern: "knowledge/*.md" } }
        );
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
        const rows = regressedRegistryRows(s);
        expect(rows.M2).toBe("in-progress");
        expect(rows.M1).toBe("checked-off");
        expect(rows.M3).toBe("checked-off");
      });
    });

    it("the citation scan covers the whole review KD — a Verdict-only citation yields the token, matrix tokens stay excluded", () => {
      const s = sid("f001-scan-whole-kd");
      const content = `---
title: "REVIEW: test"
verdict: FAIL
---

# REVIEW: test

## Verdict

FAIL — milestone M2 regressed after the fix cycle

## Review Findings

### F001: defect

The deficient milestone is named in the Verdict section above.

### Traceability Matrix

| Req ID | Plan Step | Artifact          | Test/Check | Status |
| ------ | --------- | ----------------- | ---------- | ------ |
| R001   | P001      | impl-M9-unrelated | test       | PASS   |

## Audit

### Scope

the audit re-run flagged milestone M2
`;
      const citations = hooks.extractMilestoneCitationsFromReviewKD(content);
      expect(citations).toEqual(["M2"]);
    });

    it("a FAIL review citing M2 only in its Verdict section reopens M2", async () => {
      const s = sid("f001-verdict-cite");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"]]);
      createKD(
        `review-fail-${s}.md`,
        `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: FAIL
---

# REVIEW: test

## Verdict

FAIL — milestone M2 shipped with a defect

## Review Findings

### F001: defect

The deficient milestone is named in the Verdict section above.
`
      );
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      const rows = regressedRegistryRows(s);
      expect(rows.M2).toBe("in-progress");
      expect(rows.M1).toBe("checked-off");
    });

    it("a FAIL review citing M2 only in its Audit section reopens M2", async () => {
      const s = sid("f001-audit-cite");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"]]);
      createKD(
        `review-fail-${s}.md`,
        `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: FAIL
---

# REVIEW: test

## Verdict

FAIL

## Review Findings

### F001: defect

The defect details live in the Audit section below.

## Audit

### Scope

impl-M2-resume-hint regressed during the audit re-run
`
      );
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      const rows = regressedRegistryRows(s);
      expect(rows.M2).toBe("in-progress");
      expect(rows.M1).toBe("checked-off");
    });

    it("a FAIL review whose only milestone tokens sit inside the Traceability Matrix fails closed as MALFORMED_FAIL", async () => {
      const s = sid("f001-matrix-only-malformed");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"]]);
      createKD(
        `review-fail-${s}.md`,
        `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: FAIL
---

# REVIEW: test

## Verdict

FAIL

## Review Findings

### F001: defect

The failing surface is described without milestone tokens.

### Traceability Matrix

| Req ID | Plan Step | Artifact                 | Test/Check | Status |
| ------ | --------- | ------------------------ | ---------- | ------ |
| R001   | P001      | impl-M2-resume-hint      | test       | PASS   |
`
      );
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: "c1" },
          { args: { pattern: "knowledge/*.md" } }
        );
        // Fail closed: blocked in VERIFY, zero regression, zero reopen.
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
        expect(hooks.verdictRegressedKDs.has(s)).toBe(false);
        const rows = regressedRegistryRows(s);
        expect(rows.M1).toBe("checked-off");
        expect(rows.M2).toBe("checked-off");
        expect(readFileSync(logPath, "utf8")).toContain("MALFORMED_FAIL");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });
  });

  describe("merged-KD advancement/regression asymmetry (P011/P016)", () => {
    it("a single review KD advances on fresh PASS (no audit KD required)", async () => {
      const s = sid("merged-advance");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createKD(`review-pass-${s}.md`, reviewKD("PASS"));
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXTRACT);
    });

    it("regression side stays OR — a single review KD holds VERIFY without an unbounded VERIFY⇄SWARM loop", async () => {
      const s = sid("merged-hold");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      // A MISSING-verdict review blocks advancement (P012) but must NOT
      // consistency-regress to SWARM — the regression-side OR holds the phase.
      createKD(`review-noverdict-${s}.md`, "test content");
      for (let i = 1; i <= 5; i++) {
        await hooks["tool.execute.before"](
          { tool: "glob", sessionID: s, callID: `c${i}` },
          { args: { pattern: "knowledge/*.md" } }
        );
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      }
    });
  });

  describe("SWARM→VERIFY observability", () => {
    // Drives a SWARM→VERIFY disk advancement for a session with all milestones
    // checked-off (registry rows + milestone-scoped impl KDs on disk).
    async function advanceSwarmToVerify(s) {
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      createRegistry(s, [["M1", "checked-off"], ["M2", "checked-off"], ["M3", "checked-off"]]);
      createKD(`impl-M1-feature-${s}.md`);
      createKD(`impl-M2-feature-${s}.md`);
      createKD(`impl-M3-feature-${s}.md`);
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: s, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
    }

    it("the advancement site emits an explicit log line with the transition and SWARM gate evidence", async () => {
      try { rmSync(logPath); } catch (_) {}
      process.env.PROTOCOL_GATE_DEBUG = "1";
      try {
        const s = sid("m4-log-401");
        await advanceSwarmToVerify(s);
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("Disk advancement: SWARM → VERIFY (all milestones checked-off: 3/3)");
      } finally {
        delete process.env.PROTOCOL_GATE_DEBUG;
        try { rmSync(logPath); } catch (_) {}
      }
    });

    it("the first systemTransform after advancement injects the phase-transition announcement", async () => {
      const s = sid("m4-ann-402");
      await advanceSwarmToVerify(s);

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, output);
      const system = output.system.join("\n");
      expect(system).toContain("[Protocol Gate]");
      expect(system).toContain("Phase auto-advanced");
      expect(system).toContain("SWARM → VERIFY");
      expect(system).toContain("all milestones checked-off: 3/3");
      // One-shot consumption — the recorded entry is deleted in the same transform
      expect(hooks.advancementAnnouncements.has(s)).toBe(false);
    });

    it("the announcement is one-shot — never repeats across a second transform without a new advancement", async () => {
      const s = sid("m4-ann-403");
      await advanceSwarmToVerify(s);

      const first = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, first);
      expect(first.system.join("\n")).toContain("Phase auto-advanced");

      const second = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, second);
      expect(second.system.join("\n")).not.toContain("Phase auto-advanced");

      const all = [...first.system, ...second.system].join("\n");
      const occurrences = all.split("[Protocol Gate] Phase auto-advanced:").length - 1;
      expect(occurrences).toBe(1);
    });

    it("no announcement is emitted for non-overseer sessions", async () => {
      const artisan = sid("m4-ann-405");
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      // Defense in depth: even a manually-seeded entry must never surface for a
      // non-overseer session (systemTransform early-returns before reading it).
      hooks.advancementAnnouncements.set(artisan, { from: "SWARM", to: "VERIFY", reason: "all milestones checked-off: 1/1" });

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, output);
      expect(output.system.join("\n")).not.toContain("Phase auto-advanced");
    });
  });

  describe("stale advancement announcement cleared on /phase override and backward transition", () => {
    // Drives EXPLORE → INVESTIGATE through the real disk-advancement path so
    // the one-shot announcement is set by the gate itself, not seeded.
    async function advanceExploreToInvestigate(s) {
      await initOverseer(s);
      await todo(s, "c1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
      createKD(`intent-a-${s}.md`);
      await todo(s, "c2");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
      createKD(`preflight-a-${s}.md`);
      await todo(s, "c3"); // PREFLIGHT skip consumed
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
      await todo(s, "c4");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
      createKD(`exploration-a-${s}.md`);
      await todo(s, "c5");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INVESTIGATE);
      expect(hooks.advancementAnnouncements.has(s)).toBe(true);
    }

    it("/phase deletes the pending announcement for every valid invocation", async () => {
      const s = sid("f1-ac001");
      await advanceExploreToInvestigate(s);

      const output = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "EXPLORE" }, output);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
      expect(hooks.advancementAnnouncements.has(s)).toBe(false);
    });

    it("after /phase, the next systemTransform carries no stale auto-advanced announcement", async () => {
      const s = sid("f1-ac002");
      await advanceExploreToInvestigate(s);

      const phaseOut = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "EXPLORE" }, phaseOut);

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, output);
      expect(output.system.join("\n")).not.toContain("Phase auto-advanced");
    });

    it("a backward transition deletes the pending announcement", async () => {
      const s = sid("f1-ac003");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      // Seeded directly — no /phase in this test, so only the backward
      // transition (task dispatch with BACKWARD: true → handleBackwardTransition)
      // can clear the announcement.
      hooks.advancementAnnouncements.set(s, { from: "SWARM", to: "VERIFY", reason: "all milestones checked-off: 1/1" });

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "b1" },
        { args: { prompt: "DISPATCH TO: artisan\nBACKWARD: true\nSCOPE: fix something", subagent_type: "artisan" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(hooks.advancementAnnouncements.has(s)).toBe(false);
    });

    it("the one-shot announcement still fires exactly once with no intervening override", async () => {
      const s = sid("f1-ac004");
      await advanceExploreToInvestigate(s);

      const first = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, first);
      expect(first.system.join("\n")).toContain("Phase auto-advanced: EXPLORE → INVESTIGATE");
      expect(hooks.advancementAnnouncements.has(s)).toBe(false);

      const second = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, second);
      expect(second.system.join("\n")).not.toContain("Phase auto-advanced");

      const all = [...first.system, ...second.system].join("\n");
      const occurrences = all.split("[Protocol Gate] Phase auto-advanced:").length - 1;
      expect(occurrences).toBe(1);
    });
  });

  it("GENERATION falls back to the protocol-gate state file when the prompt omits GENERATION", async () => {
    // The delegation-gate GENERATION fallback reads PROTOCOL_GATE_STATE_DIR at
    // call time — this suite's temp stateDir is that dir, so the real
    // plugins/protocol-gate/.state is never touched and the two suites cannot
    // race on it.
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

    // The debug writes from this cross-plugin invocation (DELEGATION_GATE_DEBUG
    // is asserted in beforeAll) must land in the suite's temp log dir — never in
    // plugins/logs/delegation-gate.log. If the temp log exists, the redirect held.
    expect(existsSync(join(delegationLogDir, "delegation-gate.log"))).toBe(true);

    expect(output.args.prompt).toContain("GENERATION: 4");
    expect(output.args.prompt).toContain("knowledge/impl-<milestone-id>-<descriptive-name>-<session_id>-gen4.md");
    expect(output.args.description).toContain("knowledge/impl-<milestone-id>-<name>-<session_id>-gen4.md");
  });

  describe("sticky /phase override", () => {
    // Ages a KD so its mtime predates a subsequent /phase override — stale
    // evidence must never satisfy the override freshness contract (mtime >= since).
    // utimesSync treats numeric timestamps as SECONDS since epoch, so Date
    // objects are required for millisecond-precision backdating (EINVAL-adjacent
    // far-future mtimes would otherwise make every KD look fresh).
    function ageKD(filename, msBack = 10000) {
      const when = new Date(Date.now() - msBack);
      utimesSync(join(knowledgeDir, filename), when, when);
    }

    it("a pre-existing same-session preflight KD does not advance a /phase PREFLIGHT override", async () => {
      const s = sid("ac006-override");
      await initOverseer(s);
      // Pre-existing preflight + exploration KDs (same session, gen 0) — the
      // exact stale-evidence scenario that used to undo the override.
      createKD(`preflight-old-${s}.md`);
      createKD(`exploration-old-${s}.md`);
      ageKD(`preflight-old-${s}.md`);
      ageKD(`exploration-old-${s}.md`);

      // At INVESTIGATE (4), override to PREFLIGHT (2).
      hooks.sessionPhaseMap.set(s, hooks.STATES.INVESTIGATE);
      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "PREFLIGHT" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
      const marker = hooks.sessionPhaseMap.get(`${s}:overrideUntil`);
      expect(marker.phase).toBe(hooks.STATES.PREFLIGHT);
      expect(typeof marker.since).toBe("number");
      // The marker is persisted in the state file.
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).overrideUntil).toEqual({ phase: hooks.STATES.PREFLIGHT, since: marker.since });

      // The next disk-check cycle must NOT advance — the preflight KD predates
      // the override and is not fresh evidence.
      await todo(s, "o1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
    });

    it("a fresh post-override KD advances and clears the marker; pre-existing later-phase KDs then advance normally", async () => {
      const s = sid("ac007-override");
      await initOverseer(s);
      createKD(`preflight-old-${s}.md`);
      createKD(`exploration-old-${s}.md`);
      ageKD(`preflight-old-${s}.md`);
      ageKD(`exploration-old-${s}.md`);

      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "PREFLIGHT" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
      await todo(s, "o1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);

      // A NEW preflight KD (mtime >= since) advances PREFLIGHT → EXPLORE and
      // clears the override marker (advance-away).
      createKD(`preflight-fresh-${s}.md`);
      await todo(s, "o2");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).overrideUntil).toBeUndefined();

      // The pre-existing exploration KD (written before the override) now
      // advances EXPLORE → INVESTIGATE normally — disk-evidence semantics
      // resume once the marker clears.
      await todo(s, "o3");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INVESTIGATE);
    });

    it("/phase EXPLORE from INTENT holds EXPLORE until a matching exploration KD is written", async () => {
      const s = sid("ac008-override");
      await initOverseer(s);
      await todo(s, "k1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "EXPLORE" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
      expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`).phase).toBe(hooks.STATES.EXPLORE);

      // No exploration KD exists — the gate must not advance earlier.
      await todo(s, "k2");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);

      // A matching exploration KD for the current session advances and clears.
      createKD(`exploration-override-${s}.md`);
      await todo(s, "k3");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INVESTIGATE);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
    });

    it("consistency never regresses the phase while the override is active", async () => {
      const s = sid("ac009-override");
      await initOverseer(s);
      // Earlier-lifecycle evidence (spec KD at ALIGN=5) so a regression WOULD
      // fire without the override — the walk-back matches phase-5 evidence.
      createKD(`spec-evidence-${s}.md`);
      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "SWARM" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);

      // With the override active at SWARM, a missing impl KD logs but never
      // regresses.
      const regressed = hooks.checkPhaseStateConsistency(
        s, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        hooks.saveState, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );
      expect(regressed).toBe(false);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);

      // Control: WITHOUT the override the same scan regresses to ALIGN —
      // proving the override is what prevents regression.
      hooks.sessionPhaseMap.delete(`${s}:overrideUntil`);
      const regressedWithout = hooks.checkPhaseStateConsistency(
        s, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        hooks.saveState, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );
      expect(regressedWithout).toBe(true);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.ALIGN);
    });

    it("the override marker survives a mid-session restart and honors fresh evidence", async () => {
      const s = sid("ac010b-override");
      await initOverseer(s);
      createKD(`exploration-old-${s}.md`);
      ageKD(`exploration-old-${s}.md`);

      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "EXPLORE" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
      const marker = hooks.sessionPhaseMap.get(`${s}:overrideUntil`);

      // Simulated mid-session restart: a fresh plugin instance restores the
      // phase AND the marker from the state file (reconcile restore).
      hooks = await pluginModule.server({}, {});
      await initOverseer(s);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
      expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`)).toEqual({ phase: hooks.STATES.EXPLORE, since: marker.since });

      // The aged exploration KD still cannot advance the restored override.
      await todo(s, "r1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);

      // A fresh exploration KD advances and clears the restored marker.
      createKD(`exploration-fresh-${s}.md`);
      await todo(s, "r2");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INVESTIGATE);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
    });

    it("a /phase DECOMPOSE override requires BOTH fresh plan and fresh milestones KDs", async () => {
      const s = sid("override-decompose");
      await initOverseer(s);
      createKD(`plan-old-${s}.md`);
      createKD(`milestones-old-${s}.md`, registryContent([["M1", "checked-off"]]));
      ageKD(`plan-old-${s}.md`);
      ageKD(`milestones-old-${s}.md`);

      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "DECOMPOSE" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.DECOMPOSE);

      // Both KDs pre-exist but are stale — no advancement under the override.
      await todo(s, "d1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.DECOMPOSE);

      // A fresh plan alone still does not satisfy the dual-KD gate.
      createKD(`plan-fresh-${s}.md`);
      await todo(s, "d2");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.DECOMPOSE);

      // A fresh milestones KD completes the dual-KD gate → advance + clear.
      createKD(`milestones-fresh-${s}.md`, registryContent([["M1", "checked-off"]]));
      await todo(s, "d3");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
    });

    it("a /phase SWARM override requires a FRESH milestone registry as evidence", async () => {
      const s = sid("override-swarm");
      await initOverseer(s);
      // Registry with all milestones checked-off + matching impl KD would
      // normally advance — but the registry predates the override.
      createRegistry(s, [["M1", "checked-off"]]);
      createKD(`impl-M1-old-${s}.md`);
      ageKD(`milestones-feature-${s}.md`);

      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "SWARM" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);

      // The all-checked-off gate passes but the registry is stale → no advance.
      await todo(s, "sw1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);

      // A fresh registry write advances SWARM → VERIFY and clears the marker.
      createRegistry(s, [["M1", "checked-off"]]);
      await todo(s, "sw2");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
    });

    it("a /phase VERIFY override requires the NEWEST review KD to be fresh", async () => {
      const s = sid("override-verify");
      await initOverseer(s);
      createKD(`review-old-${s}.md`);
      ageKD(`review-old-${s}.md`);

      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "VERIFY" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);

      // The review KD is stale → the override holds VERIFY.
      await todo(s, "v1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);

      // A fresh PASS review KD advances + clears: the merged surface needs a
      // single fresh review KD (no separate audit KD).
      createKD(`review-fresh-${s}.md`, reviewKD("PASS"));
      await todo(s, "v2");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXTRACT);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
    });

    it("a new /phase invocation replaces the prior override marker", async () => {
      const s = sid("override-replace");
      await initOverseer(s);
      let out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "SWARM" }, out);
      expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`).phase).toBe(hooks.STATES.SWARM);
      const firstSince = hooks.sessionPhaseMap.get(`${s}:overrideUntil`).since;

      out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "EXPLORE" }, out);
      const marker = hooks.sessionPhaseMap.get(`${s}:overrideUntil`);
      expect(marker.phase).toBe(hooks.STATES.EXPLORE);
      expect(marker.since).toBeGreaterThanOrEqual(firstSince);
      const persisted = JSON.parse(readFileSync(statePath(s), "utf8"));
      expect(persisted.overrideUntil).toEqual({ phase: hooks.STATES.EXPLORE, since: marker.since });
    });

    it("a backward transition clears the override marker", async () => {
      const s = sid("override-backward");
      await initOverseer(s);
      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "VERIFY" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`).phase).toBe(hooks.STATES.VERIFY);

      // VERIFY → SWARM via an artisan dispatch with BACKWARD: true.
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "b1" },
        { args: { prompt: "DISPATCH TO: artisan\nBACKWARD: true\nSCOPE: fix something", subagent_type: "artisan" } }
      );
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).overrideUntil).toBeUndefined();
    });

    it("the REPORT lifecycle-end reset clears the override marker", async () => {
      const s = sid("override-report");
      await initOverseer(s);
      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "REPORT" }, out);
      expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`).phase).toBe(hooks.STATES.REPORT);

      await hooks["tool.execute.before"](
        { tool: "write", sessionID: s, callID: "r1" },
        { args: { filePath: `knowledge/report-override-${s}.md`, content: "report" } }
      );
      expect(hooks.sessionPhaseMap.has(s)).toBe(false);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
      const persisted = JSON.parse(readFileSync(statePath(s), "utf8"));
      expect(persisted.overrideUntil).toBeUndefined();
    });
  });

  describe("/phase INTENT no longer traps the session", () => {
    // Ages a KD so its mtime predates the /phase marker — stale evidence under
    // the fresh-evidence rule. 60s of backdating dwarfs the millisecond
    // gap between the marker's `since` and this call, so the KD is always stale.
    function ageKD(filename, msBack = 60000) {
      const when = new Date(Date.now() - msBack);
      utimesSync(join(knowledgeDir, filename), when, when);
    }

    it("a stale-mtime corrected intent KD advances a /phase INTENT override and clears the marker", async () => {
      const s = sid("f2-ac005");
      await initOverseer(s);
      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "INTENT" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
      const marker = hooks.sessionPhaseMap.get(`${s}:overrideUntil`);
      expect(marker.phase).toBe(hooks.STATES.INTENT);

      // The user corrected the intent KD BEFORE the override — its mtime is
      // below `since`, which used to hold INTENT forever.
      createKD(`intent-corrected-${s}.md`);
      ageKD(`intent-corrected-${s}.md`);

      // Presence of the session-matching intent KD advances INTENT → PREFLIGHT
      // on the next disk-check tool call, regardless of mtime.
      await todo(s, "f2-1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.PREFLIGHT);
      expect(hooks.sessionPhaseMap.has(`${s}:overrideUntil`)).toBe(false);
      expect(JSON.parse(readFileSync(statePath(s), "utf8")).overrideUntil).toBeUndefined();
    });

    it("/phase INTENT with no intent KD present does not advance on disk-check calls", async () => {
      const s = sid("f2-ac006");
      await initOverseer(s);
      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "INTENT" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

      await todo(s, "f2-1");
      await todo(s, "f2-2");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);
      expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`).phase).toBe(hooks.STATES.INTENT);
    });

    it("the exemption is INTENT-only — a stale exploration KD still holds a /phase EXPLORE override", async () => {
      const s = sid("f2-ac007");
      await initOverseer(s);
      createKD(`exploration-stale-${s}.md`);
      ageKD(`exploration-stale-${s}.md`);

      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "EXPLORE" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);

      await todo(s, "f2-1");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
      expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`).phase).toBe(hooks.STATES.EXPLORE);
    });

    it("edit is in the INTENT allowlist — permissionAsk allows it and toolExecuteBefore does not block it", async () => {
      const s = sid("f2-ac008");
      await initOverseer(s);

      const pluginSrc = readFileSync(join(process.cwd(), "plugins", "protocol-gate", "index.js"), "utf8");
      const allowlistLine = pluginSrc.split("\n").find(line => line.includes('INTENT: ["todowrite"'));
      expect(allowlistLine).toContain('"edit"');

      const out = { parts: [] };
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "INTENT" }, out);
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INTENT);

      const permOutput = {};
      await hooks["permission.ask"]({ sessionID: s, type: "edit" }, permOutput);
      expect(permOutput.status).not.toBe("deny");

      await expect(
        hooks["tool.execute.before"](
          { tool: "edit", sessionID: s, callID: "e1" },
          { args: { filePath: `knowledge/intent-feature-${s}.md` } }
        )
      ).resolves.toBeUndefined();
    });

    it("toolDefinition for edit in INTENT carries the scoped restriction text", async () => {
      const s = sid("f2-ac009");
      await initOverseer(s);
      await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "INTENT" }, { parts: [] });
      // toolDefinition reads lastSeenSession — set it with a real tool call.
      await hooks["tool.execute.before"](
        { tool: "edit", sessionID: s, callID: "e1" },
        { args: { filePath: `knowledge/intent-feature-${s}.md` } }
      );

      const output = { description: "Edit a file", parameters: {} };
      await hooks["tool.definition"]({ toolID: "edit" }, output);
      expect(output.description).toContain("[INTENT phase restriction:");
      expect(output.description).toContain("ONLY knowledge/intent-*.md");
      expect(output.description).not.toContain("⛔");
    });

    it("commands/phase.md documents overrideUntil, the INTENT exemption, the recovery path, and edit-in-place", async () => {
      const template = readFileSync(join(process.cwd(), "commands", "phase.md"), "utf8");
      // (a) overrideUntil marker semantics + fresh-evidence rule
      expect(template).toContain("overrideUntil");
      expect(template.toLowerCase()).toContain("fresh");
      // (b) INTENT exemption — presence advances, freshness ignored
      expect(template).toContain("INTENT override exemption");
      expect(template).toContain("regardless of its mtime");
      // (c) recovery path — /phase PREFLIGHT and the general escape hatch
      expect(template).toContain("/phase PREFLIGHT");
      // (d) edit-in-place of the corrected intent KD
      expect(template).toContain("`edit`");
      expect(template).toContain("knowledge/intent-*.md");
    });
  });

  describe("verbatim raw-intent capture at plugin level", () => {
    it("chat.message captures overseer text parts verbatim with no transformation", async () => {
      const s = sid("f4-ac012");
      await hooks["chat.message"](
        { sessionID: s, agent: "overseer", messageID: "m1" },
        { message: {}, parts: [{ type: "text", text: "Raw request text" }] }
      );
      expect(hooks.rawIntentCapture.get(s)).toEqual([{ messageID: "m1", text: "Raw request text" }]);
    });

    it("chat.message with only non-text parts adds no capture entry", async () => {
      const s = sid("f4-ac013");
      await hooks["chat.message"](
        { sessionID: s, agent: "overseer", messageID: "m1" },
        { message: {}, parts: [{ type: "file", file: { path: "/tmp/x" } }, { type: "agent", agent: "tool" }] }
      );
      expect(hooks.rawIntentCapture.has(s)).toBe(false);
    });

    it("chat.message with a subagent agent adds no capture entry", async () => {
      const s = sid("f4-ac014");
      await hooks["chat.message"](
        { sessionID: s, agent: "artisan", messageID: "m1" },
        { message: {}, parts: [{ type: "text", text: "subagent text must not leak" }] }
      );
      expect(hooks.rawIntentCapture.has(s)).toBe(false);
    });

    it("INTENT-phase systemTransform injects the verbatim text and the copy-exactly directive", async () => {
      const s = sid("f4-ac015");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
      await hooks["chat.message"](
        { sessionID: s, agent: "overseer", messageID: "m1" },
        { message: {}, parts: [{ type: "text", text: "Raw request text" }] }
      );

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, output);
      const system = output.system.join("\n");
      expect(system).toContain("[Protocol Gate] Raw user request (verbatim)");
      expect(system).toContain("copy exactly");
      expect(system).toContain("Do not paraphrase or summarize");
      expect(system).toContain("Raw request text");
      expect(system).toContain("Message 1:");
    });

    it("a non-INTENT phase carries no raw-intent injection for the same session", async () => {
      const s = sid("f4-ac016");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.EXPLORE);
      await hooks["chat.message"](
        { sessionID: s, agent: "overseer", messageID: "m1" },
        { message: {}, parts: [{ type: "text", text: "Raw request text" }] }
      );

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, output);
      const system = output.system.join("\n");
      expect(system).not.toContain("Raw user request (verbatim)");
      expect(system).not.toContain("copy exactly");
      expect(system).not.toContain("Raw request text");
    });

    it("chat.message + systemTransform perform no writes to the knowledge dir", async () => {
      const s = sid("f4-ac017");
      await initOverseer(s);
      hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
      await hooks["chat.message"](
        { sessionID: s, agent: "overseer", messageID: "m1" },
        { message: {}, parts: [{ type: "text", text: "Raw request text" }] }
      );

      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({}, output);
      expect(output.system.join("\n")).toContain("Raw request text");
      // The capture/injection path alone creates nothing — no intent KD
      // auto-write, no other knowledge file.
      expect(readdirSync(knowledgeDir)).toEqual([]);
    });

    it("the per-session capture is bounded at RAW_INTENT_MAX_MESSAGES, dropping the oldest", async () => {
      const s = sid("f4-ac018");
      for (let i = 1; i <= 11; i++) {
        await hooks["chat.message"](
          { sessionID: s, agent: "overseer", messageID: `m${i}` },
          { message: {}, parts: [{ type: "text", text: `message ${i}` }] }
        );
      }
      const entries = hooks.rawIntentCapture.get(s);
      expect(entries.length).toBe(hooks.RAW_INTENT_MAX_MESSAGES);
      expect(entries[0]).toEqual({ messageID: "m2", text: "message 2" });
      expect(entries[entries.length - 1]).toEqual({ messageID: "m11", text: "message 11" });
    });
  });
});
