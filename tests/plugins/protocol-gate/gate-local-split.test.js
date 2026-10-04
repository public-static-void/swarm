import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";
import * as kdMatch from "../../../plugins/protocol-gate/kd-match.js";
import * as fsAtomic from "../../../plugins/protocol-gate/fs-atomic.js";
import * as phases from "../../../plugins/protocol-gate/phases.js";

// Move-safety pin for the gate-local split: the three focused modules expose
// their symbols directly, and the gate entry re-exports every moved symbol by
// reference so existing hook and suite call sites resolve unchanged.
describe("Protocol-Gate gate-local split", () => {
  let tempRoot;
  let priorKnowledgeDir;
  let priorStateDir;
  let priorLogDir;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-split-"));
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = join(tempRoot, "knowledge");
    process.env.PROTOCOL_GATE_STATE_DIR = join(tempRoot, "state");
    process.env.PROTOCOL_GATE_LOG_DIR = join(tempRoot, "logs");
  });

  afterAll(() => {
    if (priorKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorKnowledgeDir;
    if (priorStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
    else process.env.PROTOCOL_GATE_STATE_DIR = priorStateDir;
    if (priorLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = priorLogDir;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("exposes every moved symbol from the gate-local modules", () => {
    for (const name of ["matchesSessionKD", "matchesSessionKDForSession", "matchesSessionKDAnyGeneration", "getKDLookupSIDs", "sanitizeSessionID", "escapeRegExp"]) {
      expect(typeof kdMatch[name], name).toBe("function");
    }
    expect(typeof fsAtomic.atomicWriteFileSync).toBe("function");
    for (const name of ["STATES", "PHASE_INSTRUCTIONS", "TOOL_ALLOWLIST", "TOOL_RESTRICTIONS"]) {
      expect(typeof phases[name], name).toBe("object");
    }
  });

  it("re-exports every moved symbol by reference from the gate entry", async () => {
    const hooks = await pluginModule.server({}, {});
    expect(hooks.matchesSessionKD).toBe(kdMatch.matchesSessionKD);
    expect(hooks.matchesSessionKDForSession).toBe(kdMatch.matchesSessionKDForSession);
    expect(hooks.matchesSessionKDAnyGeneration).toBe(kdMatch.matchesSessionKDAnyGeneration);
    expect(hooks.getKDLookupSIDs).toBe(kdMatch.getKDLookupSIDs);
    expect(hooks.sanitizeSessionID).toBe(kdMatch.sanitizeSessionID);
    expect(hooks.escapeRegExp).toBe(kdMatch.escapeRegExp);
    expect(hooks.atomicWriteFileSync).toBe(fsAtomic.atomicWriteFileSync);
    expect(hooks.STATES).toBe(phases.STATES);
    expect(hooks.PHASE_INSTRUCTIONS).toBe(phases.PHASE_INSTRUCTIONS);
    expect(hooks.TOOL_ALLOWLIST).toBe(phases.TOOL_ALLOWLIST);
    expect(hooks.TOOL_RESTRICTIONS).toBe(phases.TOOL_RESTRICTIONS);
  });

  it("keeps moved-symbol behavior identical through the gate entry", async () => {
    const hooks = await pluginModule.server({}, {});
    const s = "ses_split123";
    expect(hooks.matchesSessionKD(`impl-M4-x-${s}-gen0.md`, s, 0)).toBe(true);
    expect(hooks.matchesSessionKD(`impl-M4-x-${s}-gen1.md`, s, 0)).toBe(false);
    expect(hooks.matchesSessionKDAnyGeneration(`impl-M4-x-${s}-gen1.md`, s)).toBe(true);
    expect(hooks.matchesSessionKDForSession(`impl-M4-x-${s}-gen0.md`, hooks.sessionPhaseMap, s, 0)).toBe(true);
    expect(hooks.sanitizeSessionID("ses_123")).toBe("ses_123");
    expect(hooks.sanitizeSessionID("../evil")).toBeNull();
    expect(hooks.escapeRegExp("a.b")).toBe("a\\.b");
    expect(hooks.getKDLookupSIDs(hooks.sessionPhaseMap, s)).toEqual([s]);
    expect(hooks.STATES.INTENT).toBe(1);
    expect(hooks.PHASE_INSTRUCTIONS.INTENT).toContain("intent KD");
    expect(hooks.TOOL_ALLOWLIST.INTENT).toContain("write");
    expect(hooks.TOOL_RESTRICTIONS.SWARM.read).toContain("milestone registry");
  });

  it("uses no cross-gate imports in the new gate-local modules", () => {
    for (const file of ["kd-match.js", "fs-atomic.js", "phases.js"]) {
      const src = readFileSync(join(process.cwd(), "plugins", "protocol-gate", file), "utf8");
      expect(src).not.toContain("../");
    }
  });
});
