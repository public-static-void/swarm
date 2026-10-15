import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Identical-verdict brake: repeated identical gate verdicts on one milestone
// engage a brake that holds further /phase overrides until a diagnosis plus an
// escalation reference travels with the override. Self-contained: own temp
// dirs and fixtures, no dependence on live milestone state.
describe("identical-verdict brake", () => {
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
    tempRoot = mkdtempSync(join(tmpdir(), "pg-brake-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-brake-log-"));
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

  function logText() {
    try {
      return readFileSync(join(protocolLogDir, "protocol-gate.log"), "utf8");
    } catch (_) {
      return "";
    }
  }

  async function startSwarm(s) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    const out = { parts: [] };
    await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "SWARM" }, out);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
  }

  async function attemptOverride(s, args) {
    const output = { parts: [] };
    await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: args }, output);
    return output;
  }

  it("refuses the override at threshold and records the refusal", async () => {
    const s = "brake-refuse-1";
    await startSwarm(s);

    expect(hooks.recordGateVerdict(s, "M3", "FAIL:M3").count).toBe(1);
    expect(hooks.recordGateVerdict(s, "M3", "FAIL:M3").count).toBe(2);

    const output = await attemptOverride(s, "EXPLORE");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    expect(output.parts[0].text).toContain("BRAKE_ENGAGED");

    const log = logText();
    expect(log).toContain("BRAKE_ENGAGED");
    expect(log).toContain(`session=${s}`);
    expect(log).toContain("milestone=M3");
    expect(log).toContain("consecutiveCount=2");
  });

  it("a differing verdict restarts the count and permits override", async () => {
    const s = "brake-flap-2";
    await startSwarm(s);

    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    expect(hooks.recordGateVerdict(s, "M3", "FAIL:M3,M4").count).toBe(1);

    const output = await attemptOverride(s, "EXPLORE");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(output.parts[0].text).toContain("Phase set to EXPLORE");
  });

  it("an override carrying diagnosis and escalation references proceeds and logs the reference", async () => {
    const s = "brake-diagnosed-3";
    await startSwarm(s);

    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    hooks.recordGateVerdict(s, "M3", "FAIL:M3");

    const output = await attemptOverride(s, "EXPLORE diagnosis:skew-confirmed escalation:operator-note-7");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(output.parts[0].text).toContain("Phase set to EXPLORE");

    const log = logText();
    expect(log).toContain("diagnosis=skew-confirmed");
    expect(log).toContain("escalation=operator-note-7");

    // The diagnosed recovery clears the count: a later plain override succeeds.
    const back = await attemptOverride(s, "SWARM");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    expect(back.parts[0].text).toContain("Phase set to SWARM");
  });

  it("verdicts on distinct milestones never combine into a brake", async () => {
    const s = "brake-distinct-4";
    await startSwarm(s);

    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    hooks.recordGateVerdict(s, "M4", "FAIL:M4");

    const output = await attemptOverride(s, "EXPLORE");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(output.parts[0].text).toContain("Phase set to EXPLORE");
  });

  it("a single verdict leaves the ordinary override working", async () => {
    const s = "brake-single-5";
    await startSwarm(s);

    expect(hooks.recordGateVerdict(s, "M3", "FAIL:M3").count).toBe(1);

    const output = await attemptOverride(s, "EXPLORE");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(output.parts[0].text).toContain("Phase set to EXPLORE");
  });

  it("the engaged brake survives a process restart via the state file", async () => {
    const s = "brake-restart-6";
    await startSwarm(s);

    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    hooks.recordGateVerdict(s, "M3", "FAIL:M3");

    // Simulated restart with the same session ID: fresh module state, same
    // state dir — the file-backed count rehydrates and still holds.
    hooks = await pluginModule.server({}, {});
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);

    const output = await attemptOverride(s, "EXPLORE");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    expect(output.parts[0].text).toContain("BRAKE_ENGAGED");
  });

  it("a repeated FAIL regression advances the count through the gate path", async () => {
    const s = "brake-regress-7";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);

    const regressed = [];
    const first = hooks.regressVerifyOnFail(s, "review-first-gen0.md", [], hooks.sessionPhaseMap, ["M3"], hooks.verdictRegressedKDs, () => true);
    expect(first).toBe(true);
    regressed.push(hooks.getBrakeEntry(s, "M3"));
    const second = hooks.regressVerifyOnFail(s, "review-second-gen0.md", [], hooks.sessionPhaseMap, ["M3"], hooks.verdictRegressedKDs, () => true);
    expect(second).toBe(true);
    regressed.push(hooks.getBrakeEntry(s, "M3"));

    expect(regressed[0] && regressed[0].count).toBe(1);
    expect(regressed[1] && regressed[1].count).toBe(2);
    expect(hooks.findEngagedBrakes(s).map((e) => e.milestoneId)).toContain("M3");
  });
});
