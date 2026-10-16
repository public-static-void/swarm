import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Phase-override advisory: repeated identical gate verdicts on one milestone
// are recorded as an advisory diagnosis, and the user's /phase override
// always proceeds to marker, history, and phase change. Self-contained: own
// temp dirs and fixtures, no dependence on live milestone state.
describe("phase-override advisory", () => {
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
    tempRoot = mkdtempSync(join(tmpdir(), "pg-advisory-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-advisory-log-"));
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

  it("lets a claim-free override through when repeated identical verdicts are recorded", async () => {
    const s = "advisory-plain-1";
    await startSwarm(s);

    expect(hooks.recordGateVerdict(s, "M3", "FAIL:M3").count).toBe(1);
    expect(hooks.recordGateVerdict(s, "M3", "FAIL:M3").count).toBe(2);

    const output = await attemptOverride(s, "EXPLORE");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(output.parts[0].text).toContain("Phase set to EXPLORE");
    expect(output.parts[0].text).not.toContain("override refused");
  });

  it("records the advisory diagnosis when the override carries diagnosis and escalation references", async () => {
    const s = "advisory-claims-2";
    await startSwarm(s);

    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    hooks.recordGateVerdict(s, "M3", "FAIL:M3");

    const output = await attemptOverride(s, "EXPLORE diagnosis:skew-confirmed escalation:operator-note-7");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(output.parts[0].text).toContain("Phase set to EXPLORE");

    const log = logText();
    expect(log).toContain("diagnosis=skew-confirmed");
    expect(log).toContain("escalation=operator-note-7");
    expect(log).toContain("milestone=M3");
    expect(log).toContain("consecutiveCount=2");
  });

  it("lets overrides with partial or malformed claims through", async () => {
    const s = "advisory-partial-3";
    await startSwarm(s);

    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    hooks.recordGateVerdict(s, "M3", "FAIL:M3");

    const output = await attemptOverride(s, "EXPLORE diagnosis:lone-claim");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(output.parts[0].text).toContain("Phase set to EXPLORE");
    expect(output.parts[0].text).not.toContain("override refused");
  });

  it("lets the override through when the file-backed store is absent", async () => {
    const s = "advisory-no-store-4";
    await startSwarm(s);

    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    rmSync(stateDir, { recursive: true, force: true });

    const output = await attemptOverride(s, "EXPLORE");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    expect(output.parts[0].text).toContain("Phase set to EXPLORE");
    expect(output.parts[0].text).not.toContain("override refused");
  });

  it("reports the engaged brake as allowed at the gate-check level", async () => {
    const s = "advisory-gate-5";
    await startSwarm(s);

    hooks.recordGateVerdict(s, "M3", "FAIL:M3");
    hooks.recordGateVerdict(s, "M3", "FAIL:M3");

    const result = hooks.evaluatePhaseOverrideBrake(s, "EXPLORE");
    expect(result.allowed).toBe(true);
    expect(result.engaged).toBe(true);
    expect(result.consecutiveCount).toBe(2);
  });
});
