import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Observability of the control gates: the dispatch refusal names the phase the
// lifecycle is actually in, and every walk mutation that exists today leaves an
// always-on record. Every assertion runs with PROTOCOL_GATE_DEBUG absent and
// the debug sentinel pointing at a path that does not exist.
describe("Protocol-Gate override walk observability", () => {
  let tempRoot;
  let knowledgeDir;
  let stateDir;
  let protocolLogDir;
  let logPath;
  let debugSentinel;
  let priorKnowledgeDir;
  let priorStateDir;
  let priorLogDir;
  let priorDebugFile;
  let priorDebug;
  let hooks;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-walk-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebugFile = process.env.PROTOCOL_GATE_DEBUG_FILE;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-walk-log-"));
    process.env.PROTOCOL_GATE_LOG_DIR = protocolLogDir;
    logPath = join(protocolLogDir, "protocol-gate.log");
    debugSentinel = join(tempRoot, "no-debug-sentinel");
    process.env.PROTOCOL_GATE_DEBUG_FILE = debugSentinel;
    delete process.env.PROTOCOL_GATE_DEBUG;
  });

  afterAll(() => {
    if (priorKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorKnowledgeDir;
    if (priorStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
    else process.env.PROTOCOL_GATE_STATE_DIR = priorStateDir;
    if (priorLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = priorLogDir;
    if (priorDebugFile === undefined) delete process.env.PROTOCOL_GATE_DEBUG_FILE;
    else process.env.PROTOCOL_GATE_DEBUG_FILE = priorDebugFile;
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
    process.env.PROTOCOL_GATE_LOG_DIR = protocolLogDir;
    process.env.PROTOCOL_GATE_DEBUG_FILE = debugSentinel;
    delete process.env.PROTOCOL_GATE_DEBUG;
    hooks = await pluginModule.server({}, {});
  });

  function createKD(filename, content = "test content") {
    writeFileSync(join(knowledgeDir, filename), content);
  }

  function clearLog() {
    try { rmSync(logPath, { force: true }); } catch (_) {}
  }

  function records(token) {
    let log;
    try { log = readFileSync(logPath, "utf8"); } catch (_) { return []; }
    const marker = `] [protocol-gate] ${token}:`;
    return log.split("\n").filter((line) => line.includes(marker));
  }

  function parseRecord(line) {
    const marker = "] [protocol-gate] ";
    const body = line.slice(line.indexOf(marker) + marker.length);
    const colonAt = body.indexOf(":");
    const token = body.slice(0, colonAt);
    const rest = body.slice(colonAt + 2);
    const causeAt = rest.indexOf(" cause=");
    const head = causeAt === -1 ? rest : rest.slice(0, causeAt);
    const cause = causeAt === -1 ? null : rest.slice(causeAt + " cause=".length);
    const fields = {};
    for (const pair of head.split(" ").filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return { token, fields, cause };
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

  function reviewKD(verdict, citation) {
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

### F001: defect

- **Milestone citation**: ${citation}
- **Status**: ${verdict}
`;
  }

  async function initOverseer(s) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
  }

  // skill is allowlisted in every phase with no handler side effects, so its
  // calls purely re-evaluate lifecycle state against KD evidence on disk.
  async function tick(s, callID) {
    await hooks["tool.execute.before"]({ tool: "skill", sessionID: s, callID }, { args: {} });
  }

  it("refusal names the actual phase", async () => {
    // REPORT (12): the refusal names REPORT and never INTENT.
    const s = "obs-t15-report";
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    clearLog();

    expect(hooks.getEnablementState().enabled, "the debug channel is on — the record below proves nothing").toBe(false);

    let atReport = null;
    try {
      await hooks["tool.execute.before"](
        { tool: "subagent", sessionID: s, callID: "t15-report" },
        { args: { subagent_type: "committer", prompt: "AGENT: committer\nMODE: cleanup" } }
      );
    } catch (e) {
      atReport = e;
    }
    expect(atReport, "the dispatch ran instead of being refused at REPORT").toBeTruthy();
    expect(atReport.message).toContain("REPORT (12)");
    expect(atReport.message).not.toContain("INTENT");
    expect(atReport.message).toContain("REPORT is the terminal phase");
    // Falsifiable form: no other phase's name-and-number pair appears.
    for (const [name, number] of Object.entries(hooks.STATES)) {
      if (name === "REPORT") continue;
      expect(atReport.message, `the refusal at REPORT also names ${name} (${number})`).not.toContain(`${name} (${number})`);
    }
    const refused = records("DISPATCH_REFUSED");
    expect(refused, "the refusal left no always-on record").toHaveLength(1);
    expect(parseRecord(refused[0]).fields.phase).toBe("REPORT");
    expect(parseRecord(refused[0]).fields.number).toBe("12");

    // INTENT (1): the refusal names INTENT, and no phase the lifecycle is not in.
    const s1 = "obs-t15-intent";
    await initOverseer(s1);
    hooks.sessionPhaseMap.set(s1, hooks.STATES.INTENT);
    hooks.sessionPhaseMap.set(`${s1}:sid`, s1);
    let atIntent = null;
    try {
      await hooks["tool.execute.before"](
        { tool: "subagent", sessionID: s1, callID: "t15-intent" },
        { args: { subagent_type: "committer", prompt: "AGENT: committer\nMODE: preflight" } }
      );
    } catch (e) {
      atIntent = e;
    }
    expect(atIntent, "the dispatch ran instead of being refused at INTENT").toBeTruthy();
    expect(atIntent.message).toContain("INTENT (1)");
    expect(atIntent.message).not.toContain("REPORT");
    for (const [name, number] of Object.entries(hooks.STATES)) {
      if (name === "INTENT") continue;
      expect(atIntent.message, `the refusal at INTENT also names ${name} (${number})`).not.toContain(`${name} (${number})`);
    }
  });

  it("existing walk mutations are always-on", async () => {
    const s = "obs-t16-walk";
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M6", "in-progress"]]));
    clearLog();

    expect(hooks.getEnablementState().enabled, "the debug channel is on — the records below prove nothing").toBe(false);

    // Commit: one WALK_COMMIT naming session, from, to and the committed queue.
    const out = { parts: [] };
    await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "{3,4,5}" }, out);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    const commit = records("WALK_COMMIT");
    expect(commit, "no always-on WALK_COMMIT record").toHaveLength(1);
    expect(parseRecord(commit[0]).fields).toMatchObject({ session: s, from: "7", to: "3", queue: "[3,4,5]" });

    // No fresh evidence: repeated evaluations emit nothing further.
    await tick(s, "t16-hold-1");
    await tick(s, "t16-hold-2");
    expect(records("WALK_COMMIT")).toHaveLength(1);
    expect(records("WALK_HOP")).toHaveLength(0);

    // Hop: fresh exploration evidence consumes the head and re-arms the queue.
    createKD(`exploration-fresh-${s}.md`);
    await tick(s, "t16-hop-1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INVESTIGATE);
    expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`).phases).toEqual([4, 5]);
    const hop = records("WALK_HOP");
    expect(hop, "no always-on WALK_HOP record").toHaveLength(1);
    expect(parseRecord(hop[0]).fields).toMatchObject({ from: "3", to: "4", queue: "[4,5]" });

    // A repeated evaluation at the new head emits no further hop line.
    await tick(s, "t16-hop-2");
    await tick(s, "t16-hop-3");
    expect(records("WALK_HOP")).toHaveLength(1);

    // Backward clear: the marker is dropped by the regression and the record
    // says why.
    const b = "obs-t16-backward";
    await initOverseer(b);
    hooks.sessionPhaseMap.set(b, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${b}:sid`, b);
    createKD(`milestones-feature-${b}.md`, registryContent([["M1", "checked-off"]]));
    createKD(`impl-M1-seed-${b}-gen0.md`, "impl evidence");
    const outB = { parts: [] };
    await hooks["command.execute.before"]({ command: "phase", sessionID: b, arguments: "{8,10}" }, outB);
    expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.VERIFY);
    expect(hooks.sessionPhaseMap.get(`${b}:overrideUntil`).phases).toEqual([8, 10]);

    createKD(`review-fail-${b}.md`, reviewKD("FAIL", "M1"));
    await tick(b, "t16-backward-1");
    expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.SWARM);
    expect(hooks.sessionPhaseMap.has(`${b}:overrideUntil`)).toBe(false);
    const cleared = records("WALK_CLEARED").filter((line) => line.includes(`session=${b}`));
    expect(cleared, "no always-on WALK_CLEARED record for the backward transition").toHaveLength(1);
    const clearedRecord = parseRecord(cleared[0]);
    expect(clearedRecord.fields.reason).toBe("backward-pin");
    expect(clearedRecord.fields.from).toBe("8");
    expect(clearedRecord.fields.to).toBe("7");
    expect(clearedRecord.fields.queue).toBe("[8,10]");
  });
});
